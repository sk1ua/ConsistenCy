"""Deprecated compatibility import for the deterministic evolution analyzer."""
from ..analyzers.evolution_analyzer import EvolutionAnalyzer

EvolutionAgent = EvolutionAnalyzer

__all__ = ["EvolutionAnalyzer", "EvolutionAgent"]
