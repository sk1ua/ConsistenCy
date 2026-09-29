# -*- coding: utf-8 -*-
"""Immutable execution records produced by every workflow step.

Mirrors ``stepExecutionArtifactSchema`` in ``packages/schema/src/workflow.ts``:
`to_dict` emits exactly that camelCase shape so an artifact crosses the stdio
protocol without a translation layer.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"
STATUS_SKIPPED = "skipped"
STATUS_TIMED_OUT = "timed_out"

TERMINAL_STATUSES = frozenset({STATUS_SUCCEEDED, STATUS_FAILED, STATUS_SKIPPED, STATUS_TIMED_OUT})


def digest_files(files: Mapping[str, str]) -> str:
    """SHA-256 over the exact file set analyzed, for replay and caching.

    Paths are sorted and both path and content are length-prefixed so that
    different file sets cannot collide onto the same digest.
    """
    hasher = hashlib.sha256()
    for path in sorted(files):
        content = files[path].encode("utf-8")
        path_bytes = path.encode("utf-8")
        hasher.update(len(path_bytes).to_bytes(8, "big"))
        hasher.update(path_bytes)
        hasher.update(len(content).to_bytes(8, "big"))
        hasher.update(content)
    return hasher.hexdigest()


@dataclass(frozen=True, slots=True)
class EvidenceItem:
    """One anchored observation. `file` is always required so that no finding
    can reach the LLM layer without a location to cite."""

    file: str
    excerpt: str
    start_line: int | None = None
    end_line: int | None = None
    rule: str | None = None
    severity: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.file:
            raise ValueError("EvidenceItem.file must not be empty")
        has_start = self.start_line is not None
        has_end = self.end_line is not None
        if has_start != has_end:
            raise ValueError("EvidenceItem start_line and end_line must be provided together")
        if has_start and self.end_line < self.start_line:  # type: ignore[operator]
            raise ValueError("EvidenceItem end_line must be >= start_line")

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "file": self.file,
            "excerpt": self.excerpt,
            "metadata": dict(self.metadata),
        }
        if self.start_line is not None:
            payload["startLine"] = self.start_line
            payload["endLine"] = self.end_line
        if self.rule is not None:
            payload["rule"] = self.rule
        if self.severity is not None:
            payload["severity"] = self.severity
        return payload


@dataclass(frozen=True, slots=True)
class WorkflowEvidence:
    """Typed payload one step passes downstream."""

    produced_by: str
    items: tuple[EvidenceItem, ...] = ()
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "producedBy": self.produced_by,
            "items": [item.to_dict() for item in self.items],
            "summary": self.summary,
        }


@dataclass(frozen=True, slots=True)
class StepExecutionArtifact:
    """What a step did, recorded so the run can be audited or replayed."""

    step_id: str
    uses: str
    status: str
    input_digest: str
    started_at: str
    command: tuple[str, ...] = ()
    exit_code: int | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    raw_output: str = ""
    evidence: WorkflowEvidence | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "stepId": self.step_id,
            "uses": self.uses,
            "status": self.status,
            "command": list(self.command),
            "exitCode": self.exit_code,
            "startedAt": self.started_at,
            "rawOutput": self.raw_output,
            "inputDigest": self.input_digest,
        }
        if self.finished_at is not None:
            payload["finishedAt"] = self.finished_at
        if self.duration_ms is not None:
            payload["durationMs"] = self.duration_ms
        if self.evidence is not None:
            payload["evidence"] = self.evidence.to_dict()
        if self.error is not None:
            payload["error"] = self.error
        return payload


def merge_evidence(artifacts: Iterable[StepExecutionArtifact]) -> tuple[EvidenceItem, ...]:
    """Flatten evidence from completed steps in artifact order."""
    merged: list[EvidenceItem] = []
    for artifact in artifacts:
        if artifact.evidence is not None:
            merged.extend(artifact.evidence.items)
    return tuple(merged)
