# -*- coding: utf-8 -*-
"""
Risk Scoring Agent
==================
Aggregates the raw scores of all other analyzers into a single
**consistency_risk_score ∈ [0, 1]** and generates a human-readable
evidence chain.

Scoring formula (default weights)
----------------------------------
    file_risk =
        0.28 · style_drift
        + 0.39 · structural_drift
        + 0.33 · semantic_drift

    (Evolution is blended at commit-level only:
     final = 0.90 · mean(file_risks) + 0.10 · evolution_anomaly)

Optional duplication bonus: if dup_score > 0.05, the final score
receives a small boost to reflect technical-debt accumulation.

Security override: security findings are additive on top of the weighted
sum and can force the final score to higher risk thresholds:
    any HIGH security finding  → final score ≥ 0.50 (ORANGE)
    any CRITICAL security finding → final score ≥ 0.75 (RED)

Risk levels
-----------
    [0.00, 0.25)  → GREEN   "Consistent"
    [0.25, 0.50)  → YELLOW  "Minor drift"
    [0.50, 0.75)  → ORANGE  "Significant drift"
    [0.75, 1.00]  → RED     "High risk"
"""
from __future__ import annotations

from typing import Any

from .base_analyzer import AnalyzerBase, AnalyzerResult

from ..models import score_to_risk_colour, score_to_risk_label

DEFAULT_WEIGHTS: dict[str, float] = {
    "style": 0.28,
    "structural": 0.39,
    "semantic": 0.33,
}


class RiskScoringAnalyzer(AnalyzerBase):
    """Aggregate all analyzer results into a final risk score.

    Usage
    -----
    analyzer_results is a dict mapping analyzer names to AnalyzerResult objects.
    The keys expected are (case-insensitive prefix matching):
        "style", "structural", "semantic", "evolution", "duplication"
    """

    def __init__(self, weights: dict[str, float] | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self.weights = weights or DEFAULT_WEIGHTS.copy()

    @property
    def name(self) -> str:
        return "RiskScoringAnalyzer"

    def aggregate(
        self,
        analyzer_results: dict[str, "AnalyzerResult"],  # noqa: F821
    ) -> AnalyzerResult:
        """Compute the final risk score from pre-run analyzer results."""

        def _find(prefix: str) -> float:
            for key, res in analyzer_results.items():
                if key.lower().startswith(prefix):
                    return res.score
            return 0.0

        # Extract raw scores into breakdown dict for compose_file_risk
        breakdown = {
            "style": _find("style"),
            "structural": _find("structural"),
            "semantic": _find("semantic"),
            "duplication": _find("duplication"),
            "security": _find("security"),
        }
        # Evolution is NOT included — it is blended at commit level:
        #   final = 0.90 * mean(file_scores) + 0.10 * evolution_score
        from ..scoring.composer import compose_file_risk
        final_score = compose_file_risk(breakdown, weights=self.weights)

        colour = score_to_risk_colour(final_score)
        label = score_to_risk_label(final_score)

        # Collect all evidence strings in priority order
        all_evidence: list[str] = []
        for prefix in ("structural", "semantic", "style", "duplication"):
            for key, res in analyzer_results.items():
                if key.lower().startswith(prefix):
                    all_evidence.extend(res.evidence[:2])

        details = {
            "breakdown": {k: round(v, 4) for k, v in breakdown.items()},
            "dup_boost": round(0.05 * min(breakdown["duplication"] / 0.30, 1.0)
                              if breakdown["duplication"] > 0.05 else 0.0, 4),
            "security_boost": round(breakdown["security"] * 0.50, 4),
            "risk_level": label,
            "risk_colour": colour,
            "weights_used": self.weights,
        }

        return AnalyzerResult(
            analyzer_name=self.name,
            score=final_score,
            details=details,
            evidence=[f"[{colour}] {label}  (score={final_score:.3f})"] + all_evidence,
        )

    # AnalyzerBase requires this — delegate to aggregate with empty results
    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AnalyzerResult:  # noqa: D401
        """Not typically called directly; use aggregate() instead."""
        return self.aggregate({})
