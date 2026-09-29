"""Research-facing deterministic risk composition utilities.

The weights, bonuses, gates and rounding used here are read from the canonical
rule table in :mod:`engine.models.enums`; the calculus itself is specified in
``docs/risk-scoring-rules.md`` (rule version :data:`RULE_VERSION`). Do not
re-declare thresholds in this module.
"""

from __future__ import annotations

from typing import Any

from ..models import SignalResult
from ..models.enums import (
    DUP_BOOST_MAX,
    DUP_BOOST_SATURATION,
    DUP_BOOST_TRIGGER,
    FILE_SIGNAL_WEIGHTS,
    SECURITY_BOOST_FACTOR,
    quantize_risk,
    security_gate_floor,
)

#: Backwards-compatible alias of the canonical file signal weights.
DEFAULT_FILE_WEIGHTS: dict[str, float] = dict(FILE_SIGNAL_WEIGHTS)


def duplication_bonus(duplication: float) -> float:
    """Return the duplication bonus for *duplication* (triggered, saturated)."""
    if duplication > DUP_BOOST_TRIGGER:
        return DUP_BOOST_MAX * min(duplication / DUP_BOOST_SATURATION, 1.0)
    return 0.0


def normalize_signal_results(
    analyzer_details: dict[str, Any] | None = None,
    *,
    agent_details: dict[str, Any] | None = None,
) -> dict[str, SignalResult]:
    """Convert deterministic analyzer details into canonical signal results.

    ``agent_details`` is a deprecated keyword retained for legacy callers; it
    refers only to this deterministic Python compatibility projection, never to
    the TypeScript LLM review-agent telemetry.
    """
    if analyzer_details is not None and agent_details is not None:
        raise ValueError("pass analyzer_details or legacy agent_details, not both")
    details_by_analyzer = analyzer_details if analyzer_details is not None else agent_details
    if details_by_analyzer is None:
        raise TypeError("normalize_signal_results requires analyzer details")

    mapping = {
        "style": "style",
        "structural": "structural",
        "semantic": "semantic",
        "duplication": "duplication",
        "security": "security",
        "evolution": "evolution",
    }
    normalized: dict[str, SignalResult] = {}
    for analyzer_name, details in details_by_analyzer.items():
        lowered = analyzer_name.lower()
        signal = next((value for prefix, value in mapping.items() if lowered.startswith(prefix)), None)
        if not signal:
            continue
        score = float(details.get("score", 0.0))
        evidence = [
            str(item) for item in details.get("evidence", [])
            if item and "no security issues detected" not in str(item).lower()
        ]
        normalized[signal] = SignalResult(
            signal_name=signal,
            score=max(0.0, min(1.0, score)),
            evidence=evidence,
            confidence=1.0 if evidence or score == 0 else 0.7,
            metadata={"analyzer_name": analyzer_name},
        )
    return normalized


def file_contributions(
    breakdown: dict[str, float],
    *,
    weights: dict[str, float] | None = None,
) -> dict[str, float]:
    """Return normalized contribution mass for a file-level risk score."""

    weights = weights or DEFAULT_FILE_WEIGHTS
    duplication = float(breakdown.get("duplication", 0.0))
    security = float(breakdown.get("security", 0.0))
    raw = {
        "style": weights.get("style", FILE_SIGNAL_WEIGHTS["style"]) * float(breakdown.get("style", 0.0)),
        "structural": weights.get("structural", FILE_SIGNAL_WEIGHTS["structural"]) * float(breakdown.get("structural", 0.0)),
        "semantic": weights.get("semantic", FILE_SIGNAL_WEIGHTS["semantic"]) * float(breakdown.get("semantic", 0.0)),
        "duplication": duplication_bonus(duplication),
        "security": security * SECURITY_BOOST_FACTOR,
    }
    total = sum(raw.values()) or 1.0
    return {key: round(value / total, 4) for key, value in raw.items()}


def compose_file_risk(
    breakdown: dict[str, float],
    *,
    weights: dict[str, float] | None = None,
) -> float:
    """Formal file-level risk function R_f = g(S_style, S_struct, S_sem, S_dup, S_sec).

    ``numerator`` = weighted linear combination + duplication bonus + security
    bonus; ``denominator`` = the bounded absolute scale 1.0 (no sample-size
    normalisation). The security gates lift the result to the canonical RED /
    ORANGE floors, and the result is quantized half-even per the rule table.
    """

    weights = weights or DEFAULT_FILE_WEIGHTS
    style = float(breakdown.get("style", 0.0))
    structural = float(breakdown.get("structural", 0.0))
    semantic = float(breakdown.get("semantic", 0.0))
    duplication = float(breakdown.get("duplication", 0.0))
    security = float(breakdown.get("security", 0.0))
    base = (
        weights.get("style", FILE_SIGNAL_WEIGHTS["style"]) * style
        + weights.get("structural", FILE_SIGNAL_WEIGHTS["structural"]) * structural
        + weights.get("semantic", FILE_SIGNAL_WEIGHTS["semantic"]) * semantic
    )
    dup_boost = duplication_bonus(duplication)
    security_boost = security * SECURITY_BOOST_FACTOR
    risk = max(0.0, min(1.0, base + dup_boost + security_boost))
    risk = max(risk, security_gate_floor(security))
    return quantize_risk(risk)
