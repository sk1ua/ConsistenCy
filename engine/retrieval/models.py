"""Serializable retrieval models for evidence-grounded review reports."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Any, Literal

EvidenceKind = Literal[
    "changed_hunk",
    "file_snippet",
    "baseline_snippet",
    "history_signal",
    "agent_finding",
    "import_context",
    "callsite_hint",
    "review_comment_hint",
    "security_hint",
    "evolution_hint",
]


@dataclass
class EvidenceQuery:
    file: str
    path_terms: list[str] = field(default_factory=list)
    symbol_terms: list[str] = field(default_factory=list)
    import_terms: list[str] = field(default_factory=list)
    risk_terms: list[str] = field(default_factory=list)
    natural_query: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvidenceCandidate:
    id: str
    file: str
    kind: EvidenceKind
    source: str
    content: str
    start_line: int | None = None
    end_line: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvidenceScore:
    total: float
    path_relevance: float = 0.0
    symbol_overlap: float = 0.0
    import_overlap: float = 0.0
    risk_signal_overlap: float = 0.0
    changed_line_proximity: float = 0.0
    severity_boost: float = 0.0
    history_boost: float = 0.0
    security_boost: float = 0.0
    local_similarity: float = 0.0
    reasons: list[str] = field(default_factory=list)


@dataclass
class SelectedEvidence:
    candidate: EvidenceCandidate
    score: EvidenceScore
    why_selected: list[str] = field(default_factory=list)


@dataclass
class DiscardedEvidence:
    candidate_id: str
    kind: EvidenceKind
    score: float
    why_discarded: list[str] = field(default_factory=list)


@dataclass
class EvidencePack:
    file: str
    retrieval_strategy: str
    context_budget_tokens: int
    query: EvidenceQuery
    selected_evidence: list[SelectedEvidence]
    discarded_candidates: list[DiscardedEvidence]
    compression: dict[str, Any]


def to_jsonable(value: Any) -> Any:
    """Convert retrieval dataclasses into plain JSON-serializable objects."""
    if is_dataclass(value):
        return to_jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [to_jsonable(item) for item in value]
    return value
