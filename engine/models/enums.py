"""Enums used by project-specific code drift reports."""

from __future__ import annotations

from enum import StrEnum


class SignalName(StrEnum):
    """Canonical drift signal families used by the research prototype."""

    STYLE = "style"
    STRUCTURAL = "structural"
    SEMANTIC = "semantic"
    DUPLICATION = "duplication"
    SECURITY = "security"
    EVOLUTION = "evolution"


class RiskLevel(StrEnum):
    """Human-facing risk labels."""

    CONSISTENT = "Consistent"
    MINOR_DRIFT = "Minor Drift"
    SIGNIFICANT_DRIFT = "Significant Drift"
    HIGH_RISK = "High Risk"


class RiskColour(StrEnum):
    """Display colours mapped to risk tiers."""

    GREEN = "GREEN"
    YELLOW = "YELLOW"
    ORANGE = "ORANGE"
    RED = "RED"


# ---------------------------------------------------------------------------
# Canonical threshold → label/colour helpers (single source of truth)
# ---------------------------------------------------------------------------

_RISK_THRESHOLDS: list[tuple[float, str, str]] = [
    (0.75, "High Risk", "RED"),
    (0.50, "Significant Drift", "ORANGE"),
    (0.25, "Minor Drift", "YELLOW"),
    (0.00, "Consistent", "GREEN"),
]


def score_to_risk_label(score: float) -> str:
    """Return the canonical human-readable risk label for *score* ∈ [0, 1]."""
    for threshold, label, _ in _RISK_THRESHOLDS:
        if score >= threshold:
            return label
    return "Consistent"


def score_to_risk_colour(score: float) -> str:
    """Return the canonical display colour name for *score* ∈ [0, 1]."""
    for threshold, _, colour in _RISK_THRESHOLDS:
        if score >= threshold:
            return colour
    return "GREEN"
