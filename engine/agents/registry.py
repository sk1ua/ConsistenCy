"""Explicit allowlist and manifests for deterministic analysis agents."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

from .base_agent import AgentBase
from .duplication_agent import DuplicationAgent
from .security_agent import SecurityAgent
from .semantic_agent import SemanticAgent
from .structural_agent import StructuralAgent
from .style_agent import StyleAgent


@dataclass(frozen=True, slots=True)
class AgentManifest:
    """Versioned metadata and factory for one allowed deterministic agent."""

    agent_id: str
    display_name: str
    version: str
    description: str
    factory: Callable[[], AgentBase] = field(repr=False, compare=False)

    def create(self) -> AgentBase:
        agent = self.factory()
        if not isinstance(agent, AgentBase):
            raise TypeError(f"Factory for agent '{self.agent_id}' returned an invalid instance")
        if agent.name != self.display_name:
            raise ValueError(
                f"Manifest '{self.agent_id}' declares '{self.display_name}' "
                f"but factory returned '{agent.name}'"
            )
        return agent

    def to_dict(self) -> dict[str, str]:
        return {
            "agent_id": self.agent_id,
            "display_name": self.display_name,
            "version": self.version,
            "description": self.description,
        }


def _manifest(agent_id: str, agent_type: type[AgentBase], description: str) -> AgentManifest:
    return AgentManifest(agent_id, agent_type().name, "1", description, agent_type)


_MANIFESTS = {
    "style": _manifest("style", StyleAgent, "Style drift."),
    "structural": _manifest("structural", StructuralAgent, "Structural drift."),
    "semantic": _manifest("semantic", SemanticAgent, "Semantic change proxies."),
    "duplication": _manifest("duplication", DuplicationAgent, "Code-clone detection."),
    "security": _manifest("security", SecurityAgent, "Static security checks."),
}

# Public read-only registry. Adding an agent requires an explicit code change here.
AGENT_REGISTRY: Mapping[str, AgentManifest] = MappingProxyType(_MANIFESTS)
DEFAULT_AGENT_IDS: tuple[str, ...] = tuple(AGENT_REGISTRY)


def resolve_agent_manifests(requested_agents: object) -> tuple[AgentManifest, ...]:
    """Validate requested IDs against the allowlist and return their manifests."""

    if not isinstance(requested_agents, list) or not requested_agents:
        raise ValueError("'agents' must be a non-empty list of deterministic agent IDs")
    if any(
        not isinstance(agent_id, str) or not agent_id or agent_id.strip() != agent_id
        for agent_id in requested_agents
    ):
        raise ValueError("'agents' must contain only non-blank, normalized string IDs")

    duplicates = sorted({item for item in requested_agents if requested_agents.count(item) > 1})
    if duplicates:
        raise ValueError(f"Duplicate deterministic agent ID(s): {', '.join(duplicates)}")

    unknown = sorted(item for item in requested_agents if item not in AGENT_REGISTRY)
    if unknown:
        raise ValueError(
            f"Unknown deterministic agent ID(s): {', '.join(unknown)}. "
            f"Allowed agent IDs: {', '.join(AGENT_REGISTRY)}"
        )
    return tuple(AGENT_REGISTRY[item] for item in requested_agents)


def instantiate_agents(manifests: Iterable[AgentManifest]) -> dict[str, AgentBase]:
    """Instantiate a fresh ordered mapping from validated manifests."""

    return {manifest.agent_id: manifest.create() for manifest in manifests}
