# -*- coding: utf-8 -*-
"""Async DAG executor for WorkflowSpec v2.

Steps in the same dependency level run concurrently. Each step is bounded by its
own `timeoutMs`, and a step that fails blocks only its transitive dependents —
independent branches still run, so one broken analyzer does not cost the whole
report.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from .artifacts import (
    STATUS_FAILED,
    STATUS_SKIPPED,
    STATUS_SUCCEEDED,
    STATUS_TIMED_OUT,
    EvidenceItem,
    StepExecutionArtifact,
    WorkflowEvidence,
)
from .plugins import AnalysisContext, BaseAnalyzerPlugin, MissingPluginError, PluginReport, resolve_plugin
from .spec import WorkflowSpec, WorkflowStep

ProgressCallback = Callable[[Mapping[str, Any]], None]
PluginResolver = Callable[[WorkflowStep], BaseAnalyzerPlugin]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class WorkflowRunResult:
    run_id: str
    spec_name: str
    status: str
    started_at: str
    finished_at: str
    artifacts: tuple[StepExecutionArtifact, ...] = ()
    error: str | None = None

    @property
    def evidence(self) -> tuple[EvidenceItem, ...]:
        collected: list[EvidenceItem] = []
        for artifact in self.artifacts:
            if artifact.evidence is not None:
                collected.extend(artifact.evidence.items)
        return tuple(collected)

    def artifact(self, step_id: str) -> StepExecutionArtifact | None:
        for artifact in self.artifacts:
            if artifact.step_id == step_id:
                return artifact
        return None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "runId": self.run_id,
            "specName": self.spec_name,
            "status": self.status,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
        }
        if self.error is not None:
            payload["error"] = self.error
        return payload


@dataclass
class _RunState:
    artifacts: dict[str, StepExecutionArtifact] = field(default_factory=dict)
    blocked: set[str] = field(default_factory=set)

    def succeeded(self, step_id: str) -> bool:
        artifact = self.artifacts.get(step_id)
        return artifact is not None and artifact.status == STATUS_SUCCEEDED


class WorkflowRunner:
    """Executes a `WorkflowSpec` against an `AnalysisContext`."""

    def __init__(
        self,
        *,
        resolver: PluginResolver = resolve_plugin,
        on_progress: ProgressCallback | None = None,
        max_parallelism: int = 4,
    ) -> None:
        if max_parallelism < 1:
            raise ValueError("max_parallelism must be at least 1")
        self._resolver = resolver
        self._on_progress = on_progress
        self._semaphore = asyncio.Semaphore(max_parallelism)

    def _emit(self, event: Mapping[str, Any]) -> None:
        if self._on_progress is None:
            return
        try:
            self._on_progress(event)
        except Exception:
            # A misbehaving progress consumer must never abort the run.
            pass

    async def run(
        self,
        spec: WorkflowSpec,
        context: AnalysisContext,
        *,
        run_id: str | None = None,
    ) -> WorkflowRunResult:
        resolved_run_id = run_id or f"run_{int(time.time() * 1000)}"
        started_at = _now()
        dag = spec.dag()
        state = _RunState()
        input_digest = context.digest()

        self._emit({
            "event": "run_started",
            "runId": resolved_run_id,
            "specName": spec.name,
            "levels": [list(level) for level in dag.levels()],
        })

        for level in dag.levels():
            runnable = [step_id for step_id in level if step_id not in state.blocked]
            for step_id in level:
                if step_id in state.blocked:
                    state.artifacts[step_id] = self._skipped(spec.step(step_id), input_digest)
                    self._emit({"event": "step_skipped", "stepId": step_id})

            if not runnable:
                continue

            results = await asyncio.gather(*(
                self._run_step(spec.step(step_id), context, state, input_digest)
                for step_id in runnable
            ))

            for artifact in results:
                state.artifacts[artifact.step_id] = artifact
                if artifact.status != STATUS_SUCCEEDED:
                    step = spec.step(artifact.step_id)
                    if not step.continue_on_error:
                        state.blocked.update(dag.transitive_dependents(artifact.step_id))

        ordered = tuple(state.artifacts[step_id] for step_id in dag.step_ids if step_id in state.artifacts)
        failed = [a for a in ordered if a.status in {STATUS_FAILED, STATUS_TIMED_OUT}]
        blocking_failures = [
            artifact for artifact in failed
            if not spec.step(artifact.step_id).continue_on_error
        ]
        status = STATUS_FAILED if blocking_failures else STATUS_SUCCEEDED
        error = (
            f"{len(blocking_failures)} step(s) failed: "
            + ", ".join(sorted(a.step_id for a in blocking_failures))
        ) if blocking_failures else None

        result = WorkflowRunResult(
            run_id=resolved_run_id,
            spec_name=spec.name,
            status=status,
            started_at=started_at,
            finished_at=_now(),
            artifacts=ordered,
            error=error,
        )
        self._emit({"event": "run_finished", "runId": resolved_run_id, "status": status})
        return result

    def _skipped(self, step: WorkflowStep, input_digest: str) -> StepExecutionArtifact:
        moment = _now()
        return StepExecutionArtifact(
            step_id=step.step_id,
            uses=step.uses,
            status=STATUS_SKIPPED,
            input_digest=input_digest,
            started_at=moment,
            finished_at=moment,
            duration_ms=0,
            error="Skipped because a dependency did not succeed",
        )

    async def _run_step(
        self,
        step: WorkflowStep,
        context: AnalysisContext,
        state: _RunState,
        input_digest: str,
    ) -> StepExecutionArtifact:
        async with self._semaphore:
            started_at = _now()
            started_monotonic = time.monotonic()
            self._emit({"event": "step_started", "stepId": step.step_id, "uses": step.uses})

            def finish(
                status: str,
                report: PluginReport | None = None,
                error: str | None = None,
            ) -> StepExecutionArtifact:
                duration = int((time.monotonic() - started_monotonic) * 1000)
                evidence = None
                if report is not None:
                    evidence = WorkflowEvidence(
                        produced_by=step.step_id,
                        items=report.evidence,
                        summary=report.summary,
                    )
                artifact = StepExecutionArtifact(
                    step_id=step.step_id,
                    uses=step.uses,
                    status=status,
                    input_digest=input_digest,
                    started_at=started_at,
                    finished_at=_now(),
                    duration_ms=duration,
                    command=report.command if report else (),
                    exit_code=report.exit_code if report else None,
                    raw_output=report.raw_output if report else "",
                    evidence=evidence,
                    error=error,
                )
                self._emit({
                    "event": "step_finished",
                    "stepId": step.step_id,
                    "status": status,
                    "durationMs": duration,
                })
                return artifact

            try:
                plugin = self._resolver(step)
            except MissingPluginError as error:
                return finish(STATUS_FAILED, error=str(error))

            upstream = tuple(
                item
                for dependency in step.needs
                for item in (
                    state.artifacts[dependency].evidence.items
                    if dependency in state.artifacts and state.artifacts[dependency].evidence
                    else ()
                )
            )
            step_context = AnalysisContext(
                files=context.files,
                baselines=context.baselines,
                diff_hunks=context.diff_hunks,
                asts=context.asts,
                workspace_path=context.workspace_path,
                upstream_evidence=upstream,
                options=step.options,
            )

            try:
                report = await asyncio.wait_for(
                    plugin.analyze(step_context),
                    timeout=step.timeout_ms / 1000,
                )
            except asyncio.TimeoutError:
                return finish(STATUS_TIMED_OUT, error=f"Step exceeded {step.timeout_ms}ms")
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - one bad plugin must not abort the run
                return finish(STATUS_FAILED, error=f"{type(error).__name__}: {error}")

            if report.skipped_reason is not None:
                return finish(STATUS_SKIPPED, report=report, error=report.skipped_reason)
            return finish(STATUS_SUCCEEDED, report=report)


async def run_workflow(
    spec: WorkflowSpec,
    context: AnalysisContext,
    *,
    resolver: PluginResolver = resolve_plugin,
    on_progress: ProgressCallback | None = None,
    max_parallelism: int = 4,
    run_id: str | None = None,
) -> WorkflowRunResult:
    """Convenience wrapper around `WorkflowRunner.run`."""
    runner = WorkflowRunner(
        resolver=resolver,
        on_progress=on_progress,
        max_parallelism=max_parallelism,
    )
    return await runner.run(spec, context, run_id=run_id)


def run_workflow_sync(
    spec: WorkflowSpec,
    context: AnalysisContext,
    **kwargs: Any,
) -> WorkflowRunResult:
    """Blocking entry point for the existing synchronous stdio protocol."""
    return asyncio.run(run_workflow(spec, context, **kwargs))


__all__ = [
    "WorkflowRunner",
    "WorkflowRunResult",
    "run_workflow",
    "run_workflow_sync",
]
