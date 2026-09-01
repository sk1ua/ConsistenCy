"""Canonical analyzer registry and fail-closed execution tests."""

from types import MappingProxyType

import pytest

import engine.analyzers.registry as registry_module
from engine.analyzers.base_analyzer import AnalyzerBase, AnalyzerResult
from engine.analyzers.registry import (
    ANALYZER_REGISTRY,
    DEFAULT_ANALYZER_IDS,
    AnalyzerManifest,
    instantiate_analyzers,
    resolve_analyzer_manifests,
)
from engine.protocol import AnalyzeRequest, FileInput
from engine.runner import run_analysis


EXPECTED_ANALYZER_IDS = ("style", "structural", "semantic", "duplication", "security", "evolution")
EXPECTED_DEFAULT_ANALYZER_IDS = ("style", "structural", "semantic", "duplication", "security")


def _request(analyzer_ids, *, content: str = "value = 1\n") -> AnalyzeRequest:
    return AnalyzeRequest(
        id="req-analyzer-registry",
        files=[FileInput(path="sample.py", content=content, baseline="value = 0\n")],
        options={"analyzers": analyzer_ids},
    )


def test_analyzer_registry_is_an_explicit_read_only_allowlist():
    assert tuple(ANALYZER_REGISTRY) == EXPECTED_ANALYZER_IDS
    assert DEFAULT_ANALYZER_IDS == EXPECTED_DEFAULT_ANALYZER_IDS
    assert all(item.analyzer_id == analyzer_id for analyzer_id, item in ANALYZER_REGISTRY.items())
    assert all(item.to_dict()["version"] for item in ANALYZER_REGISTRY.values())

    with pytest.raises(TypeError):
        ANALYZER_REGISTRY["other"] = ANALYZER_REGISTRY["style"]  # type: ignore[index]


def test_registry_creates_fresh_instances():
    manifests = resolve_analyzer_manifests(["style", "security"])
    first = instantiate_analyzers(manifests)
    second = instantiate_analyzers(manifests)

    assert tuple(first) == ("style", "security")
    assert first["style"].name == "StyleAnalyzer"
    assert first["security"].name == "SecurityAnalyzer"
    assert first["style"] is not second["style"]
    assert first["security"] is not second["security"]


def test_evolution_is_explicitly_available_but_not_a_per_file_default():
    manifests = resolve_analyzer_manifests(["evolution"])
    analyzer = instantiate_analyzers(manifests)["evolution"]

    assert analyzer.name == "EvolutionAnalyzer"
    assert "evolution" not in DEFAULT_ANALYZER_IDS


@pytest.mark.parametrize("requested", ["style", [], ["style", "style"], [" style"]])
def test_registry_rejects_invalid_selections(requested):
    with pytest.raises(ValueError):
        resolve_analyzer_manifests(requested)


def test_run_analysis_rejects_unknown_analyzer_id():
    response = run_analysis(_request(["style", "not-installed"]))

    assert response.ok is False
    assert response.files == []
    assert "Unknown deterministic analyzer ID(s): not-installed" in (response.error or "")
    assert "Allowed analyzer IDs:" in (response.error or "")


class _ExplodingAnalyzer(AnalyzerBase):
    @property
    def name(self) -> str:
        return "ExplodingAnalyzer"

    def analyze(self, snapshot, baseline) -> AnalyzerResult:
        raise RuntimeError("synthetic analyzer failure")


def test_analyzer_exception_fails_the_entire_analysis(monkeypatch):
    manifests = dict(ANALYZER_REGISTRY)
    manifests["exploding"] = AnalyzerManifest(
        analyzer_id="exploding",
        display_name="ExplodingAnalyzer",
        version="test",
        description="Test-only failing analyzer.",
        factory=_ExplodingAnalyzer,
    )
    monkeypatch.setattr(registry_module, "ANALYZER_REGISTRY", MappingProxyType(manifests))

    response = run_analysis(_request(["exploding"]))

    assert response.ok is False
    assert response.files == []
    assert "Deterministic analyzer 'exploding' failed for file 'sample.py'" in (response.error or "")
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
        options={"analyzers": ["style", "security"]},
    )

    response = run_analysis(request)

    assert response.ok is True
    assert [f.path for f in response.files] == ["docs/README.md", "package-lock.json", "sample.py"]
    assert response.files[0].risk_score == 0
