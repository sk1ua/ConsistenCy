"""Explainability helpers for human-aligned PR risk reports."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ..models import EvidenceItem, ExplainabilityBlock
from .composer import file_contributions


def dominant_signals(contributions: dict[str, float], *, limit: int = 2) -> list[str]:
    """Return the highest-contributing non-zero signal names."""

    ordered = sorted(
        ((name, float(value)) for name, value in contributions.items() if float(value) > 0),
        key=lambda item: item[1],
        reverse=True,
    )
    return [name for name, _ in ordered[:limit]]


def build_evidence_chain(
    signal_evidence: dict[str, Iterable[str]],
    *,
    max_items: int = 8,
) -> list[EvidenceItem]:
    """Deduplicate signal evidence while preserving signal provenance."""

    seen: set[tuple[str, str]] = set()
    chain: list[EvidenceItem] = []
    for signal_name, evidence_items in signal_evidence.items():
        for text in evidence_items:
            clean = str(text).strip()
            key = (signal_name, clean)
            if not clean or key in seen:
                continue
            seen.add(key)
            chain.append(EvidenceItem(signal_name=signal_name, text=clean))
            if len(chain) >= max_items:
                return chain
    return chain


def build_confidence(
    *,
    baseline_versions: int = 0,
    signal_agreement: float = 0.0,
    history_depth: int = 0,
) -> float:
    """Confidence q(baseline sufficiency, signal agreement, history depth)."""

    baseline_term = min(max(baseline_versions, 0) / 8.0, 1.0)
    agreement_term = max(0.0, min(signal_agreement, 1.0))
    history_term = min(max(history_depth, 0) / 50.0, 1.0)
    return round(0.45 * baseline_term + 0.35 * agreement_term + 0.20 * history_term, 4)


def build_explainability_block(
    breakdown: dict[str, float],
    signal_evidence: dict[str, Iterable[str]],
    *,
    confidence: float = 0.75,
) -> dict[str, Any]:
    """Create a stable explainability block for a risky file or PR."""

    contributions = file_contributions(breakdown)
    block = ExplainabilityBlock(
        dominant_signals=dominant_signals(contributions),
        contributions=contributions,
        evidence_chain=build_evidence_chain(signal_evidence),
        confidence=max(0.0, min(1.0, confidence)),
        uncertainty_note=(
            "Confidence is lower when historical baseline coverage is sparse or "
            "signals disagree."
        ),
    )
    return block.to_dict()
