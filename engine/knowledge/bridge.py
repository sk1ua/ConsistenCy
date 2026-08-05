# -*- coding: utf-8 -*-
"""Adapter between the stdio protocol and the knowledge index."""
from __future__ import annotations

from ..protocol import (
    RecordReviewRequest,
    RecordReviewResponse,
    RelevantContextRequest,
    RelevantContextResponse,
)
from .context import ContextQuery, get_relevant_context
from .indexer import KnowledgeIndex

DEFAULT_LIMIT = 10
MAX_TARGETS = 100


def run_relevant_context_request(request: RelevantContextRequest) -> RelevantContextResponse:
    """Index the supplied corpus and return context for each requested target.

    `index_path` defaults to an in-memory database so a review of one repository
    cannot accumulate graph nodes from another. Pass an explicit path when the
    caller wants the index to persist across runs.
    """
    limit = request.options.get("limit", DEFAULT_LIMIT)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        return RelevantContextResponse(
            id=request.id,
            ok=False,
            error="options.limit must be a positive integer",
        )

    targets = request.targets or [file_input.path for file_input in request.files]
    if len(targets) > MAX_TARGETS:
        return RelevantContextResponse(
            id=request.id,
            ok=False,
            error=f"Too many targets: {len(targets)} exceeds {MAX_TARGETS}",
        )

    files = {file_input.path: file_input.content for file_input in request.files}

    index = KnowledgeIndex(request.index_path or ":memory:")
    try:
        index.index_files(files, prune_missing=False)
        contexts = {
            target: get_relevant_context(index, ContextQuery(file=target, limit=limit))
            for target in targets
        }
    finally:
        index.close()

    return RelevantContextResponse(id=request.id, ok=True, contexts=contexts)


def run_record_review_request(request: RecordReviewRequest) -> RecordReviewResponse:
    """Persist one review's findings so later reviews can see the history."""
    index = KnowledgeIndex(request.index_path)
    try:
        counts = index.record_review(
            job_id=request.job_id,
            reference=request.reference,
            reported_at=request.reported_at,
            covered_files=request.covered_files,
            findings=request.findings,
        )
    finally:
        index.close()

    return RecordReviewResponse(
        id=request.id,
        ok=True,
        recorded=counts["recorded"],
        resolved=counts["resolved"],
    )
