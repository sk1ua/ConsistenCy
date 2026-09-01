"""Deprecated compatibility import for the deterministic semantic analyzer."""
from ..analyzers.semantic_analyzer import SemanticAnalyzer

SemanticAgent = SemanticAnalyzer

__all__ = ["SemanticAnalyzer", "SemanticAgent"]
