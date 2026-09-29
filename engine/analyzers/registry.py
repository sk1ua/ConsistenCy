"""Allowlist and manifests for deterministic analyzers.

The IDs remain stable because they are part of the JSON-over-stdio contract.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

from .base_analyzer import AnalyzerBase
from .duplication_analyzer import DuplicationAnalyzer
from .evolution_analyzer import EvolutionAnalyzer
from .security_analyzer import SecurityAnalyzer
from .semantic_analyzer import SemanticAnalyzer
from .structural_analyzer import StructuralAnalyzer
from .style_analyzer import StyleAnalyzer


@dataclass(frozen=True, init=False, slots=True)
class AnalyzerManifest:
    """Versioned metadata and factory for one allowlisted analyzer.

    ``agent_id`` is accepted as a deprecated constructor keyword because
    manifests can be supplied by older Python embedders.
    """

    analyzer_id: str
    display_name: str
    version: str
    description: str
    factory: Callable[[], AnalyzerBase] = field(repr=False, compare=False)

    def __init__(
        self,
        analyzer_id: str | None = None,
        display_name: str = "",
        version: str = "",
        description: str = "",
        factory: Callable[[], AnalyzerBase] | None = None,
        *,
        agent_id: str | None = None,
    ) -> None:
        if analyzer_id is None:
            analyzer_id = agent_id
        elif agent_id is not None and analyzer_id != agent_id:
            raise ValueError("analyzer_id and legacy agent_id must match")
        if not analyzer_id:
            raise TypeError("AnalyzerManifest requires analyzer_id")
        if factory is None:
            raise TypeError("AnalyzerManifest requires factory")
        object.__setattr__(self, "analyzer_id", analyzer_id)
        object.__setattr__(self, "display_name", display_name)
        object.__setattr__(self, "version", version)
        object.__setattr__(self, "description", description)
        object.__setattr__(self, "factory", factory)

    @property
    def agent_id(self) -> str:
        """Deprecated compatibility alias for the stable analyzer ID."""
        return self.analyzer_id

    def create(self) -> AnalyzerBase:
        analyzer = self.factory()
        if not isinstance(analyzer, AnalyzerBase):
            raise TypeError(
                f"Factory for analyzer '{self.analyzer_id}' returned an invalid instance"
            )
        if analyzer.name != self.display_name:
            raise ValueError(
                f"Manifest '{self.analyzer_id}' declares '{self.display_name}' "
                f"but factory returned '{analyzer.name}'"
            )
        return analyzer

    def to_dict(self) -> dict[str, str]:
        return {
            "analyzer_id": self.analyzer_id,
            "display_name": self.display_name,
            "version": self.version,
            "description": self.description,
        }


# Stable IDs are protocol values, not LLM agent names.
def _manifest(
    analyzer_id: str,
    analyzer_type: type[AnalyzerBase],
    description: str,
) -> AnalyzerManifest:
    return AnalyzerManifest(analyzer_id, analyzer_type().name, "1", description, analyzer_type)


_MANIFESTS = {
    "style": _manifest("style", StyleAnalyzer, "Style drift."),
    "structural": _manifest("structural", StructuralAnalyzer, "Structural drift."),
    "semantic": _manifest("semantic", SemanticAnalyzer, "Semantic change proxies."),
    "duplication": _manifest("duplication", DuplicationAnalyzer, "Code-clone detection."),
    "security": _manifest("security", SecurityAnalyzer, "Static security checks."),
    # Evolution consumes commit-history snapshots rather than one source file.
    "evolution": _manifest(
        "evolution",
        EvolutionAnalyzer,
        "Commit-history churn, hotspot, ownership, and bus-factor signals.",
    ),
}

ANALYZER_REGISTRY: Mapping[str, AnalyzerManifest] = MappingProxyType(_MANIFESTS)
DEFAULT_ANALYZER_IDS: tuple[str, ...] = tuple(
    analyzer_id for analyzer_id in ANALYZER_REGISTRY if analyzer_id != "evolution"
)


def resolve_analyzer_manifests(requested_analyzers: object) -> tuple[AnalyzerManifest, ...]:
    """Validate stable analyzer IDs against the explicit allowlist."""

    if not isinstance(requested_analyzers, list) or not requested_analyzers:
        raise ValueError("'analyzers' must be a non-empty list of deterministic analyzer IDs")
    if any(
        not isinstance(analyzer_id, str)
        or not analyzer_id
        or analyzer_id.strip() != analyzer_id
        for analyzer_id in requested_analyzers
    ):
        raise ValueError("'analyzers' must contain only non-blank, normalized string IDs")

    duplicates = sorted({item for item in requested_analyzers if requested_analyzers.count(item) > 1})
    if duplicates:
        raise ValueError(f"Duplicate deterministic analyzer ID(s): {', '.join(duplicates)}")

    unknown = sorted(item for item in requested_analyzers if item not in ANALYZER_REGISTRY)
    if unknown:
        raise ValueError(
            f"Unknown deterministic analyzer ID(s): {', '.join(unknown)}. "
            f"Allowed analyzer IDs: {', '.join(ANALYZER_REGISTRY)}"
        )
    return tuple(ANALYZER_REGISTRY[item] for item in requested_analyzers)


def instantiate_analyzers(
    manifests: Iterable[AnalyzerManifest],
) -> dict[str, AnalyzerBase]:
    """Instantiate a fresh ordered mapping from validated manifests."""

    return {manifest.analyzer_id: manifest.create() for manifest in manifests}


# Deprecated aliases are intentionally defined only at this compatibility
# boundary. Canonical runtime code imports the analyzer names above.
AgentManifest = AnalyzerManifest
AGENT_REGISTRY = ANALYZER_REGISTRY
DEFAULT_AGENT_IDS = DEFAULT_ANALYZER_IDS
resolve_agent_manifests = resolve_analyzer_manifests
instantiate_agents = instantiate_analyzers
