"""Deprecated compatibility import for the deterministic structural analyzer."""
from ..analyzers.structural_analyzer import (
    StructuralAnalyzer,
    _inheritance_depths,
)

StructuralAgent = StructuralAnalyzer

__all__ = ["StructuralAnalyzer", "StructuralAgent", "_inheritance_depths"]
