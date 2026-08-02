"""Build lightweight evidence candidates from existing PR report fields."""

from __future__ import annotations

import hashlib
from typing import Any

from .models import EvidenceCandidate, EvidenceKind


def _candidate_id(filepath: str, kind: EvidenceKind, source: str, content: str) -> str:
    digest = hashlib.sha1(f"{filepath}|{kind}|{source}|{content}".encode("utf-8")).hexdigest()[:12]
    return f"{kind}:{digest}"


def _add(
    candidates: list[EvidenceCandidate],
    *,
    file: str,
    kind: EvidenceKind,
    source: str,
    content: str | None,
    start_line: int | None = None,
    end_line: int | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    text = (content or "").strip()
    if not text:
        return
    candidates.append(
        EvidenceCandidate(
            id=_candidate_id(file, kind, source, text),
            file=file,
            kind=kind,
            source=source,
            content=text,
            start_line=start_line,
            end_line=end_line,
            metadata=metadata or {},
        )
    )


def build_evidence_candidates(
    file_result: dict[str, Any],
    *,
    security_findings: list[dict[str, Any]] | None = None,
    evidence_summary: list[dict[str, Any]] | None = None,
) -> list[EvidenceCandidate]:
    """Create local evidence candidates from report/deep-dive fields."""
    filepath = str(file_result.get("file", ""))
    if not filepath:
        return []

    candidates: list[EvidenceCandidate] = []
    _add(candidates, file=filepath, kind="changed_hunk", source="diff_excerpt", content=file_result.get("diff_excerpt"))
    _add(candidates, file=filepath, kind="file_snippet", source="code_excerpt", content=file_result.get("code_excerpt"))

    for index, item in enumerate(file_result.get("evidence_chain", [])):
        if not isinstance(item, dict):
            continue
        signal = str(item.get("signal_name", "agent"))
        _add(
            candidates,
            file=filepath,
            kind="agent_finding",
            source=f"evidence_chain:{signal}",
            content=item.get("text"),
            metadata={"signal_name": signal, "confidence": item.get("confidence"), "index": index},
        )

    for signal_name in ("structural_signals", "semantic_signals"):
        for index, text in enumerate(file_result.get(signal_name, [])):
            _add(
                candidates,
                file=filepath,
                kind="callsite_hint" if signal_name == "structural_signals" else "agent_finding",
                source=signal_name,
                content=text,
                metadata={"signal_name": signal_name.replace("_signals", ""), "index": index},
            )

    for index, hint in enumerate(file_result.get("callsite_hints", [])):
        if isinstance(hint, dict):
            content = hint.get("content")
            metadata = {key: value for key, value in hint.items() if key != "content"}
            start_line = hint.get("line")
            hint_file = str(hint.get("file") or filepath)
        else:
            content = str(hint)
            metadata = {"index": index}
            start_line = None
            hint_file = filepath
        _add(
            candidates,
            file=hint_file,
            kind="callsite_hint",
            source="cross_file_callsite",
            content=content,
            start_line=start_line if isinstance(start_line, int) else None,
            metadata=metadata,
        )

    for index, hint in enumerate(file_result.get("ownership_hints", [])):
        _add(
            candidates,
            file=filepath,
            kind="history_signal",
            source="ownership_history",
            content=str(hint),
            metadata={"index": index, "signal_name": "ownership"},
        )

    for finding in security_findings or []:
        if finding.get("filepath") == filepath or finding.get("file") == filepath:
            _add(
                candidates,
                file=filepath,
                kind="security_hint",
                source="security_findings",
                content=finding.get("evidence"),
                metadata={"commit_sha": finding.get("commit_sha"), "author": finding.get("author")},
            )

    for item in evidence_summary or []:
        _add(
            candidates,
            file=filepath,
            kind="history_signal",
            source=f"evidence_summary:{item.get('type', 'history')}",
            content=item.get("text"),
            metadata={key: value for key, value in item.items() if key != "text"},
        )

    breakdown = file_result.get("risk_breakdown") or {}
    dominant = file_result.get("dominant_signals") or []
    if breakdown or dominant:
        _add(
            candidates,
            file=filepath,
            kind="evolution_hint",
            source="risk_breakdown",
            content=f"Dominant signals: {', '.join(dominant) or 'none'}; breakdown: {breakdown}",
            metadata={"risk_breakdown": breakdown, "dominant_signals": dominant},
        )

    return candidates
