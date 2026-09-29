"""Deprecated compatibility package for ``engine.analyzers``.

Use ``engine.analyzers`` for all new deterministic analysis code. The old
imports remain available for embedders that have not migrated yet.
"""
from ..analyzers import (
    AnalyzerBase,
    AnalyzerResult,
    AnalyzerManifest,
    ANALYZER_REGISTRY,
    DEFAULT_ANALYZER_IDS,
    DuplicationAnalyzer,
    EvolutionAnalyzer,
    ParserAnalyzer,
    RiskScoringAnalyzer,
    SecurityAnalyzer,
    SemanticAnalyzer,
    StructuralAnalyzer,
    StyleAnalyzer,
    instantiate_analyzers,
    resolve_analyzer_manifests,
)

AgentBase = AnalyzerBase
AgentResult = AnalyzerResult
AgentManifest = AnalyzerManifest
AGENT_REGISTRY = ANALYZER_REGISTRY
DEFAULT_AGENT_IDS = DEFAULT_ANALYZER_IDS
instantiate_agents = instantiate_analyzers
resolve_agent_manifests = resolve_analyzer_manifests
ParserAgent = ParserAnalyzer
StyleAgent = StyleAnalyzer
StructuralAgent = StructuralAnalyzer
SemanticAgent = SemanticAnalyzer
EvolutionAgent = EvolutionAnalyzer
DuplicationAgent = DuplicationAnalyzer
SecurityAgent = SecurityAnalyzer
RiskScoringAgent = RiskScoringAnalyzer

__all__ = [
    "AnalyzerBase", "AnalyzerResult", "AnalyzerManifest", "ANALYZER_REGISTRY",
    "DEFAULT_ANALYZER_IDS", "instantiate_analyzers", "resolve_analyzer_manifests",
    "ParserAnalyzer", "StyleAnalyzer", "StructuralAnalyzer", "SemanticAnalyzer",
    "EvolutionAnalyzer", "DuplicationAnalyzer", "SecurityAnalyzer", "RiskScoringAnalyzer",
    "AgentBase", "AgentResult", "AgentManifest", "AGENT_REGISTRY", "DEFAULT_AGENT_IDS",
    "instantiate_agents", "resolve_agent_manifests", "ParserAgent", "StyleAgent",
    "StructuralAgent", "SemanticAgent", "EvolutionAgent", "DuplicationAgent",
    "SecurityAgent", "RiskScoringAgent",
]
