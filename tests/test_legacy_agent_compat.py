"""Legacy compatibility guarantees for the deterministic analyzer rename.

``engine.agents`` is a deprecated forwarding surface over
``engine.analyzers``. Old embedders, stored results, and the historical
``options["agents"]`` wire key must keep working; these tests pin that
contract so the canonical rename can never silently break it.
"""

import pytest

from engine.protocol import AnalyzeRequest, FileInput
from engine.runner import run_analysis


def test_legacy_class_aliases_point_at_canonical_analyzers():
    from engine.agents import (
        AgentBase,
        AgentManifest,
        AgentResult,
        DuplicationAgent,
        EvolutionAgent,
        ParserAgent,
        RiskScoringAgent,
        SecurityAgent,
        SemanticAgent,
        StyleAgent,
        StructuralAgent,
    )
    from engine.analyzers import (
        AnalyzerBase,
        AnalyzerManifest,
        AnalyzerResult,
        DuplicationAnalyzer,
        EvolutionAnalyzer,
        ParserAnalyzer,
        RiskScoringAnalyzer,
        SecurityAnalyzer,
        SemanticAnalyzer,
        StyleAnalyzer,
        StructuralAnalyzer,
    )

    assert AgentBase is AnalyzerBase
    assert AgentResult is AnalyzerResult
    assert AgentManifest is AnalyzerManifest
    assert ParserAgent is ParserAnalyzer
    assert StyleAgent is StyleAnalyzer
    assert StructuralAgent is StructuralAnalyzer
    assert SemanticAgent is SemanticAnalyzer
    assert EvolutionAgent is EvolutionAnalyzer
    assert DuplicationAgent is DuplicationAnalyzer
    assert SecurityAgent is SecurityAnalyzer
    assert RiskScoringAgent is RiskScoringAnalyzer


def test_legacy_module_level_helpers_remain_importable():
    from engine.agents.parser_agent import ParserAgent, compute_halstead, count_loc
    from engine.agents.structural_agent import _inheritance_depths
    from engine.analyzers.parser_analyzer import (
        compute_halstead as canonical_halstead,
    )
    from engine.analyzers.parser_analyzer import count_loc as canonical_loc
    from engine.analyzers.structural_analyzer import (
        _inheritance_depths as canonical_depths,
    )

    assert compute_halstead is canonical_halstead
    assert count_loc is canonical_loc
    assert _inheritance_depths is canonical_depths
    from engine.analyzers.parser_analyzer import ParserAnalyzer
    assert ParserAgent is ParserAnalyzer


def test_legacy_registry_aliases_remain_importable():
    import engine.agents.registry as legacy_registry
    import engine.analyzers.registry as canonical_registry

    assert legacy_registry.AGENT_REGISTRY is canonical_registry.ANALYZER_REGISTRY
    assert legacy_registry.DEFAULT_AGENT_IDS is canonical_registry.DEFAULT_ANALYZER_IDS
    assert legacy_registry.AgentManifest is canonical_registry.AnalyzerManifest
    assert legacy_registry.resolve_agent_manifests is canonical_registry.resolve_analyzer_manifests
    assert legacy_registry.instantiate_agents is canonical_registry.instantiate_analyzers


def test_legacy_agent_result_keyword_and_property():
    from engine.analyzers.base_analyzer import AnalyzerResult

    legacy = AnalyzerResult(agent_name="StyleAnalyzer", score=0.5)
    assert legacy.analyzer_name == "StyleAnalyzer"
    assert legacy.agent_name == "StyleAnalyzer"
    assert legacy.summary().startswith("[StyleAnalyzer]")

    canonical = AnalyzerResult("StyleAnalyzer", 0.5)
    assert canonical == legacy or (
        canonical.analyzer_name == legacy.analyzer_name
        and canonical.score == legacy.score
    )

    with pytest.raises(ValueError):
        AnalyzerResult("StyleAnalyzer", 0.5, agent_name="OtherAnalyzer")


def test_legacy_manifest_agent_id_keyword_and_property():
    from engine.analyzers.base_analyzer import AnalyzerBase, AnalyzerResult
    from engine.analyzers.registry import AnalyzerManifest

    class _Fixed(AnalyzerBase):
        @property
        def name(self) -> str:
            return "FixedAnalyzer"

        def analyze(self, snapshot, baseline) -> AnalyzerResult:
            return AnalyzerResult(self.name, 0.0)

    manifest = AnalyzerManifest(
        agent_id="fixed",
        display_name="FixedAnalyzer",
        version="1",
        description="legacy keyword construction",
        factory=_Fixed,
    )
    assert manifest.analyzer_id == "fixed"
    assert manifest.agent_id == "fixed"

    with pytest.raises(ValueError):
        AnalyzerManifest(
            analyzer_id="fixed",
            display_name="FixedAnalyzer",
            version="1",
            description="mismatched alias",
            factory=_Fixed,
            agent_id="other",
        )


def test_legacy_agents_wire_key_still_selects_analyzers():
    request = AnalyzeRequest(
        id="req-legacy-wire",
        files=[FileInput(path="sample.py", content="value = 1\n", baseline="value = 0\n")],
        options={"agents": ["style", "security"]},
    )

    response = run_analysis(request)

    assert response.ok is True
    assert "style" in response.files[0].breakdown
    assert "security" in response.files[0].breakdown


def test_canonical_analyzers_wire_key_is_accepted():
    request = AnalyzeRequest(
        id="req-canonical-wire",
        files=[FileInput(path="sample.py", content="value = 1\n", baseline="value = 0\n")],
        options={"analyzers": ["style"]},
    )

    response = run_analysis(request)

    assert response.ok is True
    assert set(response.files[0].breakdown) == {"style"}


def test_conflicting_wire_keys_fail_closed():
    request = AnalyzeRequest(
        id="req-conflict-wire",
        files=[FileInput(path="sample.py", content="value = 1\n", baseline="value = 0\n")],
        options={"agents": ["style"], "analyzers": ["security"]},
    )

    response = run_analysis(request)

    assert response.ok is False
    assert "must contain the same IDs" in (response.error or "")


def test_analyze_sources_projection_covers_legacy_and_canonical():
    from engine import analyze_sources

    result = analyze_sources("def f(x):\n    return x\n", "def f(x):\n    return 0\n")

    assert "analyzer_details" in result
    assert "agent_details" in result
    for analyzer_name in ("StyleAnalyzer", "StructuralAnalyzer", "SemanticAnalyzer", "SecurityAnalyzer"):
        assert analyzer_name in result["analyzer_details"], f"{analyzer_name} missing"
    for legacy_name in ("StyleAgent", "StructuralAgent", "SemanticAgent", "SecurityAgent"):
        assert legacy_name in result["agent_details"], f"{legacy_name} missing"
    assert result["analyzer_details"]["StyleAnalyzer"] is result["agent_details"]["StyleAgent"]


def test_legacy_engine_agent_plugin_alias():
    from engine.workflow.builtins import EngineAgentPlugin, EngineAnalyzerPlugin

    assert EngineAgentPlugin is EngineAnalyzerPlugin


def test_legacy_parser_snapshot_alias():
    from engine.analyzers.parser_analyzer import ParserAnalyzer
    from engine.parsers.base_parser import ParseSnapshot

    snapshot = ParseSnapshot(source="x = 1\n", language="python")
    assert snapshot.to_agent_snapshot() == snapshot.to_analyzer_snapshot()
