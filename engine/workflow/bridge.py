# -*- coding: utf-8 -*-
"""Adapter between the stdio protocol and the DAG workflow engine."""
from __future__ import annotations

from ..protocol import RunWorkflowRequest, RunWorkflowResponse, normalise_protocol_strings
from .builtins import register_builtin_plugins
from .plugins import AnalysisContext, BaseAnalyzerPlugin, PluginReport
from .runner import run_workflow_sync
from .spec import WorkflowSpecError, load_builtin_workflow, load_workflow_spec

MAX_INLINE_SPEC_BYTES = 256 * 1024


class _SynthesizerPlaceholder(BaseAnalyzerPlugin):
    """Terminal node for engine-only runs.

    Synthesis is the LLM layer's job (apps/api), so the deterministic engine
    stops at collected evidence rather than pretending to summarise it.
    """

    kind = "synthesize.review_report"

    async def analyze(self, context: AnalysisContext) -> PluginReport:
        # Deliberately emits no evidence of its own: every item is already
        # attributed to the step that found it, and re-emitting here would
        # double-count it in the run's collected evidence.
        return PluginReport(
            summary=f"Collected {len(context.upstream_evidence)} evidence item(s) for synthesis",
        )


def _resolver():
    from .plugins import resolve_plugin

    def resolve(step):
        if step.role == "synthesizer":
            return _SynthesizerPlaceholder()
        return resolve_plugin(step)

    return resolve


def run_workflow_request(request: RunWorkflowRequest) -> RunWorkflowResponse:
    """Execute a builtin or inline workflow over the request's files."""
    register_builtin_plugins()

    if request.spec is not None:
        import json

        serialized = json.dumps(request.spec, ensure_ascii=False, separators=(",", ":"))
        if len(serialized.encode("utf-8")) > MAX_INLINE_SPEC_BYTES:
            return RunWorkflowResponse(
                id=request.id,
                ok=False,
                error=f"Inline workflow spec exceeds the {MAX_INLINE_SPEC_BYTES} byte limit",
            )
        try:
            spec = load_workflow_spec(request.spec)
        except WorkflowSpecError as error:
            return RunWorkflowResponse(
                id=request.id,
                ok=False,
                error=f"Invalid inline workflow spec: {error}",
            )
    else:
        try:
            spec = load_builtin_workflow(request.workflow)
        except (WorkflowSpecError, FileNotFoundError) as error:
            return RunWorkflowResponse(
                id=request.id,
                ok=False,
                error=f"Unknown or invalid workflow '{request.workflow}': {error}",
            )

    # Boundary sanitisation: the stdio entrypoint already normalises the raw
    # JSON, but the bridge is also called directly (tests, embedders), so the
    # step inputs are normalised here as well. Lone surrogates reaching the
    # parsers would otherwise poison every downstream UTF-8 encoding.
    files = {
        normalise_protocol_strings(file_input.path): normalise_protocol_strings(file_input.content)
        for file_input in request.files
    }
    baselines = {
        normalise_protocol_strings(file_input.path): normalise_protocol_strings(file_input.baseline)
        for file_input in request.files
        if file_input.baseline
    }
    diff_hunks = {
        normalise_protocol_strings(file_input.path): tuple(
            normalise_protocol_strings(hunk) for hunk in (file_input.diff_hunks or ())
        )
        for file_input in request.files
        if file_input.diff_hunks
    }

    context = AnalysisContext(
        files=files,
        baselines=baselines,
        diff_hunks=diff_hunks,
        workspace_path=request.workspace_path,
        options=request.options,
    )

    max_parallelism = request.options.get("max_parallelism", 4)
    if not isinstance(max_parallelism, int) or isinstance(max_parallelism, bool) or max_parallelism < 1:
        return RunWorkflowResponse(
            id=request.id,
            ok=False,
            error="options.max_parallelism must be a positive integer",
        )

    result = run_workflow_sync(
        spec,
        context,
        resolver=_resolver(),
        max_parallelism=min(max_parallelism, 8),
    )
    return RunWorkflowResponse(id=request.id, ok=True, run=result.to_dict())
