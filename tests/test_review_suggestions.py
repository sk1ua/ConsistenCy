# -*- coding: utf-8 -*-
"""
review_suggestions 输出测试
============================
验证 PR 评论内容的可解释性增强与建议去重逻辑。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.review_suggestions import generate_review_comment


def _sample_report() -> dict:
    return {
        "commit_count": 2,
        "avg_risk": 0.42,
        "max_risk": 0.68,
        "high_risk_commits": 0,
        "risk_composition": {
            "formula": "commit_risk = 0.90*mean(file_risk) + 0.10*evolution",
            "file_formula": "file_risk = 0.28*style + 0.39*structural + 0.33*semantic + duplication/security adjustments",
            "contributions_pct": {
                "semantic": 0.27,
                "structural": 0.15,
                "duplication": 0.10,
                "style": 0.02,
                "evolution": 0.43,
                "security": 0.03,
            },
            "percentile_basis": "within_pr_files",
            "components_avg": {
                "style": 0.11,
                "structural": 0.23,
                "semantic": 0.31,
                "duplication": 0.02,
                "security": 0.0,
                "evolution": 0.18,
            },
        },
        "top_risky_files": [
            {
                "file": "tests/test_security_evolution.py",
                "avg_risk": 0.651,
                "max_risk": 0.651,
                "hits": 1,
                "risk_percentile": 1.0,
                "churn_lines": 120,
                "complexity": 3.4,
                "owner": "Sk1ua",
                "owner_share": 1.0,
                "risk_breakdown": {
                    "style": 0.08,
                    "structural": 0.19,
                    "semantic": 0.47,
                    "duplication": 0.03,
                    "security": 0.0,
                },
            }
        ],
        "commits": [
            {
                "sha": "11111111",
                "author": "Sk1ua",
                "risk_score": 0.50,
                "risk_level": "Significant Drift",
                "message": "c1",
                "evolution_evidence": [
                    "Bus-factor risk: 80% of files owned by a single author",
                ],
            },
            {
                "sha": "22222222",
                "author": "Sk1ua",
                "risk_score": 0.42,
                "risk_level": "Minor Drift",
                "message": "c2",
                "evolution_evidence": [
                    "Bus-factor risk: 78% of files owned by a single author",
                ],
            },
        ],
        "commit_trend": [
            {"sha": "11111111", "risk_score": 0.50, "delta": None, "delta_pct": None},
            {"sha": "22222222", "risk_score": 0.42, "delta": -0.08, "delta_pct": -0.16},
        ],
        "evidence_summary": [
            {
                "type": "churn_anomaly",
                "text": "Code churn: baseline 2000 → current 300 lines/commit",
                "baseline": 2000,
                "current": 300,
                "delta": -1700,
                "delta_pct": -0.85,
            }
        ],
        "file_deep_dive": [
            {
                "file": "tests/test_security_evolution.py",
                "risk": 0.651,
                "rank_in_pr": 1,
                "total_pr_files": 8,
                "risk_breakdown": {
                    "style": 0.08,
                    "structural": 0.19,
                    "semantic": 0.47,
                    "duplication": 0.03,
                    "security": 0.0,
                },
                "risky_lines": [18, 35],
                "primary_risk_region": "L18-L35",
                "estimated_review_effort": "5-8 minutes",
                "structural_signals": [
                    "new test module added",
                    "assertion chain complexity increased",
                ],
                "semantic_signals": [
                    "AST structure diverged significantly",
                ],
                "code_excerpt": "  14: def x():\n  15:     return 1",
                "diff_excerpt": "@@ -1,1 +1,2 @@\n+def x():\n+    return 1",
            }
        ],
        "security_findings": [],
    }


def test_review_comment_contains_explainability_sections():
    report = _sample_report()
    md = generate_review_comment(report)

    assert "Risk Formula" in md
    assert "Risk Contribution (normalized)" in md
    assert "Highest Risk Files" in md
    assert "Risk %ile basis" in md
    assert "Commit Risk Trend" in md
    assert "Evidence Chain (deduplicated)" in md
    assert "Top File Deep Dive" in md
    assert "Risk ranking among PR files" in md
    assert "Estimated review effort" in md
    assert "Structural signals" in md
    assert "Semantic signals" in md


def test_review_suggestions_knowledge_risk_not_duplicated():
    report = _sample_report()
    md = generate_review_comment(report)
    assert md.count("Knowledge concentration risk") == 1


def test_review_comment_hides_trend_for_single_commit():
    report = _sample_report()
    report["commit_trend"] = [{"sha": "11111111", "risk_score": 0.5, "delta": None, "delta_pct": None}]
    md = generate_review_comment(report)
    assert "Commit Risk Trend" not in md
