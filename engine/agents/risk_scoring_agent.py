"""Deprecated compatibility import for the deterministic risk_scoring analyzer."""
from ..analyzers.risk_scoring_analyzer import RiskScoringAnalyzer

RiskScoringAgent = RiskScoringAnalyzer

__all__ = ["RiskScoringAnalyzer", "RiskScoringAgent"]
