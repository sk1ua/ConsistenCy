"""Research-facing deterministic risk composition utilities."""

from __future__ import annotations

from typing import Any

from ..models import SignalResult

DEFAULT_FILE_WEIGHTS: dict[str, float] = {
    "style": 0.28,
    "structural": 0.39,
    "semantic": 0.33,
}


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
        "style": weights.get("style", 0.28) * float(breakdown.get("style", 0.0)),
        "structural": weights.get("structural", 0.39) * float(breakdown.get("structural", 0.0)),
        "semantic": weights.get("semantic", 0.33) * float(breakdown.get("semantic", 0.0)),
        "duplication": 0.05 * min(duplication / 0.30, 1.0) if duplication > 0.05 else 0.0,
        "security": security * 0.50,
    }
    total = sum(raw.values()) or 1.0
    return {key: round(value / total, 4) for key, value in raw.items()}


def compose_file_risk(
    breakdown: dict[str, float],
    *,
    weights: dict[str, float] | None = None,
) -> float:
    """Formal file-level risk function R_f = g(S_style, S_struct, S_sem, S_dup, S_sec)."""

    weights = weights or DEFAULT_FILE_WEIGHTS
    style = float(breakdown.get("style", 0.0))
    structural = float(breakdown.get("structural", 0.0))
    semantic = float(breakdown.get("semantic", 0.0))
    duplication = float(breakdown.get("duplication", 0.0))
    security = float(breakdown.get("security", 0.0))
    base = (
        weights.get("style", 0.28) * style
        + weights.get("structural", 0.39) * structural
        + weights.get("semantic", 0.33) * semantic
    )
    dup_boost = 0.05 * min(duplication / 0.30, 1.0) if duplication > 0.05 else 0.0
    security_boost = security * 0.50
    risk = max(0.0, min(1.0, base + dup_boost + security_boost))
    if security >= 0.60:
        risk = max(risk, 0.75)
    elif security >= 0.30:
        risk = max(risk, 0.50)
    return round(risk, 4)
