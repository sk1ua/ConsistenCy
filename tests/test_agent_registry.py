"""Explicit-agent registry and fail-closed execution tests."""

from types import MappingProxyType

import pytest

import engine.agents.registry as registry_module
from engine.agents.base_agent import AgentBase, AgentResult
from engine.agents.registry import (
    AGENT_REGISTRY,
    DEFAULT_AGENT_IDS,
    AgentManifest,
    instantiate_agents,
    resolve_agent_manifests,
)
from engine.protocol import AnalyzeRequest, FileInput
from engine.runner import run_analysis


EXPECTED_AGENT_IDS = ("style", "structural", "semantic", "duplication", "security")


def _request(agent_ids, *, content: str = "value = 1\n") -> AnalyzeRequest:
    return AnalyzeRequest(
        id="req-agent-registry",
        files=[FileInput(path="sample.py", content=content, baseline="value = 0\n")],
        options={"agents": agent_ids},
    )


def test_agent_registry_is_an_explicit_read_only_allowlist():
    assert tuple(AGENT_REGISTRY) == EXPECTED_AGENT_IDS
    assert DEFAULT_AGENT_IDS == EXPECTED_AGENT_IDS
    assert all(item.agent_id == agent_id for agent_id, item in AGENT_REGISTRY.items())
    assert all(item.to_dict()["version"] for item in AGENT_REGISTRY.values())

    with pytest.raises(TypeError):
        AGENT_REGISTRY["other"] = AGENT_REGISTRY["style"]  # type: ignore[index]


def test_registry_creates_fresh_instances():
    manifests = resolve_agent_manifests(["style", "security"])
    first = instantiate_agents(manifests)
    second = instantiate_agents(manifests)

    assert tuple(first) == ("style", "security")
    assert first["style"].name == "StyleAgent"
    assert first["security"].name == "SecurityAgent"
    assert first["style"] is not second["style"]
    assert first["security"] is not second["security"]


@pytest.mark.parametrize("requested", ["style", [], ["style", "style"], [" style"]])
def test_registry_rejects_invalid_selections(requested):
    with pytest.raises(ValueError):
        resolve_agent_manifests(requested)


def test_run_analysis_rejects_unknown_agent_id():
    response = run_analysis(_request(["style", "not-installed"]))

    assert response.ok is False
    assert response.files == []
    assert "Unknown deterministic agent ID(s): not-installed" in (response.error or "")
    assert "Allowed agent IDs:" in (response.error or "")


class _ExplodingAgent(AgentBase):
    @property
    def name(self) -> str:
        return "ExplodingAgent"

    def analyze(self, snapshot, baseline) -> AgentResult:
        raise RuntimeError("synthetic analyzer failure")


def test_agent_exception_fails_the_entire_analysis(monkeypatch):
    manifests = dict(AGENT_REGISTRY)
    manifests["exploding"] = AgentManifest(
        agent_id="exploding",
        display_name="ExplodingAgent",
        version="test",
        description="Test-only failing analyzer.",
        factory=_ExplodingAgent,
    )
    monkeypatch.setattr(registry_module, "AGENT_REGISTRY", MappingProxyType(manifests))

    response = run_analysis(_request(["exploding"]))

    assert response.ok is False
    assert response.files == []
    assert "Deterministic agent 'exploding' failed for file 'sample.py'" in (response.error or "")
    assert "synthetic analyzer failure" in (response.error or "")


def test_parser_error_fails_closed_instead_of_returning_low_risk():
    response = run_analysis(_request(["style"], content="def broken(:"))

    assert response.ok is False
    assert response.files == []
    assert "Parser failed for current file 'sample.py'" in (response.error or "")


def test_non_code_files_are_not_forced_through_python_parser():
    """Files without a code language (markdown, json, lock) must not fail the
    whole analysis: they have no AST and "parsing failure" is not evidence."""
    markdown_content = "## Summary\n\n- [ ] checkbox\n"
    request = AnalyzeRequest(
        id="req-non-code",
        files=[
            FileInput(path="docs/README.md", content=markdown_content),
            FileInput(path="package-lock.json", content='{"name": "x"}'),
            FileInput(path="sample.py", content="value = 1\n"),
        ],
        options={"agents": ["style", "security"]},
    )

    response = run_analysis(request)

    assert response.ok is True
    assert [f.path for f in response.files] == ["docs/README.md", "package-lock.json", "sample.py"]
    assert response.files[0].risk_score == 0
