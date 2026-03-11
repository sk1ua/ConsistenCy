# -*- coding: utf-8 -*-
"""
Style Agent
===========
Measures stylistic drift in a commit relative to the project baseline.

Dimensions scored
-----------------
naming_drift    : cosine distance between naming-style feature vectors
                  (snake_case ratio, camelCase ratio, ALL_CAPS ratio,
                   short-name ratio, avg identifier length)
doc_drift       : change in docstring / function ratio
format_drift    : change in line-length distribution (mean, p95)
comment_drift   : change in comment density (comments / code lines)

Final style_drift score = weighted mean of the four sub-scores.
"""
from __future__ import annotations

import ast
import math
import re
from typing import Any

from .base_agent import AgentBase, AgentResult

# ---------------------------------------------------------------------------
# Naming style helpers
# ---------------------------------------------------------------------------

_RE_SNAKE = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
_RE_CAMEL = re.compile(r"^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$")
_RE_PASCAL = re.compile(r"^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)*$")
_RE_ALLCAP = re.compile(r"^[A-Z][A-Z0-9_]+$")


def _identifier_features(source: str) -> dict[str, float]:
    """Extract a naming-style feature vector from Python source text."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {}

    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.append(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.arg):
            names.append(node.arg)

    if not names:
        return {}

    n = len(names)
    snake = sum(1 for x in names if _RE_SNAKE.match(x)) / n
    camel = sum(1 for x in names if _RE_CAMEL.match(x)) / n
    pascal = sum(1 for x in names if _RE_PASCAL.match(x)) / n
    allcap = sum(1 for x in names if _RE_ALLCAP.match(x)) / n
    short = sum(1 for x in names if len(x) <= 2) / n  # single-letter or 2-char
    avg_len = sum(len(x) for x in names) / n

    return {
        "snake": snake,
        "camel": camel,
        "pascal": pascal,
        "allcap": allcap,
        "short": short,
        "avg_len": min(avg_len / 20.0, 1.0),  # normalise to ~[0,1]
    }


def _cosine_distance(a: dict[str, float], b: dict[str, float]) -> float:
    """Cosine distance in [0, 1] between two feature dicts."""
    keys = set(a) | set(b)
    if not keys:
        return 0.0
    va = [a.get(k, 0.0) for k in keys]
    vb = [b.get(k, 0.0) for k in keys]
    dot = sum(x * y for x, y in zip(va, vb))
    mag_a = math.sqrt(sum(x * x for x in va))
    mag_b = math.sqrt(sum(x * x for x in vb))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    cosine_sim = dot / (mag_a * mag_b)
    return 1.0 - max(0.0, min(1.0, cosine_sim))


# ---------------------------------------------------------------------------
# Docstring coverage
# ---------------------------------------------------------------------------

def _docstring_ratio(source: str) -> float:
    """Fraction of functions / classes that have a docstring."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return 0.0

    total = 0
    with_doc = 0
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            total += 1
            if (
                node.body
                and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, ast.Constant)
                and isinstance(node.body[0].value.value, str)
            ):
                with_doc += 1
    return with_doc / total if total else 0.0


# ---------------------------------------------------------------------------
# Line-length features
# ---------------------------------------------------------------------------

def _line_length_features(source: str) -> dict[str, float]:
    lengths = [len(line) for line in source.splitlines() if line.strip()]
    if not lengths:
        return {"mean": 0.0, "p95": 0.0}
    lengths.sort()
    mean = sum(lengths) / len(lengths)
    p95_idx = max(0, int(0.95 * len(lengths)) - 1)
    p95 = lengths[p95_idx]
    return {"mean": mean / 120.0, "p95": p95 / 120.0}  # normalised


# ---------------------------------------------------------------------------
# Comment density
# ---------------------------------------------------------------------------

def _comment_density(source: str) -> float:
    lines = source.splitlines()
    code = comments = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            comments += 1
        else:
            code += 1
    return comments / (code + 1)


# ---------------------------------------------------------------------------
# Style Agent
# ---------------------------------------------------------------------------

class StyleAgent(AgentBase):
    """Measure stylistic drift across naming, formatting and documentation."""

    WEIGHTS = {
        "naming": 0.40,
        "doc": 0.25,
        "format": 0.20,
        "comment": 0.15,
    }

    @property
    def name(self) -> str:
        return "StyleAgent"

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        source_now = snapshot.get("source", "")
        source_base = baseline.get("source", "")

        # --- naming drift ---
        feat_now = _identifier_features(source_now)
        feat_base = _identifier_features(source_base)
        naming_drift = _cosine_distance(feat_now, feat_base)

        # --- docstring drift ---
        doc_now = _docstring_ratio(source_now)
        doc_base = _docstring_ratio(source_base)
        doc_drift = abs(doc_now - doc_base)

        # --- format drift (line length) ---
        fmt_now = _line_length_features(source_now)
        fmt_base = _line_length_features(source_base)
        format_drift = _cosine_distance(fmt_now, fmt_base)

        # --- comment density drift ---
        cmt_now = _comment_density(source_now)
        cmt_base = _comment_density(source_base)
        comment_drift = self.clamp(abs(cmt_now - cmt_base) * 4)  # scale: 0.25 diff → 1.0

        # Weighted aggregate
        score = self.clamp(
            self.WEIGHTS["naming"] * naming_drift
            + self.WEIGHTS["doc"] * doc_drift
            + self.WEIGHTS["format"] * format_drift
            + self.WEIGHTS["comment"] * comment_drift
        )

        evidence: list[str] = []
        if naming_drift > 0.1:
            evidence.append(
                f"Naming style diverged (cosine dist={naming_drift:.3f}). "
                f"snake_case: {feat_base.get('snake', 0):.0%} → {feat_now.get('snake', 0):.0%}"
            )
        if doc_drift > 0.15:
            direction = "dropped" if doc_now < doc_base else "increased"
            evidence.append(
                f"Docstring coverage {direction}: {doc_base:.0%} → {doc_now:.0%}"
            )
        if format_drift > 0.1:
            evidence.append(
                f"Line-length distribution shifted (dist={format_drift:.3f})"
            )
        if comment_drift > 0.2:
            evidence.append(
                f"Comment density changed: {cmt_base:.2f} → {cmt_now:.2f} comments/code-line"
            )

        return AgentResult(
            agent_name=self.name,
            score=score,
            details={
                "naming_drift": naming_drift,
                "doc_drift": doc_drift,
                "format_drift": format_drift,
                "comment_drift": comment_drift,
                "naming_features_now": feat_now,
                "naming_features_base": feat_base,
                "docstring_ratio_now": doc_now,
                "docstring_ratio_base": doc_base,
            },
            evidence=evidence,
        )
