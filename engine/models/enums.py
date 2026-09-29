"""Enums plus the canonical, versioned risk-scoring rule table.

This module is the **single source of truth** for the deterministic risk
calculus specified in ``docs/risk-scoring-rules.md`` (rule version
``RULE_VERSION``). Every consumer — analyzers, file composer, changeset
aggregation, workflow severity projection — reads its endpoints from here;
no consumer may re-declare a threshold literal.

Two monotonicity classes are declared separately and must not be conflated:

* **weak / non-decreasing** properties hold whenever a score or weight is
  increased (they degrade to a plateau at saturation);
* **strictly increasing** properties hold only while the result is
  un-saturated and the increment exceeds the quantization quantum.

See :data:`MONOTONICITY` for the machine-readable declaration and
``docs/risk-scoring-rules.md`` §6 for proofs and counterexamples.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final


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
# Rule version and version policy
# ---------------------------------------------------------------------------

#: Active rule version. Bump the MINOR part for any change that can alter a
#: score, band or gate decision; bump the MAJOR part for semantic/value-range
#: changes of protocol fields. See docs/risk-scoring-rules.md §8.
RULE_VERSION: Final[str] = "risk-rules/v3.1"

#: Rule version this table replaced (kept for evaluation comparisons).
PREVIOUS_RULE_VERSION: Final[str] = "risk-rules/v3.0"

#: Date the active rule version was defined.
RULE_VERSION_DATE: Final[str] = "2026-09-27"

#: Repository-relative path of the human-readable specification.
RULE_SPEC_PATH: Final[str] = "docs/risk-scoring-rules.md"

#: Decimal places kept for a file risk score (half-even rounding).
RISK_QUANTUM: Final[int] = 4


# ---------------------------------------------------------------------------
# Canonical threshold → label/colour/machine-level table (single source)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RiskBand:
    """One canonical risk band; the interval is ``[min_score, next_band)``."""

    min_score: float
    label: str
    colour: str
    machine_level: str
    evidence_key: str


#: Ordered from highest to lowest: the first band whose ``min_score`` is not
#: greater than the score wins, which makes band lookup monotone in the score.
RISK_BANDS: Final[tuple[RiskBand, ...]] = (
    RiskBand(0.75, "High Risk", "RED", "critical", "[critical]"),
    RiskBand(0.50, "Significant Drift", "ORANGE", "high", "[high]"),
    RiskBand(0.25, "Minor Drift", "YELLOW", "medium", "[medium]"),
    RiskBand(0.00, "Consistent", "GREEN", "low", "[low]"),
)

#: Legacy tuple view ``(min_score, label, colour)`` retained verbatim so that
#: existing importers keep working.
_RISK_THRESHOLDS: list[tuple[float, str, str]] = [
    (band.min_score, band.label, band.colour) for band in RISK_BANDS
]


def band_for_score(score: float) -> RiskBand:
    """Return the canonical band for *score* ∈ [0, 1] (left-closed lookup)."""
    for band in RISK_BANDS:
        if score >= band.min_score:
            return band
    return RISK_BANDS[-1]


def critical_threshold() -> float:
    """Lower bound of the RED band; the deterministic critical gate floor."""
    return RISK_BANDS[0].min_score


def high_threshold() -> float:
    """Lower bound of the ORANGE band; the deterministic high gate floor."""
    return RISK_BANDS[1].min_score


def medium_threshold() -> float:
    """Lower bound of the YELLOW band (advisory band, deliberately un-gated)."""
    return RISK_BANDS[2].min_score


def score_to_risk_label(score: float) -> str:
    """Return the canonical human-readable risk label for *score* ∈ [0, 1]."""
    return band_for_score(score).label


def score_to_risk_colour(score: float) -> str:
    """Return the canonical display colour name for *score* ∈ [0, 1]."""
    return band_for_score(score).colour


def score_to_machine_level(score: float) -> str:
    """Return the canonical machine tier (``critical|high|medium|low``)."""
    return band_for_score(score).machine_level


# ---------------------------------------------------------------------------
# File-level composition R_f = g(S_style, S_struct, S_sem, S_dup, S_sec)
# ---------------------------------------------------------------------------

#: Numerator weights of the linear part; the denominator is the bounded
#: absolute scale 1.0 (no sample-size normalisation). Weights sum to 1.00.
FILE_SIGNAL_WEIGHTS: Final[dict[str, float]] = {
    "style": 0.28,
    "structural": 0.39,
    "semantic": 0.33,
}

#: Duplication bonus: trigger > 0.05, saturates at 0.30, adds at most 0.05.
DUP_BOOST_TRIGGER: Final[float] = 0.05
DUP_BOOST_SATURATION: Final[float] = 0.30
DUP_BOOST_MAX: Final[float] = 0.05

#: Security bonus factor: S_sec ∈ [0, 1] contributes at most 0.50.
SECURITY_BOOST_FACTOR: Final[float] = 0.50

#: Severity weights for a single security finding (numerator).
#: Denominator is the saturation cap 1.0, so S_sec = min(Σ w_i, 1.0).
SEVERITY_WEIGHTS: Final[dict[str, float]] = {
    "CRITICAL": 0.60,
    "HIGH": 0.30,
    "MEDIUM": 0.12,
    "LOW": 0.05,
}

#: Default weight used for an unknown severity label.
SEVERITY_WEIGHT_DEFAULT: Final[float] = 0.05

#: File-level security gates: ``(security score floor, file risk floor)``.
#: Derived from SEVERITY_WEIGHTS: one CRITICAL is 0.60, one HIGH is 0.30.
SECURITY_GATE_FLOORS: Final[tuple[tuple[float, float], ...]] = (
    (SEVERITY_WEIGHTS["CRITICAL"], 0.75),
    (SEVERITY_WEIGHTS["HIGH"], 0.50),
)


def security_gate_floor(security_score: float) -> float:
    """Return the file-risk floor forced by *security_score* (0.0 if none)."""
    for trigger, floor in SECURITY_GATE_FLOORS:
        if security_score >= trigger:
            return floor
    return 0.0


# ---------------------------------------------------------------------------
# Changeset aggregation
# ---------------------------------------------------------------------------

#: Convex combination weights: mean across the changeset plus peak file risk.
CHANGESET_MEAN_WEIGHT: Final[float] = 0.70
CHANGESET_PEAK_WEIGHT: Final[float] = 0.30

#: Deterministic no-dilution gates: ``(peak file risk trigger, risk floor)``.
#: The floors are the canonical band lower bounds, so a changeset can never be
#: reported below the band of its riskiest file for the RED/ORANGE tiers.
DETERMINISTIC_GATE_FLOORS: Final[tuple[tuple[float, float], ...]] = (
    (RISK_BANDS[0].min_score, RISK_BANDS[0].min_score),
    (RISK_BANDS[1].min_score, RISK_BANDS[1].min_score),
)

#: Deterministic evidence text markers that trigger the gates without needing
#: a peak score (case-insensitive substring match on findings). Declared from
#: the highest tier downwards so the first match wins.
DETERMINISTIC_EVIDENCE_MARKERS: Final[tuple[tuple[str, float], ...]] = (
    ("[critical]", RISK_BANDS[0].min_score),
    ("critical security", RISK_BANDS[0].min_score),
    ("[high]", RISK_BANDS[1].min_score),
)

#: Model-audit overlay: ``(finding marker, risk floor)``. Non-decreasing only;
#: the overlay can raise the risk but never dilute it.
MODEL_FINDING_FLOORS: Final[tuple[tuple[str, float], ...]] = (
    ("[critical/", 0.75),
    ("[high/", 0.50),
    ("[medium/", 0.25),
    ("[low/", 0.10),
)


def deterministic_gate_floor(peak_risk: float) -> float:
    """Return the no-dilution floor for a changeset whose peak risk is *peak_risk*."""
    for trigger, floor in DETERMINISTIC_GATE_FLOORS:
        if peak_risk >= trigger:
            return floor
    return 0.0


def deterministic_evidence_floor(findings_lower: list[str] | tuple[str, ...]) -> float:
    """Return the gate floor implied by evidence *text* alone (0.0 if none)."""
    for marker, floor in DETERMINISTIC_EVIDENCE_MARKERS:
        if any(marker in finding for finding in findings_lower):
            return floor
    return 0.0


def model_overlay_floor(findings_lower: list[str] | tuple[str, ...]) -> float:
    """Return the highest model-finding floor present in *findings_lower*."""
    for marker, floor in MODEL_FINDING_FLOORS:
        if any(marker in finding for finding in findings_lower):
            return floor
    return 0.0


# ---------------------------------------------------------------------------
# Rounding policy
# ---------------------------------------------------------------------------


def quantize_risk(value: float) -> float:
    """Round a risk score to :data:`RISK_QUANTUM` decimals (half-even)."""
    return round(value, RISK_QUANTUM)


def overall_score_for_risk(risk: float) -> int:
    """Project a final risk into the 0..100 user-facing score (half-even)."""
    return round((1.0 - max(0.0, min(1.0, risk))) * 100)


# ---------------------------------------------------------------------------
# Workflow evidence severity projection (separate vocabulary)
# ---------------------------------------------------------------------------

#: ``(score floor, workflow severity)``. This vocabulary is
#: ``{high, medium, low, info}`` and is NOT the finding vocabulary
#: ``{CRITICAL, HIGH, MEDIUM, LOW}`` used by analyzers.
WORKFLOW_SEVERITY_FLOOR: Final[tuple[tuple[float, str], ...]] = (
    (RISK_BANDS[0].min_score, "high"),
    (RISK_BANDS[1].min_score, "medium"),
    (RISK_BANDS[2].min_score, "low"),
)
WORKFLOW_SEVERITY_DEFAULT: Final[str] = "info"


def workflow_severity_for_score(score: float) -> str:
    """Map an analyzer score onto the workflow evidence severity vocabulary."""
    for floor, severity in WORKFLOW_SEVERITY_FLOOR:
        if score >= floor:
            return severity
    return WORKFLOW_SEVERITY_DEFAULT


# ---------------------------------------------------------------------------
# Monotonicity declarations (weak vs strict are separate on purpose)
# ---------------------------------------------------------------------------

#: ``"weak"`` = non-decreasing (``x ≤ y ⇒ f(x) ≤ f(y)``); ``"strict"`` holds
#: only while the result is un-saturated and the increment exceeds the quantum.
MONOTONICITY: Final[dict[str, str]] = {
    "file_risk_in_each_signal": "weak; strict while base+boost < 1.0",
    "changeset_risk_in_each_file_score": "weak; strict while un-gated and n > 1",
    "changeset_risk_in_file_set": "not monotone: adding clean files lowers the mean",
    "final_risk_in_deterministic_risk": "weak",
    "final_risk_in_model_overlay": "weak; never decreases risk",
    "overall_score_in_final_risk": "weak; non-increasing",
    "band_level_in_score": "weak",
}

#: Properties that explicitly do NOT hold, recorded so tests can pin them.
NON_MONOTONE_PROPERTIES: Final[tuple[str, ...]] = (
    "changeset_risk_in_file_set",
    "file_risk_in_file_length",
    "dup_boost_continuity",
)

__all__ = [
    "CHANGESET_MEAN_WEIGHT",
    "CHANGESET_PEAK_WEIGHT",
    "DETERMINISTIC_EVIDENCE_MARKERS",
    "DETERMINISTIC_GATE_FLOORS",
    "DUP_BOOST_MAX",
    "DUP_BOOST_SATURATION",
    "DUP_BOOST_TRIGGER",
    "FILE_SIGNAL_WEIGHTS",
    "MODEL_FINDING_FLOORS",
    "MONOTONICITY",
    "NON_MONOTONE_PROPERTIES",
    "PREVIOUS_RULE_VERSION",
    "RISK_BANDS",
    "RISK_QUANTUM",
    "RULE_SPEC_PATH",
    "RULE_VERSION",
    "RULE_VERSION_DATE",
    "RiskBand",
    "RiskColour",
    "RiskLevel",
    "SECURITY_BOOST_FACTOR",
    "SECURITY_GATE_FLOORS",
    "SEVERITY_WEIGHT_DEFAULT",
    "SEVERITY_WEIGHTS",
    "SignalName",
    "WORKFLOW_SEVERITY_DEFAULT",
    "WORKFLOW_SEVERITY_FLOOR",
    "band_for_score",
    "critical_threshold",
    "deterministic_evidence_floor",
    "deterministic_gate_floor",
    "high_threshold",
    "medium_threshold",
    "model_overlay_floor",
    "overall_score_for_risk",
    "quantize_risk",
    "score_to_machine_level",
    "score_to_risk_colour",
    "score_to_risk_label",
    "security_gate_floor",
    "workflow_severity_for_score",
]
