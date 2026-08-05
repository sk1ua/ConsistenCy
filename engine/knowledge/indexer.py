# -*- coding: utf-8 -*-
"""Incremental code knowledge graph backed by SQLite.

Indexes functions, classes, imports, and intra-project call edges so LLM
synthesis can be handed *historical* context rather than only the current diff.

Incremental by content hash: a file whose SHA-256 is unchanged is not reparsed,
so a pulse over an unchanged tree costs one hash per file and no AST work.
"""
from __future__ import annotations

import ast
import hashlib
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_sha TEXT NOT NULL,
  language TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('function', 'class', 'method')),
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS symbols_file_idx ON symbols(file_path);
CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  module TEXT NOT NULL,
  symbol TEXT,
  line INTEGER NOT NULL,
  FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS imports_file_idx ON imports(file_path);
CREATE INDEX IF NOT EXISTS imports_module_idx ON imports(module);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_file TEXT NOT NULL,
  caller_symbol TEXT NOT NULL,
  callee_file TEXT NOT NULL,
  callee_symbol TEXT NOT NULL,
  line INTEGER NOT NULL,
  FOREIGN KEY (caller_file) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS calls_callee_idx ON calls(callee_file, callee_symbol);
CREATE INDEX IF NOT EXISTS calls_caller_idx ON calls(caller_file);

CREATE TABLE IF NOT EXISTS historical_fixes (
  reference TEXT NOT NULL,
  file TEXT NOT NULL,
  summary TEXT NOT NULL,
  fixed_at TEXT NOT NULL,
  severity TEXT,
  PRIMARY KEY (reference, file)
);

CREATE INDEX IF NOT EXISTS historical_fixes_file_idx ON historical_fixes(file);

CREATE TABLE IF NOT EXISTS security_reports (
  job_id TEXT NOT NULL,
  file TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, file, title)
);

CREATE INDEX IF NOT EXISTS security_reports_file_idx ON security_reports(file);
"""

LANGUAGE_BY_SUFFIX = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def content_sha(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def language_for(path: str) -> str:
    return LANGUAGE_BY_SUFFIX.get(Path(path).suffix.lower(), "unknown")


def module_name_for(path: str) -> str:
    trimmed = path[:-3] if path.endswith(".py") else path
    trimmed = trimmed.replace("\\", "/")
    if trimmed.endswith("/__init__"):
        trimmed = trimmed[: -len("/__init__")]
    return trimmed.strip("/").replace("/", ".")


@dataclass(frozen=True, slots=True)
class IndexStats:
    """What one `index_files` call actually did."""

    indexed: int = 0
    unchanged: int = 0
    removed: int = 0
    skipped: int = 0
    symbols: int = 0

    @property
    def touched(self) -> int:
        return self.indexed + self.removed


@dataclass(frozen=True, slots=True)
class _ParsedFile:
    symbols: tuple[tuple[str, str, str, int, int], ...]
    imports: tuple[tuple[str, str | None, int], ...]
    calls: tuple[tuple[str, str, int], ...]


class _PythonVisitor(ast.NodeVisitor):
    """Collects definitions, imports, and calls with their enclosing scope."""

    def __init__(self, module: str) -> None:
        self.module = module
        self.symbols: list[tuple[str, str, str, int, int]] = []
        self.imports: list[tuple[str, str | None, int]] = []
        self.calls: list[tuple[str, str, int]] = []
        self._scope: list[str] = []

    def _qualified(self, name: str) -> str:
        return ".".join([*self._scope, name])

    def _visit_definition(self, node: Any, kind: str) -> None:
        qualified = self._qualified(node.name)
        effective = "method" if kind == "function" and self._scope else kind
        self.symbols.append((
            effective,
            node.name,
            qualified,
            node.lineno,
            getattr(node, "end_lineno", node.lineno) or node.lineno,
        ))
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self._visit_definition(node, "function")

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self._visit_definition(node, "function")

    def visit_ClassDef(self, node: ast.ClassDef) -> None:  # noqa: N802
        self._visit_definition(node, "class")

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for alias in node.names:
            self.imports.append((alias.name, None, node.lineno))
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        package = self.module.rsplit(".", 1)[0] if "." in self.module else ""
        if node.level and package:
            base = package.rsplit(".", node.level - 1)[0] if node.level > 1 else package
            base = f"{base}.{node.module}" if node.module else base
        else:
            base = node.module or ""
        if base:
            for alias in node.names:
                self.imports.append((base, alias.name, node.lineno))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        caller = ".".join(self._scope) if self._scope else "<module>"
        target = node.func
        if isinstance(target, ast.Name):
            self.calls.append((caller, target.id, node.lineno))
        elif isinstance(target, ast.Attribute):
            self.calls.append((caller, target.attr, node.lineno))
        self.generic_visit(node)


def _parse_python(path: str, content: str) -> _ParsedFile | None:
    try:
        tree = ast.parse(content)
    except SyntaxError:
        # An unparsable file is not a defect to report here; it simply cannot
        # contribute to the graph until it parses.
        return None
    visitor = _PythonVisitor(module_name_for(path))
    visitor.visit(tree)
    return _ParsedFile(
        symbols=tuple(visitor.symbols),
        imports=tuple(visitor.imports),
        calls=tuple(visitor.calls),
    )


class KnowledgeIndex:
    """Persistent code graph over a repository."""

    def __init__(self, database_path: str | Path = ".consistency/knowledge_graph.sqlite") -> None:
        self.path = Path(database_path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(self.path))
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.executescript(_SCHEMA)
        self._connection.execute(
            "INSERT OR REPLACE INTO index_meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        self._connection.commit()

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "KnowledgeIndex":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # ------------------------------------------------------------------ index

    def indexed_files(self) -> dict[str, str]:
        rows = self._connection.execute("SELECT path, content_sha FROM files").fetchall()
        return {row["path"]: row["content_sha"] for row in rows}

    def index_files(
        self,
        files: Mapping[str, str],
        *,
        prune_missing: bool = True,
        max_file_bytes: int = 1_048_576,
    ) -> IndexStats:
        """Bring the index in line with `files`.

        Only files whose content hash changed are reparsed. When `prune_missing`
        is set, files absent from `files` are dropped, so a rename does not leave
        a phantom node behind.
        """
        existing = self.indexed_files()
        indexed = unchanged = removed = skipped = symbol_count = 0

        with self._connection:
            for path, content in files.items():
                size = len(content.encode("utf-8"))
                if size > max_file_bytes:
                    skipped += 1
                    continue

                sha = content_sha(content)
                if existing.get(path) == sha:
                    unchanged += 1
                    continue

                self._write_file(path, content, sha, size)
                indexed += 1
                symbol_count += self._connection.execute(
                    "SELECT COUNT(*) AS total FROM symbols WHERE file_path = ?", (path,)
                ).fetchone()["total"]

            if prune_missing:
                for path in existing:
                    if path not in files:
                        self._connection.execute("DELETE FROM files WHERE path = ?", (path,))
                        removed += 1

            self._resolve_calls()

        return IndexStats(
            indexed=indexed,
            unchanged=unchanged,
            removed=removed,
            skipped=skipped,
            symbols=symbol_count,
        )

    def _write_file(self, path: str, content: str, sha: str, size: int) -> None:
        # ON DELETE CASCADE clears the previous symbols/imports for this file.
        self._connection.execute("DELETE FROM files WHERE path = ?", (path,))
        self._connection.execute(
            "INSERT INTO files (path, content_sha, language, size_bytes, indexed_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (path, sha, language_for(path), size, _now()),
        )

        if language_for(path) != "python":
            # Other languages are recorded as nodes; symbol extraction for them
            # can reuse engine/parsers/tree_sitter_parser.py when wired in.
            return

        parsed = _parse_python(path, content)
        if parsed is None:
            return

        self._connection.executemany(
            "INSERT INTO symbols (file_path, kind, name, qualified_name, start_line, end_line)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            [(path, kind, name, qualified, start, end) for kind, name, qualified, start, end in parsed.symbols],
        )
        self._connection.executemany(
            "INSERT INTO imports (file_path, module, symbol, line) VALUES (?, ?, ?, ?)",
            [(path, module, symbol, line) for module, symbol, line in parsed.imports],
        )
        self._connection.execute("DELETE FROM calls WHERE caller_file = ?", (path,))
        self._pending_calls(path, parsed)

    def _pending_calls(self, path: str, parsed: _ParsedFile) -> None:
        self._connection.executemany(
            "INSERT INTO calls (caller_file, caller_symbol, callee_file, callee_symbol, line)"
            " VALUES (?, ?, '', ?, ?)",
            [(path, caller, callee, line) for caller, callee, line in parsed.calls],
        )

    def _resolve_calls(self) -> None:
        """Bind unresolved call edges to files that define the callee.

        Only edges whose callee is defined exactly once across the indexed
        project are bound; an ambiguous name would produce a guess, and a guess
        in a caller graph is worse than a gap.
        """
        defining = self._connection.execute(
            "SELECT name, MIN(file_path) AS file_path, COUNT(DISTINCT file_path) AS files"
            " FROM symbols GROUP BY name"
        ).fetchall()
        unique = {row["name"]: row["file_path"] for row in defining if row["files"] == 1}

        unresolved = self._connection.execute(
            "SELECT id, callee_symbol FROM calls WHERE callee_file = ''"
        ).fetchall()
        updates = [
            (unique[row["callee_symbol"]], row["id"])
            for row in unresolved
            if row["callee_symbol"] in unique
        ]
        if updates:
            self._connection.executemany("UPDATE calls SET callee_file = ? WHERE id = ?", updates)
        self._connection.execute("DELETE FROM calls WHERE callee_file = ''")

    # ---------------------------------------------------------- project memory

    def record_historical_fix(
        self,
        *,
        reference: str,
        file: str,
        summary: str,
        fixed_at: str,
        severity: str | None = None,
    ) -> None:
        self._connection.execute(
            "INSERT OR REPLACE INTO historical_fixes (reference, file, summary, fixed_at, severity)"
            " VALUES (?, ?, ?, ?, ?)",
            (reference, file, summary, fixed_at, severity),
        )
        self._connection.commit()

    def record_security_finding(
        self,
        *,
        job_id: str,
        file: str,
        title: str,
        severity: str,
        reported_at: str,
        resolved: bool = False,
    ) -> None:
        self._connection.execute(
            "INSERT OR REPLACE INTO security_reports (job_id, file, title, severity, reported_at, resolved)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (job_id, file, title, severity, reported_at, 1 if resolved else 0),
        )
        self._connection.commit()

    def unresolved_findings_for(self, files: Iterable[str]) -> list[sqlite3.Row]:
        """Open security findings recorded against any of `files`."""
        paths = [path.replace("\\", "/") for path in files]
        if not paths:
            return []
        placeholders = ",".join("?" for _ in paths)
        return self._connection.execute(
            f"SELECT job_id, file, title, severity, reported_at FROM security_reports"
            f" WHERE resolved = 0 AND file IN ({placeholders})",
            paths,
        ).fetchall()

    def record_review(
        self,
        *,
        job_id: str,
        reference: str,
        reported_at: str,
        covered_files: Iterable[str],
        findings: Iterable[Mapping[str, Any]],
    ) -> dict[str, int]:
        """Fold one completed review into project memory.

        A finding previously open against a covered file that the new review no
        longer reports is treated as resolved and becomes a historical fix. Only
        *covered* files are considered: a file this review never looked at
        cannot have had its findings fixed by it.
        """
        covered = [path.replace("\\", "/") for path in covered_files]
        incoming = [
            {
                "file": str(finding["file"]).replace("\\", "/"),
                "title": str(finding["title"]),
                "severity": str(finding.get("severity", "info")),
            }
            for finding in findings
            if finding.get("file") and finding.get("title")
        ]
        incoming_keys = {(item["file"], item["title"]) for item in incoming}

        resolved = 0
        with self._connection:
            for row in self.unresolved_findings_for(covered):
                if (row["file"], row["title"]) in incoming_keys:
                    continue
                self._connection.execute(
                    "UPDATE security_reports SET resolved = 1"
                    " WHERE job_id = ? AND file = ? AND title = ?",
                    (row["job_id"], row["file"], row["title"]),
                )
                self._connection.execute(
                    "INSERT OR REPLACE INTO historical_fixes"
                    " (reference, file, summary, fixed_at, severity) VALUES (?, ?, ?, ?, ?)",
                    (
                        reference,
                        row["file"],
                        f"Resolved: {row['title']}",
                        reported_at,
                        row["severity"],
                    ),
                )
                resolved += 1

            for item in incoming:
                self._connection.execute(
                    "INSERT OR REPLACE INTO security_reports"
                    " (job_id, file, title, severity, reported_at, resolved)"
                    " VALUES (?, ?, ?, ?, ?, 0)",
                    (job_id, item["file"], item["title"], item["severity"], reported_at),
                )

        return {"recorded": len(incoming), "resolved": resolved}

    # --------------------------------------------------------------- accessors

    def symbols_for(self, path: str) -> list[sqlite3.Row]:
        return self._connection.execute(
            "SELECT kind, name, qualified_name, start_line, end_line FROM symbols"
            " WHERE file_path = ? ORDER BY start_line",
            (path,),
        ).fetchall()

    def connection(self) -> sqlite3.Connection:
        return self._connection


def index_paths(index: KnowledgeIndex, root: str | Path, paths: Iterable[str]) -> IndexStats:
    """Index files read from disk relative to `root`, skipping unreadable ones."""
    base = Path(root)
    contents: dict[str, str] = {}
    for relative in paths:
        candidate = base / relative
        try:
            contents[relative.replace("\\", "/")] = candidate.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
    return index.index_files(contents, prune_missing=False)
