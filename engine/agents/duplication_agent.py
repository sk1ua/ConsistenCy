# -*- coding: utf-8 -*-
"""
Duplication Agent
=================
Detects copy-paste / structural code duplication.

Algorithm (rolling-hash fingerprinting)
-----------------------------------------
1. Normalise each function body by replacing variable names and string
   literals with placeholder tokens, producing "canonical token sequences".
2. Build an inverted index:  window_hash → {(file, func), ...}  using a
   sliding window of MIN_TOKENS over every function's token sequence.
   Any window hash that appears in two or more distinct functions is a
   shared code fragment (Type-1/2 clone).
3. Count shared windows per function-pair and compute Sørensen-Dice
   similarity.  Pairs with similarity ≥ 0.80 are clones.

Compared to the previous O(n²) pairwise approach:
    - Building the index is near-linear in the number of token windows
        (rolling polynomial hash with fixed window size).
  - Shared-window counting is O(n) for typical code (most windows are
    unique); worst-case is O(n²) only if all functions are identical.
  - Natural extension to **cross-file clone detection**: functions from
    other project files are included in the same index.

Cross-file support
------------------
If ``snapshot["project_sources"]`` is a ``dict[str, str]`` mapping
file-paths to source code, functions from those files are added to the
detection pool.  The risk score is derived only from clones that involve
at least one function in the *primary* file being analysed.

Dimensions scored
-----------------
dup_fraction    : Fraction of primary-file code lines in a clone block.
clone_pair_count: Number of distinct clone pairs (intra + cross-file).

Final duplication_risk = min(dup_fraction / HIGH_DUP_THRESHOLD, 1.0)
where HIGH_DUP_THRESHOLD = 0.20  (≥20 % duplication → score 1.0)
"""
from __future__ import annotations

import ast
import hashlib
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from .base_agent import AgentBase, AgentResult

# Lines-duplication fraction that maps to a maximum score of 1.0
HIGH_DUP_THRESHOLD = 0.20
MIN_TOKENS = 40  # minimum token sequence length to flag as duplicate

# Sentinel used to separate source files in cross-file analysis
_PRIMARY_FILE = ""  # primary file has empty filename label


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
# Function extraction
# ---------------------------------------------------------------------------

def _extract_functions(
    source: str,
    filename: str = _PRIMARY_FILE,
) -> list[tuple[str, str, int, list[str]]]:
    """Return (filename, funcname, lineno, canonical_tokens) for each function."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    result: list[tuple[str, str, int, list[str]]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            result.append((
                filename,
                node.name,
                int(getattr(node, "lineno", 0)),
                _canonical_tokens(node),
            ))
    return result


def _func_label(filename: str, funcname: str, lineno: int) -> str:
    """Return a stable label for one function (with line disambiguator)."""
    core = f"{funcname}@L{lineno}"
    return f"{filename}:{core}" if filename else core


# ---------------------------------------------------------------------------
# Clone detection via rolling-hash inverted index
# ---------------------------------------------------------------------------

@dataclass
class ClonePair:
    func_a: str
    func_b: str
    similar_tokens: int
    similarity: float  # 0..1


def _rolling_hash_clones(
    all_functions: list[tuple[str, str, int, list[str]]],
    min_tokens: int = MIN_TOKENS,
    threshold: float = 0.80,
) -> list[ClonePair]:
    """Detect clone pairs using rolling-window fingerprinting.

    Builds a window_hash → {(file, func, lineno)} inverted index in O(Σ tokens)
    time, then counts shared windows per pair to compute similarity.
    """
    # Build inverted index: window_hash → set of (file, func, lineno) keys
    window_index: dict[int, set[tuple[str, str, int]]] = defaultdict(set)
    func_window_count: dict[tuple[str, str, int], int] = {}

    base = 1_000_003
    mod = (1 << 64) - 59

    def _token_to_int(token: str) -> int:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        return int.from_bytes(digest, "little") % mod

    for filename, funcname, lineno, tokens in all_functions:
        if len(tokens) < min_tokens:
            continue
        key = (filename, funcname, lineno)
        n_windows = len(tokens) - min_tokens + 1
        func_window_count[key] = n_windows

        token_vals = [_token_to_int(token) for token in tokens]
        power = pow(base, min_tokens - 1, mod)

        rolling_hash = 0
        for value in token_vals[:min_tokens]:
            rolling_hash = (rolling_hash * base + value) % mod
        window_index[rolling_hash].add(key)

        for idx in range(min_tokens, len(token_vals)):
            left = token_vals[idx - min_tokens]
            rolling_hash = (rolling_hash - (left * power) % mod) % mod
            rolling_hash = (rolling_hash * base + token_vals[idx]) % mod
            window_index[rolling_hash].add(key)

    # Count shared windows per pair of functions
    shared: dict[tuple[tuple[str, str, int], tuple[str, str, int]], int] = defaultdict(int)
    for funcs in window_index.values():
        if len(funcs) < 2:
            continue
        funcs_list = list(funcs)
        for i in range(len(funcs_list)):
            for j in range(i + 1, len(funcs_list)):
                pair = (
                    min(funcs_list[i], funcs_list[j]),
                    max(funcs_list[i], funcs_list[j]),
                )
                shared[pair] += 1

    # Build ClonePair list for pairs exceeding the similarity threshold
    clones: list[ClonePair] = []
    for (key_a, key_b), match_count in shared.items():
        total_a = func_window_count.get(key_a, 1)
        total_b = func_window_count.get(key_b, 1)
        similarity = 2 * match_count / (total_a + total_b)
        if similarity >= threshold:
            file_a, func_a, line_a = key_a
            file_b, func_b, line_b = key_b
            label_a = _func_label(file_a, func_a, line_a)
            label_b = _func_label(file_b, func_b, line_b)
            clones.append(ClonePair(
                func_a=label_a,
                func_b=label_b,
                similar_tokens=match_count,
                similarity=round(similarity, 4),
            ))

    return sorted(clones, key=lambda c: c.similarity, reverse=True)


# ---------------------------------------------------------------------------
# Duplication Agent
# ---------------------------------------------------------------------------

class DuplicationAgent(AgentBase):
    """Detect structural code clones within and across Python source files."""

    @property
    def name(self) -> str:
        return "DuplicationAgent"

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        source = snapshot.get("source", "")

        # Primary file functions
        primary_funcs = _extract_functions(source, _PRIMARY_FILE)

        # Cross-file functions (optional project-wide pool)
        project_sources: dict[str, str] = snapshot.get("project_sources", {})
        cross_funcs: list[tuple[str, str, int, list[str]]] = []
        for filepath, fsource in project_sources.items():
            cross_funcs.extend(_extract_functions(fsource, filepath))

        all_funcs = primary_funcs + cross_funcs
        primary_labels = {
            _func_label(_PRIMARY_FILE, funcname, lineno)
            for _, funcname, lineno, _ in primary_funcs
        }

        if len(all_funcs) < 2:
            return AgentResult(
                agent_name=self.name, score=0.0,
                details={"clone_pair_count": 0, "dup_fraction": 0.0},
                evidence=["Too few functions to detect duplication"],
            )

        # Detect clones
        clones = _rolling_hash_clones(all_funcs)

        # Score based on clones involving the primary file's functions
        primary_clones = [
            cp for cp in clones
            if cp.func_a in primary_labels or cp.func_b in primary_labels
        ]

        # Estimate duplicated line fraction for the primary file
        total_tokens_by_label = {
            _func_label(_PRIMARY_FILE, funcname, lineno): len(tokens)
            for _, funcname, lineno, tokens in primary_funcs
        }
        loc_total = len([ln for ln in source.splitlines() if ln.strip()])

        primary_involved_labels: set[str] = set()
        for clone_pair in primary_clones:
            if clone_pair.func_a in primary_labels:
                primary_involved_labels.add(clone_pair.func_a)
            if clone_pair.func_b in primary_labels:
                primary_involved_labels.add(clone_pair.func_b)

        duplicated_token_count = sum(
            total_tokens_by_label.get(label, 0)
            for label in primary_involved_labels
        )
        dup_fraction = min(
            duplicated_token_count / max(loc_total * 5, 1),  # ~5 tokens/line heuristic
            1.0,
        )
        score = self.clamp(dup_fraction / HIGH_DUP_THRESHOLD)

        cross_file_count = sum(
            1 for cp in clones
            if (":" in cp.func_a) != (":" in cp.func_b)  # one cross-file
        )

        evidence: list[str] = []
        if clones:
            msg = f"Detected {len(clones)} clone pair(s) with ≥80% token similarity"
            if cross_file_count:
                msg += f" ({cross_file_count} cross-file)"
            evidence.append(msg)
            for cp in clones[:3]:
                evidence.append(
                    f"  {cp.func_a} ↔ {cp.func_b}  similarity={cp.similarity:.0%}"
                )
        if dup_fraction > 0.05:
            evidence.append(
                f"Estimated duplicated code: {dup_fraction:.1%} of primary file"
            )

        return AgentResult(
            agent_name=self.name,
            score=score,
            details={
                "clone_pair_count": len(clones),
                "cross_file_clone_count": cross_file_count,
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

