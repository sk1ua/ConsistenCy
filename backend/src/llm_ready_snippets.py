# -*- coding: utf-8 -*-
"""
LLM-Ready Code Snippets
=======================
Identifies and extracts code snippets optimized for LLM analysis.

Goals:
- Extract self-contained code segments
- Provide context (imports, class/function signatures)
- Identify risky or complex code for LLM review
- Generate natural language descriptions
"""
from __future__ import annotations

import ast
from typing import Any, Optional


class CodeSnippetExtractor:
    """Extract LLM-friendly code snippets."""

    @staticmethod
    def extract_functions(source: str, *, max_body_lines: int = 40) -> list[dict[str, Any]]:
        """Extract all functions/methods from source with signatures and bodies.

        Parameters
        ----------
        source : str
            Python source code
        max_body_lines : int
            Maximum number of body lines to include per function.
            Bodies longer than this are truncated with a ``...`` marker
            so the LLM knows the excerpt is incomplete.

        Returns
        -------
        list[dict]
            List of function definitions with line numbers and content
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return []

        functions = []
        lines = source.splitlines()

        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                start_line = node.lineno - 1
                end_line = node.end_lineno or len(lines)

                # Extract function signature (first line only)
                signature = ast.get_source_segment(source, node)
                if not signature:
                    args = ", ".join(
                        arg.arg for arg in node.args.args
                    )
                    func_type = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
                    signature = f"{func_type} {node.name}({args}):"

                # Extract function body (all lines after signature)
                body_lines = lines[start_line:end_line]
                truncated = len(body_lines) > max_body_lines
                body = "\n".join(body_lines[:max_body_lines])
                if truncated:
                    body += f"\n# ... ({len(body_lines) - max_body_lines} more lines) ..."

                functions.append({
                    "name": node.name,
                    "type": "async_function" if isinstance(node, ast.AsyncFunctionDef) else "function",
                    "lineno": node.lineno,
                    "end_lineno": end_line,
                    "length": end_line - start_line,
                    "signature": signature[:200],
                    "body": body,
                    "truncated": truncated,
                    "is_method": False,
                    "has_docstring": ast.get_docstring(node) is not None,
                    "complexity": _estimate_function_complexity(node),
                })

        return functions

    @staticmethod
    def extract_classes(source: str) -> list[dict[str, Any]]:
        """Extract all classes with their methods.
        
        Parameters
        ----------
        source : str
            Python source code
        
        Returns
        -------
        list[dict]
            List of class definitions with method signatures
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return []
        
        classes = []
        
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                methods = []
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        methods.append({
                            "name": item.name,
                            "is_async": isinstance(item, ast.AsyncFunctionDef),
                            "is_dunder": item.name.startswith("__"),
                        })
                
                classes.append({
                    "name": node.name,
                    "lineno": node.lineno,
                    "method_count": len(methods),
                    "methods": methods,
                    "has_docstring": ast.get_docstring(node) is not None,
                    "base_classes": [
                        ast.unparse(base) if hasattr(ast, "unparse") else str(base)
                        for base in node.bases
                    ],
                })
        
        return classes

    @staticmethod
    def identify_risky_snippets(source: str) -> list[dict[str, Any]]:
        """Identify code segments that should be reviewed by LLM.
        
        Risk factors:
        - High cyclomatic complexity
        - Long functions
        - Missing docstrings in public functions
        - Bare except/pass statements
        - Type mismatches (if analyzable)
        
        Parameters
        ----------
        source : str
            Python source code
        
        Returns
        -------
        list[dict]
            List of risky snippets with reasons
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return []
        
        risky_snippets = []
        lines = source.splitlines()
        
        class RiskAnalyzer(ast.NodeVisitor):
            def visit_FunctionDef(self, node):
                # Check for missing docstring in public function
                if not node.name.startswith("_"):
                    if not ast.get_docstring(node):
                        risky_snippets.append({
                            "type": "missing_docstring",
                            "location": node.lineno,
                            "name": node.name,
                            "severity": "medium",
                            "reason": "Public function lacks docstring",
                        })
                
                # Check for long functions
                length = (node.end_lineno or node.lineno) - node.lineno
                if length > 50:
                    risky_snippets.append({
                        "type": "long_function",
                        "location": node.lineno,
                        "name": node.name,
                        "severity": "low",
                        "reason": f"Function is {length} lines long",
                    })
                
                self.generic_visit(node)
            
            def visit_Except(self, node):
                # Bare except
                if node.type is None:
                    risky_snippets.append({
                        "type": "bare_except",
                        "location": node.lineno,
                        "severity": "high",
                        "reason": "Bare except clause catches all exceptions",
                    })
                self.generic_visit(node)
            
            def visit_Pass(self, node):
                # Standalone pass (incomplete implementation)
                parent_lineno = node.lineno
                if parent_lineno < len(lines):
                    line = lines[parent_lineno - 1].strip()
                    if line == "pass":
                        risky_snippets.append({
                            "type": "pass_statement",
                            "location": node.lineno,
                            "severity": "low",
                            "reason": "Empty or incomplete implementation",
                        })
                self.generic_visit(node)
        
        analyzer = RiskAnalyzer()
        analyzer.visit(tree)
        
        return risky_snippets

    @staticmethod
    def extract_with_context(
        source: str,
        line_number: int,
        context_lines: int = 5,
    ) -> Optional[dict[str, Any]]:
        """Extract snippet around a specific line with context.
        
        Parameters
        ----------
        source : str
            Python source code
        line_number : int
            Line number (1-indexed)
        context_lines : int
            Number of lines before/after
        
        Returns
        -------
        dict or None
            Snippet with context and metadata
        """
        lines = source.splitlines()
        
        if line_number < 1 or line_number > len(lines):
            return None
        
        start = max(0, line_number - 1 - context_lines)
        end = min(len(lines), line_number + context_lines)
        
        snippet_lines = lines[start:end]
        target_offset = line_number - start - 1
        
        return {
            "line_number": line_number,
            "start_line": start + 1,
            "end_line": end + 1,
            "content": "\n".join(snippet_lines),
            "target_line_offset": target_offset,
            "language": "python",
        }

    @staticmethod
    def generate_snippet_description(snippet: dict[str, Any]) -> str:
        """Generate natural language description of a code snippet.
        
        Parameters
        ----------
        snippet : dict
            Snippet data with type and metadata
        
        Returns
        -------
        str
            Human-readable description for LLM
        """
        snippet_type = snippet.get("type", "code")
        
        if snippet_type == "function":
            return (
                f"Function '{snippet.get('name')}' at line {snippet.get('lineno')} "
                f"({snippet.get('length')} lines, complexity: {snippet.get('complexity')})"
            )
        elif snippet_type == "class":
            methods = snippet.get("method_count", 0)
            return (
                f"Class '{snippet.get('name')}' with {methods} methods "
                f"at line {snippet.get('lineno')}"
            )
        elif snippet_type == "missing_docstring":
            return (
                f"Public function '{snippet.get('name')}' at line {snippet.get('location')} "
                f"is missing a docstring"
            )
        elif snippet_type == "long_function":
            return (
                f"Function is quite long ({snippet.get('reason')}) "
                f"and might be hard to understand or test"
            )
        else:
            return f"{snippet_type} issue at line {snippet.get('location')}"


def _estimate_function_complexity(node: ast.FunctionDef) -> str:
    """Quick estimate of function complexity from AST."""
    complexity = 1
    for child in ast.walk(node):
        if isinstance(child, (ast.If, ast.For, ast.While)):
            complexity += 1
    
    if complexity <= 5:
        return "simple"
    elif complexity <= 10:
        return "moderate"
    else:
        return "complex"


def prepare_code_for_llm(
    source: str,
    filepath: str = "unknown",
) -> dict[str, Any]:
    """Prepare entire source file for LLM analysis.
    
    Parameters
    ----------
    source : str
        Python source code
    filepath : str
        File path for context
    
    Returns
    -------
    dict
        Structured data ready for LLM processing
    """
    return {
        "filepath": filepath,
        "total_lines": len(source.splitlines()),
        "functions": CodeSnippetExtractor.extract_functions(source),
        "classes": CodeSnippetExtractor.extract_classes(source),
        "risky_snippets": CodeSnippetExtractor.identify_risky_snippets(source),
        "imports": _extract_imports(source),
    }


def _extract_imports(source: str) -> list[str]:
    """Extract all import statements from source."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.append(node.module)
    
    return list(set(imports))
