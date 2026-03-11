# -*- coding: utf-8 -*-
"""
Structural Agent
================
Measures structural / architectural drift by comparing dependency graphs,
coupling metrics and module-level complexity.

Dimensions scored
-----------------
import_drift        : Jaccard distance between import sets
coupling_drift      : change in fan-in / fan-out ratio
depth_drift         : change in average inheritance depth
complexity_drift    : change in mean McCabe cyclomatic complexity
                      (uses pre-computed values from ParserAgent)

Score formula:
    structural_drift = 0.30·import_drift + 0.25·coupling_drift
                       + 0.20·depth_drift + 0.25·complexity_drift
"""
from __future__ import annotations

import ast
from typing import Any

from .base_agent import AgentBase, AgentResult


# ---------------------------------------------------------------------------
# Import Jaccard distance
# ---------------------------------------------------------------------------

def _import_jaccard_dist(imps_a: list[str], imps_b: list[str]) -> float:
    set_a, set_b = set(imps_a), set(imps_b)
    if not set_a and not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return 1.0 - intersection / union


# ---------------------------------------------------------------------------
# Fan-out (efferent coupling) estimate from import count
# ---------------------------------------------------------------------------

def _fan_out(imports: list[str]) -> int:
    # Count distinct top-level packages
    return len({imp.split(".")[0] for imp in imports})


# ---------------------------------------------------------------------------
# Inheritance depth per class (supports cross-file resolution)
# ---------------------------------------------------------------------------

def _build_class_bases_map(source: str) -> dict[str, list[str]]:
    """Return {class_name: [base_class_names]} from a single source file."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {}
    result: dict[str, list[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            bases = [
                base.id if isinstance(base, ast.Name) else ""
                for base in node.bases
            ]
            result[node.name] = [b for b in bases if b]
    return result


def _inheritance_depths(
    source: str,
    project_class_bases: dict[str, list[str]] | None = None,
) -> list[int]:
    """Compute inheritance depth for each class in *source*.

    Depth = longest chain from the class to a root with no known bases.

    Parameters
    ----------
    source : str
        The source code of the file being analysed.
    project_class_bases : dict | None
        Optional cross-file class-to-bases map built from all project files.
        When provided, inheritance chains that cross file boundaries are
        resolved correctly.  When *None*, only in-module chains are resolved
        (original behaviour).
    """
    local_map = _build_class_bases_map(source)
    if not local_map:
        return [0]

    # Merge: project-wide map + local overrides (local file wins for same name)
    all_bases: dict[str, list[str]] = {}
    if project_class_bases:
        all_bases.update(project_class_bases)
    all_bases.update(local_map)  # local definitions take precedence

    all_known = set(all_bases.keys())

    def _depth(name: str, seen: set[str]) -> int:
        if name in seen or name not in all_bases:
            return 0
        seen.add(name)
        resolvable = [b for b in all_bases[name] if b in all_known]
        if not resolvable:
            return 1  # root class (bases are external or empty)
        return 1 + max(_depth(b, set(seen)) for b in resolvable)

    return [_depth(name, set()) for name in local_map] or [0]


# ---------------------------------------------------------------------------
# Structural Agent
# ---------------------------------------------------------------------------

class StructuralAgent(AgentBase):
    """Detect coupling and complexity drift in a Python source snapshot."""

    WEIGHTS = {
        "import": 0.30,
        "coupling": 0.25,
        "depth": 0.20,
        "complexity": 0.25,
    }

    @property
    def name(self) -> str:
        return "StructuralAgent"

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        # Imports ---------------------------------------------------------
        imps_now = snapshot.get("imports", [])
        imps_base = baseline.get("imports", [])
        import_drift = _import_jaccard_dist(imps_now, imps_base)

        # Coupling (fan-out) ----------------------------------------------
        fo_now = _fan_out(imps_now)
        fo_base = _fan_out(imps_base)
        coupling_drift = self.clamp(abs(fo_now - fo_base) / max(fo_base, 1))

        # Inheritance depth -----------------------------------------------
        src_now = snapshot.get("source", "")
        src_base = baseline.get("source", "")
        project_class_bases = snapshot.get("project_class_bases")
        depths_now = _inheritance_depths(src_now, project_class_bases)
        depths_base = _inheritance_depths(src_base, project_class_bases)
        avg_depth_now = sum(depths_now) / len(depths_now) if depths_now else 0.0
        avg_depth_base = sum(depths_base) / len(depths_base) if depths_base else 0.0
        depth_drift = self.clamp(abs(avg_depth_now - avg_depth_base) / max(avg_depth_base, 1))

        # Cyclomatic complexity -------------------------------------------
        cc_now = snapshot.get("cyclomatic_avg", 0.0)
        cc_base = baseline.get("cyclomatic_avg", 0.0)
        complexity_drift = self.clamp(abs(cc_now - cc_base) / max(cc_base, 1))

        # Weighted score --------------------------------------------------
        score = self.clamp(
            self.WEIGHTS["import"] * import_drift
            + self.WEIGHTS["coupling"] * coupling_drift
            + self.WEIGHTS["depth"] * depth_drift
            + self.WEIGHTS["complexity"] * complexity_drift
        )

        evidence: list[str] = []
        added = set(imps_now) - set(imps_base)
        removed = set(imps_base) - set(imps_now)
        if added:
            evidence.append(f"New imports: {', '.join(sorted(added)[:5])}")
        if removed:
            evidence.append(f"Removed imports: {', '.join(sorted(removed)[:5])}")
        if coupling_drift > 0.2:
            evidence.append(
                f"Fan-out changed: {fo_base} → {fo_now} "
                f"({fo_now - fo_base:+d} external packages)"
            )
        if complexity_drift > 0.2:
            evidence.append(
                f"Cyclomatic complexity changed: {cc_base:.2f} → {cc_now:.2f}"
            )

        return AgentResult(
            agent_name=self.name,
            score=score,
            details={
                "import_drift": import_drift,
                "coupling_drift": coupling_drift,
                "depth_drift": depth_drift,
                "complexity_drift": complexity_drift,
                "fan_out_now": fo_now,
                "fan_out_base": fo_base,
                "imports_added": list(added),
                "imports_removed": list(removed),
            },
            evidence=evidence,
        )
