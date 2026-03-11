# -*- coding: utf-8 -*-
"""
Parser Agent
============
Parses a Python source file into rich structural data that feeds every
downstream agent.

Outputs (snapshot dict keys)
-----------------------------
ast_tree            : ast.Module object
functions           : list of FunctionInfo namedtuples
classes             : list of ClassInfo namedtuples
imports             : list of import strings
tokens              : list of (token_type, string) pairs
halstead            : HalsteadMetrics dict
cyclomatic_avg      : mean cyclomatic complexity across all functions
loc                 : dict with total/code/comment/blank line counts
"""
from __future__ import annotations

import ast
import io
import math
import tokenize
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .base_agent import AgentBase, AgentResult

# ---------------------------------------------------------------------------
# Lightweight data containers produced by the parser
# ---------------------------------------------------------------------------

@dataclass
class FunctionInfo:
    name: str
    lineno: int
    end_lineno: int
    args: list[str]
    decorators: list[str]
    is_async: bool
    cyclomatic_complexity: int = 1


@dataclass
class ClassInfo:
    name: str
    lineno: int
    bases: list[str]
    methods: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Halstead metrics
# ---------------------------------------------------------------------------

def compute_halstead(tokens: list[tuple[int, str]]) -> dict[str, float]:
    """
    Compute Halstead software science metrics from a token stream.

    Operators  : keywords + operators + delimiters
    Operands   : names + number literals + string literals
    Returns a dict with keys: n1, n2, N1, N2, vocabulary, length,
    volume, difficulty, effort.
    """
    OPERATOR_TYPES = {tokenize.OP, tokenize.ERRORTOKEN}
    KEYWORD_TOKENS = {
        "if", "else", "elif", "while", "for", "return", "yield", "yield from",
        "and", "or", "not", "in", "is", "lambda", "def", "class", "import",
        "from", "as", "with", "try", "except", "finally", "raise", "pass",
        "break", "continue", "del", "assert", "global", "nonlocal",
    }
    operators: list[str] = []
    operands: list[str] = []

    for tok_type, tok_str, *_ in tokens:
        if tok_type == tokenize.COMMENT or tok_type == tokenize.ENCODING:
            continue
        if tok_type == tokenize.NAME:
            if tok_str in KEYWORD_TOKENS:
                operators.append(tok_str)
            else:
                operands.append(tok_str)
        elif tok_type in OPERATOR_TYPES:
            operators.append(tok_str)
        elif tok_type in (tokenize.NUMBER, tokenize.STRING):
            operands.append(tok_str)

    cnt_op = Counter(operators)
    cnt_opnd = Counter(operands)

    n1 = len(cnt_op)       # distinct operators
    n2 = len(cnt_opnd)     # distinct operands
    N1 = sum(cnt_op.values())   # total operators
    N2 = sum(cnt_opnd.values()) # total operands

    vocabulary = n1 + n2
    length = N1 + N2
    volume = length * math.log2(vocabulary) if vocabulary > 0 else 0.0
    difficulty = (n1 / 2) * (N2 / n2) if n2 > 0 else 0.0
    effort = difficulty * volume

    return {
        "n1": n1, "n2": n2, "N1": N1, "N2": N2,
        "vocabulary": vocabulary,
        "length": length,
        "volume": round(volume, 2),
        "difficulty": round(difficulty, 2),
        "effort": round(effort, 2),
    }


# ---------------------------------------------------------------------------
# Cyclomatic complexity
# ---------------------------------------------------------------------------

def _cyclomatic(node: ast.AST) -> int:
    """Count branch points for a single function/method node."""
    branch_nodes = (
        ast.If, ast.For, ast.While, ast.ExceptHandler,
        ast.With, ast.AsyncWith, ast.AsyncFor,
        ast.comprehension,
    )
    count = 1  # baseline
    for child in ast.walk(node):
        if isinstance(child, branch_nodes):
            count += 1
        elif isinstance(child, ast.BoolOp):
            count += len(child.values) - 1
    return count


# ---------------------------------------------------------------------------
# LOC counter
# ---------------------------------------------------------------------------

def count_loc(source: str) -> dict[str, int]:
    total = blank = comment = 0
    for line in source.splitlines():
        stripped = line.strip()
        total += 1
        if not stripped:
            blank += 1
        elif stripped.startswith("#"):
            comment += 1
    return {
        "total": total,
        "code": total - blank - comment,
        "comment": comment,
        "blank": blank,
    }


# ---------------------------------------------------------------------------
# Parser Agent
# ---------------------------------------------------------------------------

class ParserAgent(AgentBase):
    """Extract structural metadata from a Python source string.

    This agent does *not* produce a drift score by itself — its ``analyze``
    method always returns score=0.  Its purpose is to populate the ``details``
    dict so that downstream agents can consume precomputed data without
    re-parsing the source.

    To score Halstead drift, use ``halstead_drift(snapshot, baseline)``.
    """

    @property
    def name(self) -> str:
        return "ParserAgent"

    # ------------------------------------------------------------------
    # Public API: parse a source string into a snapshot dict
    # ------------------------------------------------------------------

    def parse(self, source: str) -> dict[str, Any]:
        """Parse *source* and return a full snapshot dict.

        The snapshot is suitable to pass as-is to all other agents.
        """
        snapshot: dict[str, Any] = {}

        # AST parse ---------------------------------------------------
        try:
            tree = ast.parse(source)
        except SyntaxError as exc:
            return {"error": str(exc)}

        snapshot["ast_tree"] = tree
        snapshot["source"] = source
        snapshot["loc"] = count_loc(source)

        # Functions ---------------------------------------------------
        functions: list[FunctionInfo] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                info = FunctionInfo(
                    name=node.name,
                    lineno=node.lineno,
                    end_lineno=getattr(node, "end_lineno", node.lineno),
                    args=[a.arg for a in node.args.args],
                    decorators=[
                        ast.unparse(d) for d in node.decorator_list
                    ],
                    is_async=isinstance(node, ast.AsyncFunctionDef),
                    cyclomatic_complexity=_cyclomatic(node),
                )
                functions.append(info)
        snapshot["functions"] = functions

        # Classes -----------------------------------------------------
        classes: list[ClassInfo] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                info = ClassInfo(
                    name=node.name,
                    lineno=node.lineno,
                    bases=[ast.unparse(b) for b in node.bases],
                    methods=[
                        n.name for n in ast.walk(node)
                        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                    ],
                )
                classes.append(info)
        snapshot["classes"] = classes

        # Imports -----------------------------------------------------
        imports: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                imports.extend(f"{mod}.{a.name}" for a in node.names)
        snapshot["imports"] = imports

        # Tokens + Halstead -------------------------------------------
        tokens = self._tokenize(source)
        snapshot["tokens"] = tokens
        snapshot["halstead"] = compute_halstead(tokens)

        # Cyclomatic avg ----------------------------------------------
        cc_values = [f.cyclomatic_complexity for f in functions]
        snapshot["cyclomatic_avg"] = (
            sum(cc_values) / len(cc_values) if cc_values else 0.0
        )

        return snapshot

    # ------------------------------------------------------------------

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        """Compute Halstead drift between snapshot and baseline.

        Drift is measured as normalised change in Halstead effort:
            d_effort = |effort_now - effort_baseline| / max(effort_baseline, 1)
        clamped to [0, 1].

        Additional sub-score based on cyclomatic complexity change is
        blended in at 30% weight.
        """
        h_now = snapshot.get("halstead", {})
        h_base = baseline.get("halstead", {})
        cc_now = snapshot.get("cyclomatic_avg", 0.0)
        cc_base = baseline.get("cyclomatic_avg", 0.0)

        effort_now = h_now.get("effort", 0.0)
        effort_base = h_base.get("effort", 0.0)
        effort_drift = self.clamp(
            abs(effort_now - effort_base) / max(effort_base, 1)
        )

        diff_cc = abs(cc_now - cc_base)
        cc_drift = self.clamp(diff_cc / max(cc_base, 1))

        score = self.clamp(0.7 * effort_drift + 0.3 * cc_drift)

        evidence = []
        if effort_base:
            evidence.append(
                f"Halstead effort: baseline={effort_base:.0f}, now={effort_now:.0f}"
                f" (Δ {effort_now - effort_base:+.0f})"
            )
        if cc_base:
            evidence.append(
                f"Cyclomatic avg: baseline={cc_base:.2f}, now={cc_now:.2f}"
                f" (Δ {cc_now - cc_base:+.2f})"
            )

        return AgentResult(
            agent_name=self.name,
            score=score,
            details={
                "halstead_now": h_now,
                "halstead_base": h_base,
                "effort_drift": effort_drift,
                "cyclomatic_drift": cc_drift,
                "cyclomatic_now": cc_now,
                "cyclomatic_base": cc_base,
            },
            evidence=evidence,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _tokenize(source: str) -> list[tuple[int, str]]:
        tokens: list[tuple[int, str]] = []
        try:
            gen = tokenize.generate_tokens(io.StringIO(source).readline)
            for tok in gen:
                tokens.append((tok.type, tok.string))
        except tokenize.TokenError:
            pass
        return tokens
