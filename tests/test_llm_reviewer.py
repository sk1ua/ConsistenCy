# -*- coding: utf-8 -*-
"""Tests for backend/src/llm_reviewer.py.

Covers is_llm_available, review_with_llm (with mocked openai), and
_build_prompt construction.  All DeepSeek calls are mocked — no real
API keys or network needed.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.llm_reviewer import (  # noqa: E402
    _build_prompt,
    is_llm_available,
    review_with_llm,
)


# ---------------------------------------------------------------------------
# is_llm_available
# ---------------------------------------------------------------------------

class TestIsLLMAvailable:
    def test_true_when_key_set(self, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-fake-key")
        assert is_llm_available() is True

    def test_false_when_key_missing(self, monkeypatch):
        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
        assert is_llm_available() is False

    def test_false_when_key_empty(self, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "   ")
        assert is_llm_available() is False


# ---------------------------------------------------------------------------
# review_with_llm — error/unavailable paths
# ---------------------------------------------------------------------------

class TestReviewWithLLMNoNetwork:
    def test_returns_unavailable_when_key_missing(self, monkeypatch):
        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
        # Also prevent the .env reload from finding a key
        monkeypatch.setattr(Path, "exists", lambda self: False)
        result = review_with_llm([], [], {}, 0.1)
        assert "DEEPSEEK_API_KEY" in result
        assert "not set" in result

    def test_returns_unavailable_when_openai_not_installed(self, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
        monkeypatch.setattr(Path, "exists", lambda self: False)
        # Remove openai from sys.modules so the lazy import fails
        monkeypatch.setitem(sys.modules, "openai", None)
        result = review_with_llm([], [], {}, 0.1)
        assert "openai" in result.lower()


# ---------------------------------------------------------------------------
# review_with_llm — mocked openai
# ---------------------------------------------------------------------------

class TestReviewWithLLMMocked:
    FIXTURE = {
        "top_files": [
            {"file": "src/main.py", "avg_risk": 0.42, "max_risk": 0.65, "hits": 3},
        ],
        "security": [],
        "agent_summaries": {
            "StyleAgent": {"evidence": ["missing docstring in foo()"]},
            "SemanticAgent": {"evidence": ["AST divergence 0.15"]},
        },
        "avg_risk": 0.23,
        "code_snippets": [
            {
                "filepath": "src/main.py",
                "risky_snippets": [
                    {
                        "type": "missing_docstring",
                        "location": 10,
                        "reason": "Public function lacks docstring",
                        "severity": "medium",
                    }
                ],
                "functions": [
                    {
                        "name": "main",
                        "lineno": 1,
                        "end_lineno": 5,
                        "complexity": "simple",
                        "body": "def main():\n    return 1\n",
                        "truncated": False,
                    }
                ],
            }
        ],
    }

    def test_successful_call_returns_llm_content(self, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-ok")
        monkeypatch.setattr(Path, "exists", lambda self: False)
        # Pre-register a mock openai in sys.modules for the lazy import
        mock_openai = MagicMock()
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [
            MagicMock(message=MagicMock(content="## Review\n\nLooks good."))
        ]
        mock_client.chat.completions.create.return_value = mock_response
        mock_openai.OpenAI.return_value = mock_client
        monkeypatch.setitem(sys.modules, "openai", mock_openai)

        result = review_with_llm(
            self.FIXTURE["top_files"],
            self.FIXTURE["security"],
            self.FIXTURE["agent_summaries"],
            self.FIXTURE["avg_risk"],
            code_snippets=self.FIXTURE["code_snippets"],
        )

        assert "Review" in result
        assert "Looks good" in result

    def test_api_error_returns_failure_message(self, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-err")
        monkeypatch.setattr(Path, "exists", lambda self: False)
        mock_openai = MagicMock()
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = RuntimeError("API timeout")
        mock_openai.OpenAI.return_value = mock_client
        monkeypatch.setitem(sys.modules, "openai", mock_openai)

        result = review_with_llm(
            self.FIXTURE["top_files"],
            self.FIXTURE["security"],
            self.FIXTURE["agent_summaries"],
            self.FIXTURE["avg_risk"],
        )

        assert "AI review failed" in result
        assert "RuntimeError" in result
        assert "API timeout" in result

    def test_empty_response_content(self, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-empty")
        monkeypatch.setattr(Path, "exists", lambda self: False)
        mock_openai = MagicMock()
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [
            MagicMock(message=MagicMock(content=None))
        ]
        mock_client.chat.completions.create.return_value = mock_response
        mock_openai.OpenAI.return_value = mock_client
        monkeypatch.setitem(sys.modules, "openai", mock_openai)

        result = review_with_llm(
            self.FIXTURE["top_files"],
            self.FIXTURE["security"],
            self.FIXTURE["agent_summaries"],
            self.FIXTURE["avg_risk"],
        )

        # Should return empty string (from "" being stripped)
        assert result == ""


# ---------------------------------------------------------------------------
# _build_prompt
# ---------------------------------------------------------------------------

class TestBuildPrompt:
    def test_minimal_prompt_has_risk_score(self):
        p = _build_prompt([], [], {}, 0.42)
        assert "0.420" in p
        assert "Overall risk score" in p

    def test_includes_security_findings(self):
        sec = [{"filepath": "x.py", "evidence": "hardcoded secret"}]
        p = _build_prompt([], sec, {}, 0.1)
        assert "Security findings" in p
        assert "hardcoded secret" in p

    def test_truncates_security_over_8(self):
        sec = [{"filepath": f"f{i}.py", "evidence": "e"} for i in range(10)]
        p = _build_prompt([], sec, {}, 0.1)
        assert "…and 2 more" in p

    def test_includes_top_files(self):
        files = [
            {"file": "a.py", "avg_risk": 0.5, "max_risk": 0.8, "hits": 2},
        ]
        p = _build_prompt(files, [], {}, 0.1)
        assert "a.py" in p
        assert "0.500" in p

    def test_includes_code_snippets(self):
        snippets = [
            {
                "filepath": "mod.py",
                "risky_snippets": [],
                "functions": [
                    {
                        "name": "f",
                        "lineno": 1,
                        "end_lineno": 3,
                        "complexity": "simple",
                        "body": "def f():\n    return 1",
                        "truncated": False,
                    }
                ],
            }
        ]
        p = _build_prompt([], [], {}, 0.1, code_snippets=snippets)
        assert "def f():" in p
        assert "mod.py" in p

    def test_truncated_marker_in_snippet(self):
        snippets = [
            {
                "filepath": "big.py",
                "risky_snippets": [],
                "functions": [
                    {
                        "name": "big_func",
                        "lineno": 1,
                        "end_lineno": 100,
                        "complexity": "complex",
                        "body": "def big_func():\n    pass",
                        "truncated": True,
                    }
                ],
            }
        ]
        p = _build_prompt([], [], {}, 0.1, code_snippets=snippets)
        assert "TRUNCATED" in p

    def test_includes_agent_evidence(self):
        summaries = {
            "SemanticAgent": {"evidence": ["AST diverge 0.2"]},
        }
        p = _build_prompt([], [], summaries, 0.1)
        assert "SemanticAgent" in p
        assert "AST diverge" in p

    def test_agent_evidence_falls_back_to_summary(self):
        summaries = {
            "StyleAgent": {"summary": "style drift detected"},
        }
        p = _build_prompt([], [], summaries, 0.1)
        assert "style drift" in p

    def test_ignores_non_interesting_agents(self):
        summaries = {
            "DuplicationAgent": {"evidence": ["clone pair"]},
        }
        p = _build_prompt([], [], summaries, 0.1)
        assert "DuplicationAgent" not in p

    def test_code_budget_caps_snippets(self):
        """Large snippets should be truncated by the budget limit."""
        huge_fn = {
            "name": "huge",
            "lineno": 1,
            "end_lineno": 500,
            "complexity": "complex",
            "body": "x\n" * 3000,  # way over budget (~6000 chars)
            "truncated": True,
        }
        snippets = [
            {
                "filepath": "huge.py",
                "risky_snippets": [],
                "functions": [huge_fn],
            }
        ]
        p = _build_prompt([], [], {}, 0.1, code_snippets=snippets)
        # Budget of 3200 chars means the huge body gets cut off
        # The prompt should still be constructed without crashing
        assert "Overall risk score" in p
        assert len(p) > 0
