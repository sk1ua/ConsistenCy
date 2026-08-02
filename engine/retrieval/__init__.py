"""Deterministic evidence retrieval for reviewer-attention reports."""

from .evidence_pack import build_evidence_pack, build_retrieval_section
from .hybrid_retriever import retrieve_evidence
from .models import (
    DiscardedEvidence,
    EvidenceCandidate,
    EvidencePack,
    EvidenceQuery,
    EvidenceScore,
    SelectedEvidence,
)
from .query_builder import build_evidence_query

__all__ = [
    "DiscardedEvidence",
    "EvidenceCandidate",
    "EvidencePack",
    "EvidenceQuery",
    "EvidenceScore",
    "SelectedEvidence",
    "build_evidence_pack",
    "build_evidence_query",
    "build_retrieval_section",
    "retrieve_evidence",
]
