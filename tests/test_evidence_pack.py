# -*- coding: utf-8 -*-
from __future__ import annotations

from src.retrieval.evidence_pack import build_evidence_pack, build_retrieval_section
from src.retrieval.models import EvidenceCandidate, EvidenceQuery


def test_evidence_pack_respects_context_budget_and_reports_compression():
    query = EvidenceQuery(file="src/auth/session.py", path_terms=["src", "auth"], risk_terms=["security"])
    candidates = [
        EvidenceCandidate(
            id="top",
            file="src/auth/session.py",
            kind="security_hint",
            source="security",
            content="security " + ("validate token " * 80),
        ),
        EvidenceCandidate(
            id="low",
            file="other.py",
            kind="file_snippet",
            source="snippet",
            content="unrelated " * 100,
        ),
    ]

    pack = build_evidence_pack(query, candidates, context_budget_tokens=30, top_k=1)

    assert pack.compression["candidate_count"] == 2
    assert pack.compression["selected_count"] >= 1
    assert pack.compression["estimated_output_tokens"] <= 30
    assert 0 < pack.compression["compression_ratio"] <= 1
    assert pack.discarded_candidates


def test_build_retrieval_section_adds_pack_to_deep_dive_items():
    deep_dive = [
        {
            "file": "apps/api/src/http.ts",
            "risk": 0.6,
            "risk_breakdown": {"security": 0.5},
            "dominant_signals": ["security"],
            "evidence_chain": [{"signal_name": "security", "text": "Route authorization should be reviewed."}],
            "structural_signals": [],
            "semantic_signals": ["HTTP route behavior changed."],
            "code_excerpt": "function requireAuth() {}",
            "diff_excerpt": "+ app.post('/jobs', handler)",
        }
    ]

    retrieval = build_retrieval_section(
        deep_dive,
        security_findings=[{"filepath": "apps/api/src/http.ts", "evidence": "Missing bearer-token guard."}],
        context_budget_tokens=200,
    )

    assert retrieval["strategy"] == "hybrid_path_symbol_signal_callsite_ownership_local_similarity"
    assert retrieval["summary"]["files_with_evidence"] == 1
    assert deep_dive[0]["evidence_pack"]["file"] == "apps/api/src/http.ts"
    assert deep_dive[0]["evidence_pack"]["selected_evidence"]
