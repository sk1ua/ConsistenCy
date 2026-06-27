# -*- coding: utf-8 -*-
from __future__ import annotations

from src.retrieval.evidence_index import build_evidence_candidates
from src.retrieval.query_builder import build_evidence_query


def test_query_builder_extracts_path_symbols_imports_and_risk_terms():
    query = build_evidence_query(
        {
            "file": "src/auth/session.py",
            "risk_breakdown": {"security": 0.4, "semantic": 0.2, "style": 0.0},
            "dominant_signals": ["security"],
            "primary_risk_region": "L12-L16",
        },
        code_excerpt="""
import jwt
from datetime import UTC

class SessionManager:
    def validate_token(self, token):
        return jwt.decode(token)
""",
        diff_excerpt="+ validate_token(token)",
    )

    assert query.file == "src/auth/session.py"
    assert query.path_terms == ["src", "auth", "session"]
    assert "SessionManager" in query.symbol_terms
    assert "validate_token" in query.symbol_terms
    assert "jwt" in query.import_terms
    assert "datetime" in query.import_terms
    assert query.risk_terms[:2] == ["security", "semantic"]
    assert "security" in query.natural_query


def test_query_builder_degrades_to_path_terms_without_code_symbols():
    query = build_evidence_query({"file": "apps/api/src/http.ts", "dominant_signals": []})

    assert query.path_terms == ["apps", "api", "src", "http"]
    assert query.symbol_terms == []
    assert query.import_terms == []
    assert query.natural_query.endswith("apps/api/src/http.ts")


def test_evidence_index_skips_empty_content_and_builds_candidates():
    candidates = build_evidence_candidates(
        {
            "file": "apps/api/src/http.ts",
            "diff_excerpt": "+ app.get('/health')",
            "code_excerpt": "",
            "evidence_chain": [{"signal_name": "security", "text": "Auth guard is absent."}],
            "dominant_signals": ["security"],
            "risk_breakdown": {"security": 0.5},
            "callsite_hints": [
                {
                    "file": "apps/web/src/api/client.ts",
                    "line": 18,
                    "symbol": "createJob",
                    "content": "`createJob` is referenced by the web client.",
                }
            ],
            "ownership_hints": ["Primary owner `alice` accounts for 80% of recent touches."],
        },
        security_findings=[{"filepath": "apps/api/src/http.ts", "evidence": "Route lacks token guard."}],
        evidence_summary=[{"type": "hotspot_impact", "text": "Hotspot impact: 22%"}],
    )

    kinds = {candidate.kind for candidate in candidates}
    assert "changed_hunk" in kinds
    assert "agent_finding" in kinds
    assert "security_hint" in kinds
    assert "history_signal" in kinds
    assert "callsite_hint" in kinds
    assert any(candidate.source == "ownership_history" for candidate in candidates)
    assert all(candidate.content for candidate in candidates)
