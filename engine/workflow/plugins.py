# -*- coding: utf-8 -*-
"""Plugin interface and allowlisted registry for workflow steps.

The doc-level contract is ``analyze(diff, AST, context) -> PluginReport``; diff
and AST are carried on `AnalysisContext` rather than passed positionally, so a
plugin that needs neither is not forced to accept them, and adding an input
later does not break every implementation.
"""
from __future__ import annotations

import asyncio
import shutil
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from .artifacts import EvidenceItem, digest_files
from .spec import WorkflowStep

MAX_CAPTURED_OUTPUT = 256 * 1024


@dataclass(frozen=True, slots=True)
class AnalysisContext:
    """Everything a plugin may read. Treated as immutable by convention."""

    files: Mapping[str, str]
    baselines: Mapping[str, str] = field(default_factory=dict)
    diff_hunks: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    asts: Mapping[str, Any] = field(default_factory=dict)
    workspace_path: str | None = None
    upstream_evidence: tuple[EvidenceItem, ...] = ()
    options: Mapping[str, Any] = field(default_factory=dict)

    def digest(self) -> str:
        return digest_files(self.files)

    def with_options(self, options: Mapping[str, Any]) -> "AnalysisContext":
        return AnalysisContext(
            files=self.files,
            baselines=self.baselines,
            diff_hunks=self.diff_hunks,
            asts=self.asts,
            workspace_path=self.workspace_path,
            upstream_evidence=self.upstream_evidence,
            options=options,
        )


@dataclass(frozen=True, slots=True)
class PluginReport:
    """What a plugin observed, plus how it observed it."""

    evidence: tuple[EvidenceItem, ...] = ()
    summary: str = ""
    command: tuple[str, ...] = ()
    exit_code: int | None = None
    raw_output: str = ""
    skipped_reason: str | None = None


class BaseAnalyzerPlugin(ABC):
    """Every workflow step is implemented by one of these."""

    #: Allowlisted identifier this plugin implements, e.g. "engine.security".
    kind: str = ""

    def __init__(self, options: Mapping[str, Any] | None = None) -> None:
        self.options: Mapping[str, Any] = dict(options or {})

    @abstractmethod
    async def analyze(self, context: AnalysisContext) -> PluginReport:
        """Inspect the context and return anchored evidence."""


class SubprocessPlugin(BaseAnalyzerPlugin):
    """Base for plugins that shell out to an external tool.

    The executable and base argv are fixed by the subclass. Workflow `with:`
    options may only contribute values through `extra_args`, which subclasses
    validate — a spec can never supply free-form argv, because workflow files
    are repository content and may be attacker-controlled.
    """

    executable: str = ""
    base_args: tuple[str, ...] = ()

    def extra_args(self) -> tuple[str, ...]:
        return ()

    def parse_output(self, stdout: str, stderr: str, exit_code: int) -> tuple[EvidenceItem, ...]:
        return ()

    def acceptable_exit_codes(self) -> frozenset[int]:
        # Most linters exit non-zero purely because they found something.
        return frozenset({0, 1})

    async def analyze(self, context: AnalysisContext) -> PluginReport:
        argv = (self.executable, *self.base_args, *self.extra_args())
        if context.workspace_path is None:
            # Without an explicit workspace the tool would inherit the process
            # CWD and scan whatever happens to be there. Refuse instead.
            return PluginReport(
                command=argv,
                summary=f"{self.executable} needs a workspace path",
                skipped_reason="No workspace_path was supplied for an external tool",
            )

        resolved = shutil.which(self.executable)
        if resolved is None:
            return PluginReport(
                command=argv,
                summary=f"{self.executable} is not installed",
                skipped_reason=f"{self.executable} not found on PATH",
            )

        process = await asyncio.create_subprocess_exec(
            resolved,
            *argv[1:],
            cwd=context.workspace_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await process.communicate()
        stdout = stdout_bytes.decode("utf-8", errors="replace")[:MAX_CAPTURED_OUTPUT]
        stderr = stderr_bytes.decode("utf-8", errors="replace")[:MAX_CAPTURED_OUTPUT]
        exit_code = process.returncode if process.returncode is not None else -1

        if exit_code not in self.acceptable_exit_codes():
            return PluginReport(
                command=argv,
                exit_code=exit_code,
                raw_output=stderr or stdout,
                summary=f"{self.executable} exited with {exit_code}",
            )

        evidence = self.parse_output(stdout, stderr, exit_code)
        return PluginReport(
            evidence=evidence,
            summary=f"{self.executable} reported {len(evidence)} finding(s)",
            command=argv,
            exit_code=exit_code,
            raw_output=stdout,
        )


PluginFactory = Callable[[Mapping[str, Any]], BaseAnalyzerPlugin]

_REGISTRY: dict[str, PluginFactory] = {}


def register_plugin(kind: str, factory: PluginFactory) -> None:
    """Register an implementation for an allowlisted kind.

    Kinds are validated against the spec allowlists at resolution time, so this
    cannot introduce a capability the spec would reject.
    """
    _REGISTRY[kind] = factory


def registered_kinds() -> frozenset[str]:
    return frozenset(_REGISTRY)


class MissingPluginError(LookupError):
    """Raised when a spec references a kind with no registered implementation."""


def resolve_plugin(step: WorkflowStep) -> BaseAnalyzerPlugin:
    factory = _REGISTRY.get(step.uses)
    if factory is None:
        raise MissingPluginError(
            f"No plugin registered for '{step.uses}' (step '{step.step_id}'). "
            f"Registered: {', '.join(sorted(_REGISTRY)) or 'none'}"
        )
    return factory(step.options)


def clear_registry_for_tests() -> None:
    _REGISTRY.clear()


def registry_snapshot() -> Mapping[str, PluginFactory]:
    return dict(_REGISTRY)


def restore_registry(snapshot: Mapping[str, PluginFactory]) -> None:
    _REGISTRY.clear()
    _REGISTRY.update(snapshot)


def evidence_from_sequence(items: Sequence[Mapping[str, Any]], default_file: str) -> tuple[EvidenceItem, ...]:
    """Build evidence from loosely-typed tool output, dropping unusable rows."""
    built: list[EvidenceItem] = []
    for item in items:
        path = item.get("file") or default_file
        if not isinstance(path, str) or not path:
            continue
        start = item.get("startLine")
        end = item.get("endLine", start)
        try:
            built.append(
                EvidenceItem(
                    file=path,
                    excerpt=str(item.get("excerpt", "")),
                    start_line=int(start) if isinstance(start, int) else None,
                    end_line=int(end) if isinstance(end, int) else None,
                    rule=item.get("rule"),
                    severity=item.get("severity"),
                    metadata=item.get("metadata") or {},
                )
            )
        except (ValueError, TypeError):
            continue
    return tuple(built)
