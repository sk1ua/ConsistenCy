# -*- coding: utf-8 -*-
"""WorkflowSpec v2 parsing and validation.

This mirrors ``packages/schema/src/workflow.ts``; the two must agree because a
spec is authored once and validated on both sides. ``tests/test_workflow_spec.py``
asserts the allowlists here match the TypeScript enums so the pair cannot drift
silently.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .dag import Dag, DagNode, WorkflowGraphError

STEP_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]*$")

MAX_TIMEOUT_MS = 600_000
DEFAULT_NODE_TIMEOUT_MS = 60_000
DEFAULT_SYNTHESIZER_TIMEOUT_MS = 120_000

# Adding a capability is a reviewed code change here, never a YAML edit: a
# workflow file is repository content and may be attacker-controlled.
ANALYZER_KINDS: frozenset[str] = frozenset({
    "engine.style",
    "engine.structural",
    "engine.semantic",
    "engine.duplication",
    "engine.security",
    "tool.semgrep",
    "tool.ruff",
    "tool.eslint",
    "graph.dependency",
    "graph.schema_drift",
})

VERIFIER_KINDS: frozenset[str] = frozenset({
    "verify.unit_tests",
    "verify.build",
    "verify.syntax",
    "verify.llm_sanity",
})

SYNTHESIZER_KIND = "synthesize.review_report"


class WorkflowSpecError(ValueError):
    """Raised when a workflow document is not a valid WorkflowSpec v2."""


@dataclass(frozen=True, slots=True)
class WorkflowStep:
    """One node, verifier, or synthesizer entry."""

    step_id: str
    uses: str
    role: str  # "node" | "verifier" | "synthesizer"
    needs: tuple[str, ...] = ()
    timeout_ms: int = DEFAULT_NODE_TIMEOUT_MS
    continue_on_error: bool = False
    options: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class WorkflowSpec:
    version: int
    name: str
    steps: tuple[WorkflowStep, ...]
    description: str | None = None

    def step(self, step_id: str) -> WorkflowStep:
        for candidate in self.steps:
            if candidate.step_id == step_id:
                return candidate
        raise WorkflowSpecError(f"Unknown step '{step_id}'")

    def dag(self) -> Dag:
        return Dag(DagNode(step.step_id, step.needs) for step in self.steps)

    @property
    def nodes(self) -> tuple[WorkflowStep, ...]:
        return tuple(step for step in self.steps if step.role == "node")

    @property
    def verifiers(self) -> tuple[WorkflowStep, ...]:
        return tuple(step for step in self.steps if step.role == "verifier")

    @property
    def synthesizer(self) -> WorkflowStep:
        for step in self.steps:
            if step.role == "synthesizer":
                return step
        raise WorkflowSpecError("Workflow has no synthesizer")


def _require_mapping(value: Any, where: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkflowSpecError(f"{where} must be a mapping, got {type(value).__name__}")
    return value


def _parse_step_id(value: Any, where: str) -> str:
    if not isinstance(value, str) or not STEP_ID_PATTERN.match(value):
        raise WorkflowSpecError(
            f"{where}: step id must match {STEP_ID_PATTERN.pattern}, got {value!r}"
        )
    return value


def _parse_needs(value: Any, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise WorkflowSpecError(f"{where}.needs must be a list")
    return tuple(_parse_step_id(item, f"{where}.needs") for item in value)


def _parse_timeout(value: Any, where: str, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise WorkflowSpecError(f"{where}.timeoutMs must be an integer")
    if value <= 0 or value > MAX_TIMEOUT_MS:
        raise WorkflowSpecError(f"{where}.timeoutMs must be in 1..{MAX_TIMEOUT_MS}, got {value}")
    return value


def _parse_options(value: Any, where: str) -> Mapping[str, Any]:
    if value is None:
        return {}
    mapping = _require_mapping(value, f"{where}.with")
    if any(not isinstance(key, str) for key in mapping):
        raise WorkflowSpecError(f"{where}.with keys must be strings")
    return dict(mapping)


def _parse_uses(value: Any, allowed: frozenset[str], where: str) -> str:
    if not isinstance(value, str):
        raise WorkflowSpecError(f"{where}.uses must be a string")
    if value not in allowed:
        raise WorkflowSpecError(
            f"{where}.uses '{value}' is not allowed. Permitted: {', '.join(sorted(allowed))}"
        )
    return value


def _parse_step(raw: Any, role: str, allowed: frozenset[str], index: int, default_timeout: int) -> WorkflowStep:
    where = f"{role}s[{index}]" if role != "synthesizer" else "synthesizer"
    mapping = _require_mapping(raw, where)
    unknown = set(mapping) - {"id", "uses", "needs", "timeoutMs", "continueOnError", "with"}
    if unknown:
        raise WorkflowSpecError(f"{where} has unknown field(s): {', '.join(sorted(unknown))}")

    continue_on_error = mapping.get("continueOnError", False)
    if not isinstance(continue_on_error, bool):
        raise WorkflowSpecError(f"{where}.continueOnError must be a boolean")

    return WorkflowStep(
        step_id=_parse_step_id(mapping.get("id"), where),
        uses=_parse_uses(mapping.get("uses"), allowed, where),
        role=role,
        needs=_parse_needs(mapping.get("needs"), where),
        timeout_ms=_parse_timeout(mapping.get("timeoutMs"), where, default_timeout),
        continue_on_error=continue_on_error,
        options=_parse_options(mapping.get("with"), where),
    )


def load_workflow_spec(document: Any) -> WorkflowSpec:
    """Validate a parsed workflow document into a `WorkflowSpec`."""
    mapping = _require_mapping(document, "workflow")

    unknown = set(mapping) - {"version", "name", "description", "nodes", "verifiers", "synthesizer"}
    if unknown:
        raise WorkflowSpecError(f"workflow has unknown field(s): {', '.join(sorted(unknown))}")

    if mapping.get("version") != 2:
        raise WorkflowSpecError(f"Unsupported workflow version: {mapping.get('version')!r} (expected 2)")

    name = mapping.get("name")
    if not isinstance(name, str) or not name.strip():
        raise WorkflowSpecError("workflow.name must be a non-empty string")

    description = mapping.get("description")
    if description is not None and (not isinstance(description, str) or not description.strip()):
        raise WorkflowSpecError("workflow.description must be a non-empty string when present")

    raw_nodes = mapping.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise WorkflowSpecError("workflow.nodes must be a non-empty list")

    raw_verifiers = mapping.get("verifiers") or []
    if not isinstance(raw_verifiers, list):
        raise WorkflowSpecError("workflow.verifiers must be a list")

    raw_synthesizer = mapping.get("synthesizer")
    if raw_synthesizer is None:
        raise WorkflowSpecError("workflow.synthesizer is required")

    steps: list[WorkflowStep] = []
    steps.extend(
        _parse_step(raw, "node", ANALYZER_KINDS, index, DEFAULT_NODE_TIMEOUT_MS)
        for index, raw in enumerate(raw_nodes)
    )
    steps.extend(
        _parse_step(raw, "verifier", VERIFIER_KINDS, index, DEFAULT_NODE_TIMEOUT_MS)
        for index, raw in enumerate(raw_verifiers)
    )

    synthesizer_mapping = dict(_require_mapping(raw_synthesizer, "synthesizer"))
    synthesizer_mapping.setdefault("id", "synthesizer")
    synthesizer_mapping.setdefault("uses", SYNTHESIZER_KIND)
    steps.append(
        _parse_step(
            synthesizer_mapping,
            "synthesizer",
            frozenset({SYNTHESIZER_KIND}),
            0,
            DEFAULT_SYNTHESIZER_TIMEOUT_MS,
        )
    )

    spec = WorkflowSpec(
        version=2,
        name=name.strip(),
        description=description.strip() if isinstance(description, str) else None,
        steps=tuple(steps),
    )

    # Surfaces duplicate ids, dangling `needs`, self-dependency, and cycles.
    try:
        spec.dag()
    except WorkflowGraphError as error:
        raise WorkflowSpecError(str(error)) from error

    return spec


def load_workflow_file(path: str | Path) -> WorkflowSpec:
    """Load a workflow from a `.yml`, `.yaml`, or `.json` file."""
    resolved = Path(path)
    text = resolved.read_text(encoding="utf-8")

    if resolved.suffix.lower() in {".yml", ".yaml"}:
        try:
            import yaml
        except ImportError as error:  # pragma: no cover - depends on install extras
            raise WorkflowSpecError(
                "PyYAML is required to load YAML workflows; install it or use JSON"
            ) from error
        # safe_load never constructs arbitrary Python objects from the document.
        document = yaml.safe_load(text)
    else:
        document = json.loads(text)

    return load_workflow_spec(document)


def builtin_workflow_directory() -> Path:
    return Path(__file__).parent / "workflows"


def load_builtin_workflow(name: str) -> WorkflowSpec:
    """Load one of the shipped workflows by file stem."""
    if not re.match(r"^[a-z][a-z0-9-]*$", name):
        raise WorkflowSpecError(f"Invalid builtin workflow name: {name!r}")
    return load_workflow_file(builtin_workflow_directory() / f"{name}.yml")
