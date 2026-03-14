# -*- coding: utf-8 -*-
"""
Base Parser Interface
=====================
Abstract base class for all language parsers.
Ensures consistent interface across Python AST and tree-sitter implementations.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class FunctionInfo:
    """Universal function/method metadata."""
    name: str
    lineno: int
    end_lineno: int
    args: list[str]
    is_async: bool = False
    is_method: bool = False
    complexity: int = 1  # Cyclomatic complexity estimate


@dataclass
class ClassInfo:
    """Universal class metadata."""
    name: str
    lineno: int
    bases: list[str]
    methods: list[str] = field(default_factory=list)


@dataclass
class ImportInfo:
    """Universal import metadata."""
    module: str | None
    names: list[str]  # imported names
    is_from_import: bool = False


@dataclass
class ParseSnapshot:
    """Universal parse result structure.
    
    This is the contract between parsers and agents.
    All parsers must return this structure, regardless of underlying implementation.
    """
    # Raw source
    source: str
    
    # Language identifier
    language: str  # "python", "javascript", "typescript", etc.
    
    # Structural elements
    functions: list[FunctionInfo] = field(default_factory=list)
    classes: list[ClassInfo] = field(default_factory=list)
    imports: list[ImportInfo] = field(default_factory=list)
    
    # Metrics (language-agnostic)
    loc: dict[str, int] = field(default_factory=lambda: {
        "total": 0, "code": 0, "comment": 0, "blank": 0
    })
    cyclomatic_avg: float = 0.0
    
    # Halstead metrics (if computable)
    halstead: dict[str, float] = field(default_factory=dict)
    
    # Raw AST (implementation-specific, for advanced agents)
    raw_ast: Any = None
    
    # Error tracking
    error: str | None = None
    
    def to_agent_snapshot(self) -> dict[str, Any]:
        """Convert to backward-compatible dict format for existing agents."""
        return {
            "source": self.source,
            "language": self.language,
            "functions": [
                {
                    "name": f.name,
                    "lineno": f.lineno,
                    "end_lineno": f.end_lineno,
                    "args": f.args,
                    "is_async": f.is_async,
                    "cyclomatic_complexity": f.complexity,
                }
                for f in self.functions
            ],
            "classes": [
                {
                    "name": c.name,
                    "lineno": c.lineno,
                    "bases": c.bases,
                    "methods": c.methods,
                }
                for c in self.classes
            ],
            "imports": [
                f"{i.module}.{n}" if i.module else n
                for i in self.imports
                for n in i.names
            ],
            "loc": self.loc,
            "cyclomatic_avg": self.cyclomatic_avg,
            "halstead": self.halstead,
            "error": self.error,
        }


class BaseParser(ABC):
    """Abstract base class for all language parsers."""
    
    @property
    @abstractmethod
    def language(self) -> str:
        """Return language identifier (e.g., 'python', 'javascript')."""
        pass
    
    @abstractmethod
    def parse(self, source: str) -> ParseSnapshot:
        """Parse source code and return universal snapshot.
        
        Parameters
        ----------
        source : str
            Source code to parse
            
        Returns
        -------
        ParseSnapshot
            Language-agnostic parse result
        """
        pass
    
    def is_valid_source(self, source: str) -> bool:
        """Check if source can be parsed without syntax errors."""
        snapshot = self.parse(source)
        return snapshot.error is None
    
    @staticmethod
    def count_loc(source: str, comment_syntax: tuple[str, str] = ("#", "")) -> dict[str, int]:
        """Count lines of code (language-agnostic).
        
        Parameters
        ----------
        source : str
            Source code
        comment_syntax : tuple[str, str]
            (single_line_comment, multi_line_comment_start)
            e.g., ("#", "/*") for Python-like, ("//", "/*") for C-like
        """
        total = blank = comment = 0
        single_comment = comment_syntax[0]
        
        in_multiline_comment = False
        
        for line in source.splitlines():
            total += 1
            stripped = line.strip()
            
            if not stripped:
                blank += 1
                continue
            
            # Single-line comment
            if single_comment and stripped.startswith(single_comment):
                comment += 1
                continue
            
            # Check for inline comment
            if single_comment and single_comment in stripped:
                # Simple heuristic: if comment marker appears before any code
                parts = stripped.split(single_comment, 1)
                if not parts[0].strip():
                    comment += 1
                    continue
        
        return {
            "total": total,
            "code": total - blank - comment,
            "comment": comment,
            "blank": blank,
        }