# -*- coding: utf-8 -*-
"""
Duplication Agent
=================
Detects copy-paste / structural code duplication.

Algorithm (CPD-inspired, pure-Python)
--------------------------------------
1. Normalise each function body by replacing variable names and string
   literals with placeholder tokens, producing "canonical token sequences".
2. Build a suffix-array of all sequences and find matching n-grams of
   length ≥ min_token_window (default: 50 tokens).
3. Report the fraction of code lines covered by duplicate blocks.

Dimensions scored
-----------------
dup_fraction    : Fraction of lines that appear in a duplicate block.
clone_pair_count: Number of distinct duplicate pairs found.

Final duplication_risk = min(dup_fraction / HIGH_DUP_THRESHOLD, 1.0)
where HIGH_DUP_THRESHOLD = 0.15  (>15 % duplication = score 1.0)
"""
from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass
from typing import Any

from .base_agent import AgentBase, AgentResult

# Lines-duplication fraction that maps to a maximum score of 1.0
HIGH_DUP_THRESHOLD = 0.20
MIN_TOKENS = 40  # minimum token sequence length to flag as duplicate


# ---------------------------------------------------------------------------
# Normalise a function body into a canonical token list
# ---------------------------------------------------------------------------

def _canonical_tokens(func_node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    """Replace names and literals with typed placeholders.

    This makes structurally identical code with renamed variables compare
    as equal (Type-1 / Type-2 clone detection).
    """
    tokens: list[str] = []
    var_map: dict[str, str] = {}
    counter = {"n": 0}

    def placeholder(name: str) -> str:
        if name not in var_map:
            counter["n"] += 1
            var_map[name] = f"VAR{counter['n']}"
        return var_map[name]

    for node in ast.walk(func_node):
        t = type(node).__name__
        if isinstance(node, ast.Name):
            tokens.append(f"NAME:{placeholder(node.id)}")
        elif isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                tokens.append("STR:_")
            elif isinstance(node.value, (int, float)):
                tokens.append("NUM:_")
            else:
                tokens.append(f"CONST:{node.value}")
        elif isinstance(node, ast.arg):
            tokens.append(f"ARG:{placeholder(node.arg)}")
        else:
            tokens.append(t)
    return tokens


# ---------------------------------------------------------------------------
# Duplicate detection
# ---------------------------------------------------------------------------

@dataclass
class ClonePair:
    func_a: str
    func_b: str
    similar_tokens: int
    similarity: float  # 0..1


def _detect_clones(functions: list[tuple[str, list[str]]]) -> list[ClonePair]:
    """Compare every pair of functions for token sequence similarity."""
    pairs: list[ClonePair] = []
    for i in range(len(functions)):
        for j in range(i + 1, len(functions)):
            name_a, toks_a = functions[i]
            name_b, toks_b = functions[j]
            if len(toks_a) < MIN_TOKENS or len(toks_b) < MIN_TOKENS:
                continue
            sim = _token_sequence_similarity(toks_a, toks_b)
            common_len = int(sim * min(len(toks_a), len(toks_b)))
            if sim >= 0.80:
                pairs.append(ClonePair(name_a, name_b, common_len, sim))
    return pairs


def _token_sequence_similarity(a: list[str], b: list[str]) -> float:
    """Normalised LCS-based similarity (Sørensen–Dice via hashed windows)."""
    if not a or not b:
        return 0.0
    # Build hash-set of windows of size WIN from each sequence
    WIN = min(MIN_TOKENS // 2, len(a), len(b))
    if WIN < 2:
        return 0.0

    def windows(seq: list[str]) -> set[str]:
        return {
            hashlib.md5("".join(seq[i:i + WIN]).encode()).hexdigest()
            for i in range(len(seq) - WIN + 1)
        }

    w_a = windows(a)
    w_b = windows(b)
    if not w_a or not w_b:
        return 0.0
    return 2 * len(w_a & w_b) / (len(w_a) + len(w_b))


# ---------------------------------------------------------------------------
# Duplication Agent
# ---------------------------------------------------------------------------

class DuplicationAgent(AgentBase):
    """Detect structural code clones across a Python source file."""

    @property
    def name(self) -> str:
        return "DuplicationAgent"

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        source = snapshot.get("source", "")
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return AgentResult(
                agent_name=self.name, score=0.0,
                evidence=["Syntax error — skipping duplication check"]
            )

        # Collect function bodies ----------------------------------------
        functions: list[tuple[str, list[str]]] = []
        total_func_lines = 0
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                end = getattr(node, "end_lineno", node.lineno)
                func_lines = end - node.lineno + 1
                total_func_lines += func_lines
                tokens = _canonical_tokens(node)
                functions.append((node.name, tokens))

        if len(functions) < 2:
            return AgentResult(
                agent_name=self.name, score=0.0,
                details={"clone_pairs": 0, "dup_fraction": 0.0},
                evidence=["Too few functions to detect duplication"],
            )

        # Detect clones --------------------------------------------------
        clones = _detect_clones(functions)

        # Estimate duplicated line fraction
        dup_func_lines = sum(
            min(len(f[1]), len(g[1]))  # approximate via token count proxy
            for f, g in [
                (
                    next(x for x in functions if x[0] == cp.func_a),
                    next(x for x in functions if x[0] == cp.func_b),
                )
                for cp in clones
            ]
        )
        loc_total = len([l for l in source.splitlines() if l.strip()])
        dup_fraction = min(dup_func_lines / max(loc_total, 1), 1.0)

        score = self.clamp(dup_fraction / HIGH_DUP_THRESHOLD)

        evidence: list[str] = []
        if clones:
            evidence.append(
                f"Detected {len(clones)} clone pair(s) with ≥80% token similarity"
            )
            for cp in clones[:3]:
                evidence.append(
                    f"  {cp.func_a} ↔ {cp.func_b}  similarity={cp.similarity:.0%}"
                )
        if dup_fraction > 0.05:
            evidence.append(
                f"Estimated duplicated code: {dup_fraction:.1%} of file"
            )

        return AgentResult(
            agent_name=self.name,
            score=score,
            details={
                "clone_pair_count": len(clones),
                "dup_fraction": round(dup_fraction, 4),
                "clone_pairs": [
                    {
                        "func_a": cp.func_a,
                        "func_b": cp.func_b,
                        "similarity": round(cp.similarity, 3),
                    }
                    for cp in clones
                ],
            },
            evidence=evidence,
        )
