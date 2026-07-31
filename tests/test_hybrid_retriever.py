# -*- coding: utf-8 -*-
from __future__ import annotations

from engine.retrieval.hybrid_retriever import retrieve_evidence
from engine.retrieval.models import EvidenceCandidate, EvidenceQuery
from engine.retrieval.reranker import score_candidate


def test_hybrid_retriever_ranks_security_symbol_match_first():
    query = EvidenceQuery(
        file="src/auth/session.py",
        path_terms=["src", "auth", "session"],
        symbol_terms=["validate_token"],
        import_terms=["jwt"],
        risk_terms=["security"],
        metadata={"primary_risk_region": "L20-L25"},
    )
    candidates = [
        EvidenceCandidate(
            id="b",
            file="src/auth/session.py",
            kind="security_hint",
            source="security_findings",
            content="validate_token uses jwt without issuer verification",
        ),
        EvidenceCandidate(
            id="a",
            file="docs/readme.md",
            kind="file_snippet",
            source="docs",
            content="general project notes",
        ),
    ]

    ranked = retrieve_evidence(query, candidates, top_k=2)

    assert ranked[0][0].id == "b"
    assert ranked[0][1].total > ranked[1][1].total
    assert "security evidence receives override boost" in ranked[0][1].reasons


def test_hybrid_retriever_tie_breaks_by_candidate_id():
    query = EvidenceQuery(file="x.py")
    candidates = [
        EvidenceCandidate(id="z", file="other.py", kind="file_snippet", source="s", content="no match"),
        EvidenceCandidate(id="a", file="other.py", kind="file_snippet", source="s", content="no match"),
    ]

    ranked = retrieve_evidence(query, candidates, top_k=2)

    assert [candidate.id for candidate, _score in ranked] == ["a", "z"]


def test_reranker_explains_symbol_and_risk_matches():
    score = score_candidate(
        EvidenceQuery(
            file="src/auth/session.py",
            path_terms=["auth"],
            symbol_terms=["validate_token"],
            risk_terms=["semantic"],
        ),
        EvidenceCandidate(
            id="c",
            file="src/auth/session.py",
            kind="changed_hunk",
            source="diff",
            content="validate_token changed semantic behavior",
        ),
    )

    assert score.total > 0
    assert "matched changed file path" in score.reasons
    assert "matched symbol validate_token" in score.reasons
    assert "overlaps with semantic risk signal" in score.reasons
    assert score.local_similarity > 0
