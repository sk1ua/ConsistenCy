# -*- coding: utf-8 -*-
"""Context augmentation queries over the knowledge index.

Returns the camelCase shape of ``relevantContextSchema`` in
``packages/schema/src/heartbeat.ts`` so results cross the stdio boundary without
a translation layer.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .indexer import KnowledgeIndex, module_name_for

DEFAULT_LIMIT = 10
MAX_LIMIT = 50

#: Relative weights for how strongly a module relates to the queried file.
_RELATION_WEIGHTS = {
    "imports": 0.8,
    "imported_by": 0.9,
    "test": 0.7,
    "sibling": 0.3,
}


@dataclass(frozen=True, slots=True)
class ContextQuery:
    file: str
    start_line: int | None = None
    end_line: int | None = None
    limit: int = DEFAULT_LIMIT

    def bounded_limit(self) -> int:
        return max(1, min(self.limit, MAX_LIMIT))


def _is_test_path(path: str) -> bool:
    name = Path(path).name
    return name.startswith("test_") or name.endswith("_test.py") or "/tests/" in f"/{path}"


def get_relevant_context(index: KnowledgeIndex, query: ContextQuery) -> dict[str, Any]:
    """Assemble historical and structural context for one file.

    Every bucket is capped at `limit` so a pathological file cannot flood the
    LLM prompt budget.
    """
    connection = index.connection()
    limit = query.bounded_limit()
    target = query.file.replace("\\", "/")

    historical_fixes = [
        {
            "reference": row["reference"],
            "file": row["file"],
            "summary": row["summary"],
            "fixedAt": row["fixed_at"],
            **({"severity": row["severity"]} if row["severity"] else {}),
        }
        for row in connection.execute(
            "SELECT reference, file, summary, fixed_at, severity FROM historical_fixes"
            " WHERE file = ? ORDER BY fixed_at DESC LIMIT ?",
            (target, limit),
        ).fetchall()
    ]

    past_security_reports = [
        {
            "jobId": row["job_id"],
            "file": row["file"],
            "title": row["title"],
            "severity": row["severity"],
            "reportedAt": row["reported_at"],
            "resolved": bool(row["resolved"]),
        }
        for row in connection.execute(
            "SELECT job_id, file, title, severity, reported_at, resolved FROM security_reports"
            " WHERE file = ? ORDER BY reported_at DESC LIMIT ?",
            (target, limit),
        ).fetchall()
    ]

    caller_graph = [
        {
            "callerFile": row["caller_file"],
            "callerSymbol": row["caller_symbol"],
            "calleeFile": row["callee_file"],
            "calleeSymbol": row["callee_symbol"],
            "depth": 1,
        }
        for row in connection.execute(
            "SELECT DISTINCT caller_file, caller_symbol, callee_file, callee_symbol FROM calls"
            " WHERE callee_file = ? AND caller_file <> ? ORDER BY caller_file LIMIT ?",
            (target, target, limit),
        ).fetchall()
    ]

    return {
        "historicalFixes": historical_fixes,
        "relatedModules": _related_modules(index, target, limit),
        "pastSecurityReports": past_security_reports,
        "callerGraph": caller_graph,
    }


def _candidate_modules(module: str, symbol: str | None) -> tuple[str, ...]:
    """Module names an import statement could be referring to.

    `from pkg import beta` is stored as module `pkg` with symbol `beta`, but the
    name it binds may itself be the module `pkg.beta`. Both are candidates; only
    those matching an indexed file are kept, so an attribute import adds nothing.
    """
    if symbol:
        return (module, f"{module}.{symbol}")
    return (module,)


def _related_modules(index: KnowledgeIndex, target: str, limit: int) -> list[dict[str, Any]]:
    connection = index.connection()
    target_module = module_name_for(target)
    related: dict[str, str] = {}

    paths = [row["path"] for row in connection.execute("SELECT path FROM files").fetchall()]
    path_by_module = {module_name_for(path): path for path in paths}

    all_imports = connection.execute(
        "SELECT file_path, module, symbol FROM imports"
    ).fetchall()

    for row in all_imports:
        candidates = _candidate_modules(row["module"], row["symbol"])
        if row["file_path"] == target:
            # Modules this file imports, resolved to indexed files.
            for candidate in candidates:
                resolved = path_by_module.get(candidate)
                if resolved is not None and resolved != target:
                    related.setdefault(resolved, "imports")
        elif target_module in candidates:
            # Modules that import this one. A test that imports the module is
            # both an importer and a test; "test" is the more actionable label
            # for a reviewer, so it wins.
            related[row["file_path"]] = (
                "test" if _is_test_path(row["file_path"]) else "imported_by"
            )

    # Tests naming this module, and same-directory siblings.
    directory = str(Path(target).parent).replace("\\", "/")
    for path in paths:
        if path == target or path in related:
            continue
        if _is_test_path(path) and Path(target).stem in path:
            related[path] = "test"
        elif str(Path(path).parent).replace("\\", "/") == directory:
            related.setdefault(path, "sibling")

    ordered = sorted(
        related.items(),
        key=lambda item: (-_RELATION_WEIGHTS.get(item[1], 0.0), item[0]),
    )
    return [
        {"path": path, "relation": relation, "weight": _RELATION_WEIGHTS.get(relation, 0.1)}
        for path, relation in ordered[:limit]
    ]
