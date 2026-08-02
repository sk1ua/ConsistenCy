"""Ablation configuration helpers for signal contribution studies."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class AblationConfig:
    """One model variant for ablation experiments."""

    name: str
    enabled_signals: tuple[str, ...]
    use_project_specific_baseline: bool = True
    security_override: bool = True


FULL_MODEL = AblationConfig(
    name="full",
    enabled_signals=("style", "structural", "semantic", "duplication", "security", "evolution"),
)

DEFAULT_ABLATIONS = (
    FULL_MODEL,
    AblationConfig("without_structural", ("style", "semantic", "duplication", "security", "evolution")),
    AblationConfig("without_semantic", ("style", "structural", "duplication", "security", "evolution")),
    AblationConfig("without_evolution", ("style", "structural", "semantic", "duplication", "security")),
    AblationConfig("without_security_override", ("style", "structural", "semantic", "duplication", "security", "evolution"), security_override=False),
    AblationConfig("generic_baseline", ("style", "structural", "semantic", "duplication", "security", "evolution"), use_project_specific_baseline=False),
)


FILE_WEIGHTS: dict[str, float] = {
    "style": 0.28,
    "structural": 0.39,
    "semantic": 0.33,
}


def score_file_breakdown(
    breakdown: dict[str, float],
    config: AblationConfig = FULL_MODEL,
) -> float:
    """Re-score one file after removing ablated signals.

    This is a report-level ablation approximation: it reuses already extracted
    signal scores rather than rerunning baseline selection and analyzers.
    """

    enabled = set(config.enabled_signals)
    raw = 0.0
    for signal_name, weight in FILE_WEIGHTS.items():
        if signal_name in enabled:
            raw += weight * float(breakdown.get(signal_name, 0.0))

    if "duplication" in enabled:
        duplication = float(breakdown.get("duplication", 0.0))
        if duplication > 0.05:
            raw += 0.05 * min(duplication / 0.30, 1.0)

    security = float(breakdown.get("security", 0.0)) if "security" in enabled else 0.0
    raw += security * 0.50
    score = max(0.0, min(1.0, raw))

    if config.security_override and "security" in enabled:
        if security >= 0.60:
            score = max(score, 0.75)
        elif security >= 0.30:
            score = max(score, 0.50)
    return round(score, 4)


def ablate_file_ranking(
    report: dict[str, Any],
    config: AblationConfig = FULL_MODEL,
) -> list[dict[str, Any]]:
    """Return top risky files re-ranked under an ablation config."""

    rows: list[dict[str, Any]] = []
    for row in report.get("top_risky_files", []):
        cloned = copy.deepcopy(row)
        cloned["ablated_score"] = score_file_breakdown(
            cloned.get("risk_breakdown", {}),
            config,
        )
        cloned["ablation"] = config.name
        rows.append(cloned)
    rows.sort(
        key=lambda item: (
            float(item.get("ablated_score", 0.0)),
            float(item.get("max_risk", 0.0)),
            int(item.get("hits", 0)),
        ),
        reverse=True,
    )
    return rows


def ablate_report(
    report: dict[str, Any],
    config: AblationConfig = FULL_MODEL,
) -> dict[str, Any]:
    """Build a lightweight ablated PR summary from an existing report."""

    ranked_files = ablate_file_ranking(report, config)
    file_scores = [float(item.get("ablated_score", 0.0)) for item in ranked_files]
    evolution = float(report.get("risk_composition", {}).get("components_avg", {}).get("evolution", 0.0))
    if "evolution" not in set(config.enabled_signals):
        evolution = 0.0
    pr_score = 0.90 * (sum(file_scores) / len(file_scores) if file_scores else 0.0) + 0.10 * evolution
    return {
        "ablation": config.name,
        "enabled_signals": list(config.enabled_signals),
        "use_project_specific_baseline": config.use_project_specific_baseline,
        "security_override": config.security_override,
        "avg_risk": round(pr_score, 4),
        "top_risky_files": ranked_files,
        "note": (
            "Report-level ablation reuses extracted signal scores. The "
            "generic_baseline variant must be rerun with a generic baseline "
            "to measure baseline effects exactly."
        ),
    }
