"""Dataclass schemas for explainable PR risk scoring.

The project still returns dictionaries at public CLI/API boundaries for
compatibility. These dataclasses define the stable internal contract used by
the research prototype: each signal carries a score, confidence, evidence,
and metadata that can be composed into file, commit, and PR explanations.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class EvidenceItem:
    """One normalized evidence statement for a drift signal."""

    signal_name: str
    text: str
    source: str = "analyzer"
    confidence: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class SignalResult:
    """Uniform output contract for structural, semantic, and evolution signals."""

    signal_name: str
    score: float
    evidence: list[str] = field(default_factory=list)
    confidence: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ExplainabilityBlock:
    """Normalized explanation payload attached to file and PR reports."""

    dominant_signals: list[str]
    contributions: dict[str, float]
    evidence_chain: list[EvidenceItem] = field(default_factory=list)
    confidence: float = 1.0
    uncertainty_note: str = ""

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["evidence_chain"] = [item.to_dict() for item in self.evidence_chain]
        return data
