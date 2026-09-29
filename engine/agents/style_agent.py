"""Deprecated compatibility import for the deterministic style analyzer."""
from ..analyzers.style_analyzer import StyleAnalyzer

StyleAgent = StyleAnalyzer

__all__ = ["StyleAnalyzer", "StyleAgent"]
