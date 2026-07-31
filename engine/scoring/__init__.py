"""Risk composition and explainability helpers."""

from .composer import (
    compose_file_risk,
    file_contributions,
    normalize_signal_results,
)
from .explainability import (
    build_confidence,
    build_evidence_chain,
    build_explainability_block,
    dominant_signals,
)

__all__ = [
    "build_confidence",
    "build_evidence_chain",
    "build_explainability_block",
    "compose_file_risk",
    "dominant_signals",
    "file_contributions",
    "normalize_signal_results",
]
