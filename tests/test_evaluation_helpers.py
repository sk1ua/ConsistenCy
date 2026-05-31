# -*- coding: utf-8 -*-
"""Evaluation helper contract tests."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import pytest

from src.evaluation.ablation import (  # noqa: E402
    AblationConfig,
    ablate_report,
    score_file_breakdown,
)
from src.evaluation.metrics import (  # noqa: E402
    cohens_kappa,
    precision_at_k,
    recall_at_k,
    spearman_rank_correlation,
    top_k_hit_rate,
)


def test_ranking_metrics_basic_contract():
    predicted = ["a.py", "b.py", "c.py"]
    annotated = ["b.py", "x.py"]

    assert top_k_hit_rate(predicted, annotated, k=2) == 0.5
    assert precision_at_k(predicted, annotated, k=2) == 0.5
    assert recall_at_k(predicted, annotated, k=2) == 0.5
    assert spearman_rank_correlation([1, 2, 3], [1, 2, 3]) == pytest.approx(1.0)
    assert cohens_kappa(["low", "high"], ["low", "medium"]) <= 1.0


def test_ablation_removes_structural_signal():
    breakdown = {
        "style": 0.0,
        "structural": 1.0,
        "semantic": 0.0,
        "duplication": 0.0,
        "security": 0.0,
    }

    full = score_file_breakdown(breakdown)
    no_struct = score_file_breakdown(
        breakdown,
        AblationConfig("without_structural", ("style", "semantic", "duplication", "security", "evolution")),
    )

    assert full > 0.0
    assert no_struct == 0.0


def test_ablate_report_reranks_files():
    report = {
        "risk_composition": {"components_avg": {"evolution": 0.2}},
        "top_risky_files": [
            {
                "file": "a.py",
                "max_risk": 0.5,
                "hits": 1,
                "risk_breakdown": {"style": 0.0, "structural": 1.0, "semantic": 0.0},
            },
            {
                "file": "b.py",
                "max_risk": 0.4,
                "hits": 1,
                "risk_breakdown": {"style": 0.0, "structural": 0.0, "semantic": 1.0},
            },
        ],
    }
    ablated = ablate_report(
        report,
        AblationConfig("without_structural", ("style", "semantic", "duplication", "security", "evolution")),
    )

    assert ablated["top_risky_files"][0]["file"] == "b.py"
