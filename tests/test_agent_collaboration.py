# -*- coding: utf-8 -*-
"""Multi-agent collaboration contract tests."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.collaboration import build_file_consensus, build_pr_consensus


def test_file_consensus_routes_security_override():
    consensus = build_file_consensus(
        {
            "SemanticAgent": {
                "score": 0.20,
                "evidence": ["API usage changed"],
            },
            "SecurityAgent": {
                "score": 0.65,
                "evidence": ["[CRITICAL] hardcoded token detected"],
            },
        },
        {
            "semantic": 0.20,
            "security": 0.65,
        },
        confidence=0.80,
        filepath="app/config.py",
    )

    assert consensus["decision"] == "block_merge"
    assert consensus["quorum"] == "5/5"
    assert "SecurityAgent" in consensus["participants"]
    assert consensus["top_findings"][0]["signal_name"] == "security"
    assert any(item["owner"] == "SecurityAgent" for item in consensus["review_queue"])


def test_pr_consensus_builds_review_queue_from_top_files():
    file_consensus = build_file_consensus(
        {
            "StructuralAgent": {
                "score": 0.52,
                "evidence": ["Dependency surface increased"],
            },
            "SemanticAgent": {
                "score": 0.48,
                "evidence": ["Control flow changed"],
            },
        },
        {"structural": 0.52, "semantic": 0.48},
        confidence=0.70,
        filepath="src/service.py",
    )

    pr = build_pr_consensus(
        [
            {
                "file": "src/service.py",
                "avg_risk": 0.55,
                "rank_in_pr": 1,
                "dominant_signals": ["structural", "semantic"],
                "agent_collaboration": file_consensus,
            }
        ],
        commit_entries=[{"sha": "abc12345"}],
        security_findings=[],
    )

    assert pr["scope"] == "pull_request"
    assert pr["decision"] in {"review_required", "request_changes"}
    assert pr["review_queue"][0]["scope"] == "src/service.py"
    assert "collaboration_value" in pr
