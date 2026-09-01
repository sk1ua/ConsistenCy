# -*- coding: utf-8 -*-
"""
Python Parser
=============
Python-specific parser using stdlib ast module.
Feeds the canonical ParserAnalyzer snapshot contract; legacy ParserAgent imports remain available through engine.agents.
"""
from __future__ import annotations

import ast
import io
import math
import tokenize
from collections import Counter
from typing import Any

from .base_parser import BaseParser, ParseSnapshot, FunctionInfo, ClassInfo, ImportInfo


class PythonParser(BaseParser):
    """Parse Python source using stdlib ast module."""

    @property
    def language(self) -> str:
        return "python"

    def parse(self, source: str) -> ParseSnapshot:
        """Parse Python source and return universal snapshot."""
        try:
            tree = ast.parse(source)
        except SyntaxError as e:
            return ParseSnapshot(
                source=source,
                language=self.language,
                error=str(e),
            )

        # Extract functions
        functions = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                func_info = FunctionInfo(
                    name=node.name,
                    lineno=node.lineno,
                    end_lineno=getattr(node, "end_lineno", node.lineno),
                    args=[a.arg for a in node.args.args],
                    is_async=isinstance(node, ast.AsyncFunctionDef),
                    is_method=self._is_method(node),
                    complexity=self._cyclomatic(node),
                )
                functions.append(func_info)

        # Extract classes
        classes = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                class_info = ClassInfo(
                    name=node.name,
                    lineno=node.lineno,
                    bases=[self._unparse(base) for base in node.bases],
                    methods=[
                        n.name for n in node.body
                        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                    ],
                )
                classes.append(class_info)

        # Extract imports
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.append(ImportInfo(
                        module=None,
                        names=[alias.name],
                        is_from_import=False,
                    ))
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    imports.append(ImportInfo(
                        module=node.module,
                        names=[alias.name],
                        is_from_import=True,
                    ))

        # Compute metrics
        loc = self.count_loc(source, comment_syntax=("#", ""))
        cyclomatic_avg = self._compute_cyclomatic_avg(functions)
        halstead = self._compute_halstead(source)

        return ParseSnapshot(
            source=source,
            language=self.language,
            functions=functions,
            classes=classes,
            imports=imports,
            loc=loc,
            cyclomatic_avg=cyclomatic_avg,
            halstead=halstead,
            raw_ast=tree,
        )

    def _is_method(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
        """Check if function is a method (inside a class)."""
        # This is a simplified check - for accurate detection,
        # we'd need parent pointers which ast doesn't provide easily
        return False  # Will be determined by caller context

    def _cyclomatic(self, node: ast.AST) -> int:
        """Compute cyclomatic complexity for a function."""
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

    def _compute_cyclomatic_avg(self, functions: list[FunctionInfo]) -> float:
        """Compute average cyclomatic complexity."""
        if not functions:
            return 0.0
        return sum(f.complexity for f in functions) / len(functions)

    def _compute_halstead(self, source: str) -> dict[str, float]:
        """Compute Halstead metrics from token stream."""
        OPERATOR_TYPES = {tokenize.OP, tokenize.ERRORTOKEN}
        KEYWORD_TOKENS = {
            "if", "else", "elif", "while", "for", "return", "yield",
            "and", "or", "not", "in", "is", "lambda", "def", "class",
            "import", "from", "as", "with", "try", "except", "finally",
            "raise", "pass", "break", "continue", "del", "assert",
            "global", "nonlocal",
        }

        operators: list[str] = []
        operands: list[str] = []

        try:
            gen = tokenize.generate_tokens(io.StringIO(source).readline)
            for tok in gen:
                tok_type, tok_str = tok.type, tok.string
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
        except tokenize.TokenError:
            pass

        cnt_op = Counter(operators)
        cnt_opnd = Counter(operands)

        n1 = len(cnt_op)
        n2 = len(cnt_opnd)
        N1 = sum(cnt_op.values())
        N2 = sum(cnt_opnd.values())

        vocabulary = n1 + n2
        length = N1 + N2
        volume = length * math.log2(vocabulary) if vocabulary > 0 else 0.0
        difficulty = (n1 / 2) * (N2 / n2) if n2 > 0 else 0.0
        effort = difficulty * volume

        return {
            "n1": n1,
            "n2": n2,
            "N1": N1,
            "N2": N2,
            "vocabulary": vocabulary,
            "length": length,
            "volume": round(volume, 2),
            "difficulty": round(difficulty, 2),
            "effort": round(effort, 2),
        }

    def _unparse(self, node: ast.AST) -> str:
        """Safely unparse AST node to string."""
        try:
            return ast.unparse(node)
        except Exception:
            return str(node)
