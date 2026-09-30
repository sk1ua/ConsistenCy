"""Step 5: a file without a baseline must never be labelled with a drift band.

The drift analyzers compare the current state against a baseline document. With
no baseline they compare against nothing, and naming the resulting band
("Significant Drift") claims a comparison that never happened.
"""

from __future__ import annotations

from engine.analyzers.base_analyzer import AnalyzerResult
from engine.analyzers.risk_scoring_analyzer import RiskScoringAnalyzer
from engine.models.enums import RISK_BANDS


def _result(name: str, score: float, evidence: tuple[str, ...] = ()) -> AnalyzerResult:
    return AnalyzerResult(
        analyzer_name=name,
        score=score,
        details={},
        evidence=list(evidence),
    )


def test_no_baseline_withholds_the_drift_band_name():
    scorer = RiskScoringAnalyzer()
    results = {"structural": _result("structural", 0.9), "semantic": _result("semantic", 0.8)}

    without = scorer.aggregate(results, has_baseline=False)

    assert without.details["risk_level"] == "No Baseline"
    assert without.details["baseline_comparable"] is False
    assert "Significant Drift" not in " ".join(without.evidence)
    assert all(band.label not in " ".join(without.evidence) for band in RISK_BANDS)


def test_with_a_baseline_the_drift_band_still_applies():
    scorer = RiskScoringAnalyzer()
    results = {"structural": _result("structural", 0.9), "semantic": _result("semantic", 0.8)}

    with_baseline = scorer.aggregate(results, has_baseline=True)

    assert with_baseline.details["risk_level"] != "No Baseline"
    assert with_baseline.details["baseline_comparable"] is True
    assert any(band.label in " ".join(with_baseline.evidence) for band in RISK_BANDS)


def test_default_keeps_the_previous_behaviour():
    """Existing callers that pass no flag keep the baseline-comparable label."""

    scorer = RiskScoringAnalyzer()
    default = scorer.aggregate({"structural": _result("structural", 0.9)})

    assert default.details["risk_level"] != "No Baseline"
