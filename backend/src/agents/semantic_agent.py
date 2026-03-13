# -*- coding: utf-8 -*-
"""
Semantic Agent
==============
Measures drift in program *semantics* — what the code *does* — rather
than how it looks.

Dimensions scored
-----------------
ast_edit_distance   : Normalised tree-edit distance between AST
                      representations (Zhang-Shasha approximation
                      via subtree hash fingerprinting, O(n)).
api_usage_drift     : Jaccard distance between called function names.
control_flow_drift  : Change in branching-statement profile
                      (if/for/while/try distributions).

Score formula:
    semantic_drift = 0.45·ast_edit_distance
                   + 0.30·api_usage_drift
                   + 0.25·control_flow_drift
"""
from __future__ import annotations

import ast
import hashlib
from collections import Counter
from typing import Any

from .base_agent import AgentBase, AgentResult


# ---------------------------------------------------------------------------
# Subtree hash fingerprinting (true tree-edit distance approximation)
# ---------------------------------------------------------------------------

def _subtree_fingerprints(tree: ast.AST) -> set[str]:
    """Compute an MD5 hash for every subtree, bottom-up.

    Each unique subtree structure+leaf-values maps to one hash.  The
    resulting set is used for Jaccard-based structural comparison:
    identical subtrees shared between two trees cancel out, leaving
    only the differing portions.

    Compared to flat n-gram sequences this preserves nesting structure
    so a change deep inside a loop is not diluted by unchanged outer
    context.
    """
    fingerprints: set[str] = set()

    def _hash(node: ast.AST) -> str:
        child_hashes = sorted(_hash(c) for c in ast.iter_child_nodes(node))
        if isinstance(node, ast.Name):
            parts = f"Name:{node.id}|{','.join(child_hashes)}"
        elif isinstance(node, ast.Constant):
            parts = f"Const:{type(node.value).__name__}:{node.value}|"
        elif isinstance(node, ast.arg):
            parts = f"arg:{node.arg}|{','.join(child_hashes)}"
        else:
            parts = f"{type(node).__name__}|{','.join(child_hashes)}"
        h = hashlib.md5(parts.encode()).hexdigest()
        fingerprints.add(h)
        return h

    _hash(tree)
    return fingerprints


def _subtree_edit_distance(tree_a: ast.AST, tree_b: ast.AST) -> float:
    """Jaccard distance on subtree fingerprint sets.

    Returns 0.0 for identical trees and ≈1.0 for completely different
    trees.  This is an O(n) approximation of Zhang-Shasha tree-edit
    distance.
    """
    fps_a = _subtree_fingerprints(tree_a)
    fps_b = _subtree_fingerprints(tree_b)
    if not fps_a and not fps_b:
        return 0.0
    union = len(fps_a | fps_b)
    return 1.0 - len(fps_a & fps_b) / union if union > 0 else 0.0


def _node_type_sequence(tree: ast.AST) -> list[str]:
    """Linearise the AST into a depth-first list of node type names (kept for compatibility)."""
    return [type(node).__name__ for node in ast.walk(tree)]


# ---------------------------------------------------------------------------
# API usage (called function / method names)
# ---------------------------------------------------------------------------

def _called_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                names.add(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                names.add(node.func.attr)
    return names


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return 1.0 - len(a & b) / len(a | b)


# ---------------------------------------------------------------------------
# Control flow profile
# ---------------------------------------------------------------------------

_CF_NODES = (ast.If, ast.For, ast.While, ast.Try, ast.ExceptHandler,
             ast.With, ast.AsyncWith, ast.AsyncFor)


def _control_flow_profile(tree: ast.AST) -> dict[str, int]:
    counts: dict[str, int] = {}
    for node in ast.walk(tree):
        if isinstance(node, _CF_NODES):
            key = type(node).__name__
            counts[key] = counts.get(key, 0) + 1
    return counts


def _profile_distance(p_a: dict[str, int], p_b: dict[str, int]) -> float:
    all_keys = set(p_a) | set(p_b)
    if not all_keys:
        return 0.0
    total_a = sum(p_a.values()) or 1
    total_b = sum(p_b.values()) or 1
    dist = sum(
        abs(p_a.get(k, 0) / total_a - p_b.get(k, 0) / total_b)
        for k in all_keys
    ) / len(all_keys)
    return min(dist * 2, 1.0)  # scale: avg diff of 0.5 → 1.0


# ---------------------------------------------------------------------------
# Semantic Agent
# ---------------------------------------------------------------------------

class SemanticAgent(AgentBase):
    """Detect logical / semantic drift between two code versions."""

    WEIGHTS = {"ast": 0.45, "api": 0.30, "cf": 0.25}

    @property
    def name(self) -> str:
        return "SemanticAgent"

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        # Parse trees ---------------------------------------------------
        src_now = snapshot.get("source", "")
        src_base = baseline.get("source", "")

        try:
            tree_now = snapshot.get("ast_tree") or ast.parse(src_now)
        except SyntaxError:
            tree_now = ast.parse("")  # empty module

        try:
            tree_base = baseline.get("ast_tree") or ast.parse(src_base)
        except SyntaxError:
            tree_base = ast.parse("")

        # AST subtree-fingerprint distance (tree-edit approximation) ------
        ast_dist = _subtree_edit_distance(tree_now, tree_base)

        # API usage drift -----------------------------------------------
        api_now = _called_names(tree_now)
        api_base = _called_names(tree_base)
        api_drift = _jaccard(api_now, api_base)

        # Control flow profile drift ------------------------------------
        cf_now = _control_flow_profile(tree_now)
        cf_base = _control_flow_profile(tree_base)
        cf_drift = _profile_distance(cf_now, cf_base)

        # Weighted score ------------------------------------------------
        score = self.clamp(
            self.WEIGHTS["ast"] * ast_dist
            + self.WEIGHTS["api"] * api_drift
            + self.WEIGHTS["cf"] * cf_drift
        )

        # Evidence strings ----------------------------------------------
        evidence: list[str] = []
        if ast_dist > 0.15:
            evidence.append(
                f"AST structure diverged significantly (subtree edit dist={ast_dist:.3f})"
            )
        added_api = api_now - api_base
        removed_api = api_base - api_now
        if added_api:
            evidence.append(f"New API calls introduced: {', '.join(sorted(added_api)[:5])}")
        if removed_api:
            evidence.append(f"API calls removed: {', '.join(sorted(removed_api)[:5])}")
        if cf_drift > 0.2:
            evidence.append(
                f"Control flow profile shifted (dist={cf_drift:.3f}). "
                f"Snapshot: {cf_now}, Baseline: {cf_base}"
            )

        return AgentResult(
            agent_name=self.name,
            score=score,
            details={
                "ast_distance": ast_dist,
                "api_drift": api_drift,
                "cf_drift": cf_drift,
                "api_added": list(added_api),
                "api_removed": list(removed_api),
                "cf_profile_now": cf_now,
                "cf_profile_base": cf_base,
            },
            evidence=evidence,
        )
