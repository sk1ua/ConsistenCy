"""Deterministic scoring and explanations for evidence retrieval."""

from __future__ import annotations

import re
from pathlib import PurePosixPath

from .models import EvidenceCandidate, EvidenceQuery, EvidenceScore

_WORD_RE = re.compile(r"[a-z0-9_]+")


def _terms(values: list[str]) -> set[str]:
    result: set[str] = set()
    for value in values:
        result.update(_WORD_RE.findall(str(value).lower()))
    return result


def _content_terms(candidate: EvidenceCandidate) -> set[str]:
    metadata_terms = [str(value) for value in candidate.metadata.values() if isinstance(value, (str, int, float))]
    return _terms([candidate.content, candidate.source, candidate.kind, candidate.file, *metadata_terms])


def _char_ngrams(text: str, size: int = 4) -> set[str]:
    normalized = " ".join(_WORD_RE.findall(text.lower()))
    if not normalized:
        return set()
    if len(normalized) <= size:
        return {normalized}
    return {normalized[idx:idx + size] for idx in range(len(normalized) - size + 1)}


def _local_similarity(query: EvidenceQuery, candidate: EvidenceCandidate) -> float:
    """Small deterministic local embedding proxy based on character n-grams."""
    query_text = " ".join(
        [
            query.natural_query,
            query.file,
            " ".join(query.path_terms),
            " ".join(query.symbol_terms),
            " ".join(query.import_terms),
            " ".join(query.risk_terms),
        ]
    )
    left = _char_ngrams(query_text)
    right = _char_ngrams(f"{candidate.file} {candidate.source} {candidate.content}")
    if not left or not right:
        return 0.0
    jaccard = len(left & right) / len(left | right)
    return round(min(jaccard * 0.18, 0.18), 4)


def score_candidate(query: EvidenceQuery, candidate: EvidenceCandidate) -> EvidenceScore:
    """Score a candidate and explain why it was retrieved."""
    reasons: list[str] = []
    content = _content_terms(candidate)
    query_path = "/".join(PurePosixPath(query.file.replace("\\", "/")).parts).lower()
    candidate_path = candidate.file.replace("\\", "/").lower()

    path_relevance = 0.0
    if candidate_path == query_path:
        path_relevance = 0.25
        reasons.append("matched changed file path")
    elif candidate_path and (candidate_path in query_path or query_path in candidate_path):
        path_relevance = 0.15
        reasons.append("matched related file path")
    else:
        overlap = _terms(query.path_terms) & content
        if overlap:
            path_relevance = min(0.12, 0.04 * len(overlap))
            reasons.append(f"matched path term {sorted(overlap)[0]}")

    symbol_overlap = 0.0
    symbols = _terms(query.symbol_terms)
    matched_symbols = sorted(symbols & content)
    if matched_symbols:
        symbol_overlap = min(0.25, 0.08 * len(matched_symbols))
        reasons.extend(f"matched symbol {symbol}" for symbol in matched_symbols[:3])

    import_overlap = 0.0
    imports = _terms(query.import_terms)
    matched_imports = sorted(imports & content)
    if matched_imports:
        import_overlap = min(0.16, 0.06 * len(matched_imports))
        reasons.extend(f"matched import {name}" for name in matched_imports[:2])

    risk_signal_overlap = 0.0
    risks = _terms(query.risk_terms)
    matched_risks = sorted(risks & content)
    if matched_risks:
        risk_signal_overlap = min(0.20, 0.07 * len(matched_risks))
        reasons.extend(f"overlaps with {risk} risk signal" for risk in matched_risks[:3])

    changed_line_proximity = 0.0
    primary_region = str(query.metadata.get("primary_risk_region") or "")
    if candidate.kind == "changed_hunk":
        changed_line_proximity = 0.12
        reasons.append("changed hunk evidence receives proximity boost")
    elif primary_region and candidate.start_line:
        numbers = [int(value) for value in re.findall(r"\d+", primary_region)]
        if numbers and min(abs(candidate.start_line - number) for number in numbers) <= 10:
            changed_line_proximity = 0.08
            reasons.append("near primary risk region")

    severity_boost = 0.0
    severity = str(candidate.metadata.get("severity") or candidate.metadata.get("risk_level") or "").lower()
    if severity in {"critical", "high"}:
        severity_boost = 0.08
        reasons.append("high severity evidence")

    history_boost = 0.0
    if candidate.kind in {"history_signal", "evolution_hint"}:
        history_boost = 0.08
        reasons.append("history evidence supports reviewer prioritization")

    security_boost = 0.0
    if candidate.kind == "security_hint" or "security" in content:
        security_boost = 0.10
        reasons.append("security evidence receives override boost")

    local_similarity = _local_similarity(query, candidate)
    if local_similarity >= 0.04:
        reasons.append("local similarity matched query context")

    total = round(
        path_relevance
        + symbol_overlap
        + import_overlap
        + risk_signal_overlap
        + changed_line_proximity
        + severity_boost
        + history_boost
        + security_boost
        + local_similarity,
        4,
    )
    if not reasons:
        reasons.append("low lexical overlap with retrieval query")

    return EvidenceScore(
        total=total,
        path_relevance=round(path_relevance, 4),
        symbol_overlap=round(symbol_overlap, 4),
        import_overlap=round(import_overlap, 4),
        risk_signal_overlap=round(risk_signal_overlap, 4),
        changed_line_proximity=round(changed_line_proximity, 4),
        severity_boost=round(severity_boost, 4),
        history_boost=round(history_boost, 4),
        security_boost=round(security_boost, 4),
        local_similarity=round(local_similarity, 4),
        reasons=reasons,
    )
