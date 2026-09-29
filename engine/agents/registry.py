"""Deprecated compatibility imports for the deterministic analyzer registry."""
from ..analyzers.registry import (
    ANALYZER_REGISTRY,
    DEFAULT_ANALYZER_IDS,
    AnalyzerManifest,
    instantiate_analyzers,
    resolve_analyzer_manifests,
    AGENT_REGISTRY,
    DEFAULT_AGENT_IDS,
    AgentManifest,
    instantiate_agents,
    resolve_agent_manifests,
)

__all__ = [
    "ANALYZER_REGISTRY", "DEFAULT_ANALYZER_IDS", "AnalyzerManifest",
    "instantiate_analyzers", "resolve_analyzer_manifests",
    "AGENT_REGISTRY", "DEFAULT_AGENT_IDS", "AgentManifest",
    "instantiate_agents", "resolve_agent_manifests",
]
