"""Build compact evidence packs under a deterministic context budget."""

from __future__ import annotations

from typing import Any

from .evidence_index import build_evidence_candidates
from .hybrid_retriever import retrieve_evidence
from .models import (
    DiscardedEvidence,
    EvidenceCandidate,
    EvidencePack,
    EvidenceQuery,
    EvidenceScore,
    SelectedEvidence,
    to_jsonable,
)
from .query_builder import build_evidence_query

RETRIEVAL_STRATEGY = "hybrid_path_symbol_signal_callsite_ownership_local_similarity"


def estimate_tokens(text: str) -> int:
    return max(1, len(text or "") // 4)


def _truncate_to_budget(text: str, remaining_tokens: int) -> str:
    if estimate_tokens(text) <= remaining_tokens:
        return text
    if remaining_tokens <= 8:
        return text[: max(0, remaining_tokens * 4)]
    return text[: max(0, remaining_tokens * 4 - 16)].rstrip() + "\n...[truncated]"


def build_evidence_pack(
    query: EvidenceQuery,
    candidates: list[EvidenceCandidate],
    *,
    context_budget_tokens: int = 2000,
    top_k: int = 8,
) -> EvidencePack:
    """Select and compress evidence candidates into a JSON-ready pack."""
    ranked = retrieve_evidence(query, candidates, top_k=max(top_k, len(candidates)))
    selected: list[SelectedEvidence] = []
    selected_ids: set[str] = set()
    used_tokens = 0

    for candidate, score in ranked:
        if len(selected) >= top_k:
            break
        remaining = context_budget_tokens - used_tokens
        if remaining <= 0:
            break
        content = _truncate_to_budget(candidate.content, remaining)
        token_count = estimate_tokens(content)
        if used_tokens + token_count > context_budget_tokens:
            continue
        used_tokens += token_count
        selected_candidate = EvidenceCandidate(
            id=candidate.id,
            file=candidate.file,
            kind=candidate.kind,
            source=candidate.source,
            content=content,
            start_line=candidate.start_line,
            end_line=candidate.end_line,
            metadata=candidate.metadata,
        )
        selected.append(
            SelectedEvidence(
                candidate=selected_candidate,
                score=score,
                why_selected=score.reasons,
            )
        )
        selected_ids.add(candidate.id)

    discarded: list[DiscardedEvidence] = []
    for candidate, score in ranked:
        if candidate.id in selected_ids:
            continue
        reason = "outside context budget" if used_tokens >= context_budget_tokens else "below selected evidence cutoff"
        discarded.append(
            DiscardedEvidence(
                candidate_id=candidate.id,
                kind=candidate.kind,
                score=score.total,
                why_discarded=[reason],
            )
        )

    ranked_ids = {candidate.id for candidate, _score in ranked}
    for candidate in candidates:
        if candidate.id in ranked_ids or candidate.id in selected_ids:
            continue
        discarded.append(
            DiscardedEvidence(
                candidate_id=candidate.id,
                kind=candidate.kind,
                score=0.0,
                why_discarded=["empty or unranked candidate"],
            )
        )

    input_tokens = sum(estimate_tokens(candidate.content) for candidate in candidates)
    output_tokens = sum(estimate_tokens(item.candidate.content) for item in selected)
    compression_ratio = round(output_tokens / input_tokens, 4) if input_tokens else 0.0
    compression = {
        "candidate_count": len(candidates),
        "selected_count": len(selected),
        "estimated_input_tokens": input_tokens,
        "estimated_output_tokens": output_tokens,
        "compression_ratio": compression_ratio,
    }
    return EvidencePack(
        file=query.file,
        retrieval_strategy=RETRIEVAL_STRATEGY,
        context_budget_tokens=context_budget_tokens,
        query=query,
        selected_evidence=selected,
        discarded_candidates=discarded,
        compression=compression,
    )


def _empty_retrieval(context_budget_tokens: int) -> dict[str, Any]:
    return {
        "strategy": RETRIEVAL_STRATEGY,
        "context_budget_tokens": context_budget_tokens,
        "packs": [],
        "summary": {
            "files_with_evidence": 0,
            "total_selected_evidence": 0,
            "average_selected_evidence_count": 0.0,
            "average_compression_ratio": 0.0,
        },
    }


def build_retrieval_section(
    file_deep_dive: list[dict[str, Any]],
    *,
    security_findings: list[dict[str, Any]] | None = None,
    evidence_summary: list[dict[str, Any]] | None = None,
    context_budget_tokens: int = 2000,
) -> dict[str, Any]:
    """Attach evidence packs to file deep-dives and return report summary."""
    if not file_deep_dive:
        return _empty_retrieval(context_budget_tokens)

    packs: list[dict[str, Any]] = []
    for item in file_deep_dive:
        signals = {
            "structural": item.get("structural_signals", []),
            "semantic": item.get("semantic_signals", []),
        }
        query = build_evidence_query(
            item,
            diff_excerpt=str(item.get("diff_excerpt", "")),
            code_excerpt=str(item.get("code_excerpt", "")),
            agent_signals=signals,
        )
        candidates = build_evidence_candidates(
            item,
            security_findings=security_findings,
            evidence_summary=evidence_summary,
        )
        pack = build_evidence_pack(
            query,
            candidates,
            context_budget_tokens=context_budget_tokens,
        )
        pack_json = to_jsonable(pack)
        item["evidence_pack"] = pack_json
        packs.append(pack_json)

    selected_counts = [
        int(pack.get("compression", {}).get("selected_count", 0))
        for pack in packs
    ]
    compression_ratios = [
        float(pack.get("compression", {}).get("compression_ratio", 0.0))
        for pack in packs
    ]
    files_with_evidence = sum(1 for count in selected_counts if count > 0)
    total_selected = sum(selected_counts)
    return {
        "strategy": RETRIEVAL_STRATEGY,
        "context_budget_tokens": context_budget_tokens,
        "packs": packs,
        "summary": {
            "files_with_evidence": files_with_evidence,
            "total_selected_evidence": total_selected,
            "average_selected_evidence_count": round(total_selected / len(packs), 4) if packs else 0.0,
            "average_compression_ratio": round(sum(compression_ratios) / len(compression_ratios), 4)
            if compression_ratios else 0.0,
        },
    }
