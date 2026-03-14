# -*- coding: utf-8 -*-
"""
Multi-language Parser System
============================
Provides unified parsing interface for multiple programming languages
via tree-sitter integration.

Supported languages:
- Python (primary, via ast or tree-sitter)
- JavaScript / TypeScript (via tree-sitter)
- Go, Java (planned)

Usage:
    from src.parsers import get_parser_for_file
    parser = get_parser_for_file("example.ts")
    snapshot = parser.parse(source_code)
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from .base_parser import BaseParser, ParseSnapshot
from .python_parser import PythonParser
from .tree_sitter_parser import TreeSitterParser

# Language registry
_PARSER_REGISTRY: dict[str, type[BaseParser]] = {
    ".py": PythonParser,
    ".js": TreeSitterParser,
    ".jsx": TreeSitterParser,
    ".ts": TreeSitterParser,
    ".tsx": TreeSitterParser,
}


def get_parser_for_file(filepath: str | Path) -> BaseParser | None:
    """Get appropriate parser for a file based on extension.
    
    Parameters
    ----------
    filepath : str | Path
        Path to the source file
        
    Returns
    -------
    BaseParser | None
        Parser instance for the file type, or None if unsupported
    """
    ext = Path(filepath).suffix.lower()
    parser_cls = _PARSER_REGISTRY.get(ext)
    if parser_cls is None:
        return None
    
    # TreeSitterParser needs language hint for non-Python files
    if parser_cls is TreeSitterParser:
        return TreeSitterParser(language_hint=ext)
    return parser_cls()


def get_supported_extensions() -> list[str]:
    """Return list of supported file extensions."""
    return list(_PARSER_REGISTRY.keys())


def is_supported_file(filepath: str | Path) -> bool:
    """Check if a file type is supported for analysis."""
    ext = Path(filepath).suffix.lower()
    return ext in _PARSER_REGISTRY


__all__ = [
    "BaseParser",
    "ParseSnapshot", 
    "PythonParser",
    "TreeSitterParser",
    "get_parser_for_file",
    "get_supported_extensions",
    "is_supported_file",
]