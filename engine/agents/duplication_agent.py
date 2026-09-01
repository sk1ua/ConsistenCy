"""Deprecated compatibility import for the deterministic duplication analyzer."""
from ..analyzers.duplication_analyzer import DuplicationAnalyzer

DuplicationAgent = DuplicationAnalyzer

__all__ = ["DuplicationAnalyzer", "DuplicationAgent"]
