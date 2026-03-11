# -*- coding: utf-8 -*-
"""
Risk Scoring Agent
==================
Aggregates the raw scores of all other agents into a single
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

from .base_agent import AgentBase, AgentResult

DEFAULT_WEIGHTS: dict[str, float] = {
    "style": 0.28,
    "structural": 0.39,
    "semantic": 0.33,
}

RISK_LEVELS = [
    (0.75, "RED",    "High Risk"),
    (0.50, "ORANGE", "Significant Drift"),
    (0.25, "YELLOW", "Minor Drift"),
    (0.00, "GREEN",  "Consistent"),
]


def _risk_label(score: float) -> tuple[str, str]:
    for threshold, colour, label in RISK_LEVELS:
        if score >= threshold:
            return colour, label
    return "GREEN", "Consistent"


class RiskScoringAgent(AgentBase):
    """Aggregate all agent results into a final risk score.

    Usage
    -----
    agent_results is a dict mapping agent names to AgentResult objects.
    The keys expected are (case-insensitive prefix matching):
        "style", "structural", "semantic", "evolution", "duplication"
    """

    def __init__(self, weights: dict[str, float] | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self.weights = weights or DEFAULT_WEIGHTS.copy()

    @property
    def name(self) -> str:
        return "RiskScoringAgent"

    def aggregate(
        self,
        agent_results: dict[str, "AgentResult"],  # noqa: F821
    ) -> AgentResult:
        """Compute the final risk score from pre-run agent results."""

        def _find(prefix: str) -> float:
            for key, res in agent_results.items():
                if key.lower().startswith(prefix):
                    return res.score
            return 0.0

        style_score = _find("style")
        structural_score = _find("structural")
        semantic_score = _find("semantic")
        dup_score = _find("duplication")
        security_score = _find("security")

        # Evolution is NOT included here — it is blended at commit level
        # in AnalysisPipeline.analyze_commit() as:
        #   final = 0.90 * mean(file_scores) + 0.10 * evolution_score
        raw = (
            self.weights.get("style", 0.28) * style_score
            + self.weights.get("structural", 0.39) * structural_score
            + self.weights.get("semantic", 0.33) * semantic_score
        )

        # Optional duplication boost
        dup_boost = 0.05 * min(dup_score / 0.30, 1.0) if dup_score > 0.05 else 0.0
        # Security is additive: each finding contributes directly
        security_boost = security_score * 0.50  # max +0.50 from security alone
        combined = self.clamp(raw + dup_boost + security_boost)

        # Security override: critical/high findings floor the final risk level
        if security_score >= 0.60:   # CRITICAL finding present
            final_score = max(combined, 0.75)
        elif security_score >= 0.30:  # HIGH finding present
            final_score = max(combined, 0.50)
        else:
            final_score = combined
        final_score = self.clamp(final_score)

        colour, label = _risk_label(final_score)

        # Collect all evidence strings in priority order
        all_evidence: list[str] = []
        for prefix in ("structural", "semantic", "style", "duplication"):
            for key, res in agent_results.items():
                if key.lower().startswith(prefix):
                    all_evidence.extend(res.evidence[:2])

        details = {
            "breakdown": {
                "style": round(style_score, 4),
                "structural": round(structural_score, 4),
                "semantic": round(semantic_score, 4),
                "duplication": round(dup_score, 4),
                "security": round(security_score, 4),
            },
            "dup_boost": round(dup_boost, 4),
            "security_boost": round(security_boost, 4),
            "risk_level": label,
            "risk_colour": colour,
            "weights_used": self.weights,
        }

        return AgentResult(
            agent_name=self.name,
            score=final_score,
            details=details,
            evidence=[f"[{colour}] {label}  (score={final_score:.3f})"] + all_evidence,
        )

    # AgentBase requires this — delegate to aggregate with empty results
    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:  # noqa: D401
        """Not typically called directly; use aggregate() instead."""
        return self.aggregate({})
