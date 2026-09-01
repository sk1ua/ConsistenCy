"""Deprecated compatibility imports for the deterministic analyzer package."""
from ..analyzers.base_analyzer import AnalyzerBase, AnalyzerResult

AgentBase = AnalyzerBase
AgentResult = AnalyzerResult

__all__ = ["AnalyzerBase", "AnalyzerResult", "AgentBase", "AgentResult"]
