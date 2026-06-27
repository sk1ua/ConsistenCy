"""Build structured retrieval queries from PR file results."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any

from .models import EvidenceQuery

_IDENT_RE = re.compile(r"\b(?:class|def|function|const|let|var|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)")
_IMPORT_RE = re.compile(
    r"^\s*(?:from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)|import\s+([A-Za-z0-9_\.,\s]+)|"
    r"import\s+\{?([^}]+)\}?\s+from\s+['\"]([^'\"]+)['\"])",
    re.MULTILINE,
)
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
_RISK_KEYS = ("security", "semantic", "structural", "duplication", "style", "evolution")


def _dedupe(items: list[str], limit: int = 12) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        cleaned = item.strip().strip("`'\"")
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
        if len(result) >= limit:
            break
    return result


def _path_terms(filepath: str) -> list[str]:
    path = PurePosixPath(filepath.replace("\\", "/"))
    terms: list[str] = []
    for part in path.parts:
        stem = PurePosixPath(part).stem
        for token in re.split(r"[^A-Za-z0-9]+|_", stem):
            if token:
                terms.append(token)
    return _dedupe(terms)


def _symbols_from_code(*chunks: str) -> list[str]:
    symbols: list[str] = []
    for chunk in chunks:
        symbols.extend(match.group(1) for match in _IDENT_RE.finditer(chunk or ""))
    return _dedupe(symbols)


def _imports_from_code(*chunks: str) -> list[str]:
    imports: list[str] = []
    for chunk in chunks:
        for match in _IMPORT_RE.finditer(chunk or ""):
            imports.extend(part for part in match.groups() if part)
    tokens: list[str] = []
    for item in imports:
        tokens.extend(_TOKEN_RE.findall(item))
    return _dedupe(tokens)


def _risk_terms(file_result: dict[str, Any], agent_signals: dict[str, Any]) -> list[str]:
    terms: list[str] = []
    terms.extend(str(value) for value in file_result.get("dominant_signals", []) if value)

    breakdown = file_result.get("risk_breakdown") or file_result.get("breakdown") or {}
    for key in _RISK_KEYS:
        if float(breakdown.get(key, 0.0) or 0.0) >= 0.15:
            terms.append(key)

    for key, values in agent_signals.items():
        if values:
            terms.append(str(key))
    return _dedupe(terms)


def build_evidence_query(
    file_result: dict[str, Any],
    *,
    diff_excerpt: str = "",
    code_excerpt: str = "",
    agent_signals: dict[str, Any] | None = None,
) -> EvidenceQuery:
    """Return a structured query for deterministic evidence retrieval."""
    filepath = str(file_result.get("file", ""))
    signals = agent_signals or {}
    symbols = _symbols_from_code(code_excerpt, diff_excerpt)
    imports = _imports_from_code(code_excerpt, diff_excerpt)
    risks = _risk_terms(file_result, signals)

    primary_region = file_result.get("primary_risk_region")
    metadata = {
        "rank_in_pr": file_result.get("rank_in_pr"),
        "primary_risk_region": primary_region,
        "risk": file_result.get("risk", file_result.get("avg_risk")),
    }
    tokens = risks + symbols + imports
    natural = " ".join(_dedupe(tokens, limit=20))
    if natural:
        natural = f"{natural} around {filepath}"
    else:
        natural = f"review evidence around {filepath}"

    return EvidenceQuery(
        file=filepath,
        path_terms=_path_terms(filepath),
        symbol_terms=symbols,
        import_terms=imports,
        risk_terms=risks,
        natural_query=natural,
        metadata=metadata,
    )
