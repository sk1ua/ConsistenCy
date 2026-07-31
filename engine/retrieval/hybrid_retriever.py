"""Hybrid deterministic evidence retrieval without embeddings."""

from __future__ import annotations

from .models import EvidenceCandidate, EvidenceQuery, EvidenceScore
from .reranker import score_candidate


def retrieve_evidence(
    query: EvidenceQuery,
    candidates: list[EvidenceCandidate],
    top_k: int = 8,
) -> list[tuple[EvidenceCandidate, EvidenceScore]]:
    """Return stable top-k candidates scored by path/symbol/risk signals."""
    scored = [
        (candidate, score_candidate(query, candidate))
        for candidate in candidates
        if candidate.content.strip()
    ]
    scored.sort(key=lambda item: (-item[1].total, item[0].id, item[0].source))
    return scored[: max(top_k, 0)]
