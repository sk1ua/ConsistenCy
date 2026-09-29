"""Typed contracts for the research-oriented ConsistenCy pipeline.

The canonical risk-scoring rule table lives in :mod:`engine.models.enums`
(see ``docs/risk-scoring-rules.md``); it is re-exported here so downstream
modules can consume the rules without importing the private submodule.
"""

from .enums import (
    RiskColour,
    RiskLevel,
    SignalName,
    band_for_score,
    critical_threshold,
    high_threshold,
    medium_threshold,
    overall_score_for_risk,
    score_to_machine_level,
    score_to_risk_colour,
    score_to_risk_label,
)
from .schemas import EvidenceItem, ExplainabilityBlock, SignalResult

__all__ = [
    "EvidenceItem",
    "ExplainabilityBlock",
    "RiskColour",
    "RiskLevel",
    "SignalName",
    "SignalResult",
    "band_for_score",
    "critical_threshold",
    "high_threshold",
    "medium_threshold",
    "overall_score_for_risk",
    "score_to_machine_level",
    "score_to_risk_colour",
    "score_to_risk_label",
]
