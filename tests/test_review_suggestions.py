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
                "signal_composition": {
                    "style": 0.10,
                    "structural": 0.20,
                    "semantic": 0.65,
                    "duplication": 0.05,
                    "security": 0.0,
                },
                "dominant_signals": ["semantic", "structural"],
                "confidence": 0.82,
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
                "signal_contributions": {
                    "style": 0.10,
                    "structural": 0.20,
                    "semantic": 0.65,
                    "duplication": 0.05,
                    "security": 0.0,
                },
                "dominant_signals": ["semantic", "structural"],
                "confidence": 0.82,
                "evidence_chain": [
                    {
                        "signal_name": "semantic",
                        "text": "AST structure diverged significantly",
                    },
                    {
                        "signal_name": "semantic",
                        "text": "AST structure diverged significantly",
                    },
                ],
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
        "agent_collaboration": {
            "scope": "pull_request",
            "decision": "review_required",
            "consensus_score": 0.44,
            "confidence": 0.81,
            "quorum": "5/5",
            "participants": [
                "StyleAgent",
                "StructuralAgent",
                "SemanticAgent",
                "DuplicationAgent",
                "SecurityAgent",
            ],
            "protocol": "parallel_agents -> evidence_normalization -> weighted_consensus -> reviewer_handoff",
            "collaboration_value": "Specialist agents review in parallel, then route evidence to humans.",
            "top_findings": [
                {
                    "signal_name": "semantic",
                    "agent_name": "SemanticAgent",
                    "severity": "medium",
                    "evidence": [
                        "tests/test_security_evolution.py: AST structure diverged significantly"
                    ],
                    "recommendation": "Trace changed behavior and API usage.",
                }
            ],
            "review_queue": [
                {
                    "owner": "SemanticAgent",
                    "scope": "tests/test_security_evolution.py",
                    "focus": "control flow and API usage",
                }
            ],
            "disagreements": [],
            "next_actions": ["Run focused review on the top-ranked files before approval."],
        },
        "security_findings": [],
    }


def test_review_comment_contains_explainability_sections():
    report = _sample_report()
    md = generate_review_comment(report)

    assert "Overall PR Risk" in md
    assert "Signal Composition" in md
    assert "PR/commit model" in md
    assert "Normalized contribution" in md
    assert "Highest-Risk Files" in md
    assert "Risk percentile basis" in md
    assert "Evidence Chain" in md
    assert "Top File Deep Dive" in md
    assert "Multi-Agent Consensus" in md
    assert "Board decision" in md
    assert "Suggested reviewer handoff" in md
    assert "Human Review Suggestions" in md
    assert "Risk ranking among PR files" in md
    assert "Estimated review effort" in md
    assert "Dominant signals" in md
    assert "Structural signals" in md
    assert "Semantic signals" in md


def test_review_comment_schema_contract_surfaces_dominant_signal_and_confidence():
    report = _sample_report()
    md = generate_review_comment(report)

    assert "semantic, structural" in md
    assert "Confidence" in md
    assert "`0.82`" in md


def test_review_comment_security_override_not_dropped():
    report = _sample_report()
    report["security_findings"] = [
        {
            "filepath": "app/secrets.py",
            "commit_sha": "deadbeef",
            "evidence": "[CRITICAL] hardcoded credential detected",
        }
    ]

    md = generate_review_comment(report)

    assert "Security Override" in md
    assert "[CRITICAL] hardcoded credential detected" in md
    assert "Block merge" in md


def test_review_comment_evidence_chain_deduplicates_rendered_items():
    report = _sample_report()
    md = generate_review_comment(report)

    assert md.count("[semantic] AST structure diverged significantly") == 1


def test_review_suggestions_knowledge_risk_not_duplicated():
    report = _sample_report()
    md = generate_review_comment(report)
    assert md.count("Knowledge concentration risk") == 1


def test_review_comment_hides_trend_for_single_commit():
    report = _sample_report()
    report["commit_trend"] = [{"sha": "11111111", "risk_score": 0.5, "delta": None, "delta_pct": None}]
    md = generate_review_comment(report)
    assert "Commit Risk Trend" not in md
