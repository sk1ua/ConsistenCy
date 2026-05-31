# -*- coding: utf-8 -*-
"""Tests for backend/src/exporter.py — ResultExporter.

Covers JSON, CSV, and SQLite export paths.  Parquet is skipped when
optional dependencies are not installed.
"""
from __future__ import annotations

import csv
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.exporter import ResultExporter  # noqa: E402


# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------

SAMPLE_RESULT = {
    "repo": "owner/repo",
    "analyzed_at": "2026-05-31T12:00:00",
    "overall_risk": 0.42,
    "risk_level": "Minor Drift",
    "commits": [
        {
            "sha": "abc123",
            "author": "alice",
            "date": "2026-05-30T10:00:00",
            "risk_score": 0.35,
            "risk_level": "Consistent",
            "files_analyzed": 3,
        },
        {
            "sha": "def456",
            "author": "bob",
            "date": "2026-05-29T10:00:00",
            "risk_score": 0.61,
            "risk_level": "Significant Drift",
            "files_analyzed": 5,
        },
    ],
}

SAMPLE_COMMITS = [
    {"sha": "abc", "author": "a", "date": "2026-01-01", "risk_score": 0.3, "files_analyzed": 2},
    {"sha": "def", "author": "b", "date": "2026-01-02", "risk_score": 0.7, "files_analyzed": 4},
]

SAMPLE_FILE_RESULTS = [
    {"filepath": "src/a.py", "commit_sha": "abc"},
    {"filepath": "src/b.py", "commit_sha": "def"},
]


# ---------------------------------------------------------------------------
# JSON
# ---------------------------------------------------------------------------

class TestExportJson:
    def test_pretty_json(self, tmp_path: Path):
        out = tmp_path / "report.json"
        ok = ResultExporter.export_json(SAMPLE_RESULT, out, pretty=True)
        assert ok
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data["overall_risk"] == 0.42
        assert len(data["commits"]) == 2

    def test_compact_json(self, tmp_path: Path):
        out = tmp_path / "compact.json"
        ok = ResultExporter.export_json(SAMPLE_RESULT, out, pretty=False)
        assert ok
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data["repo"] == "owner/repo"

    def test_nonexistent_directory_returns_false(self, tmp_path: Path):
        out = tmp_path / "deep" / "sub" / "report.json"
        ok = ResultExporter.export_json(SAMPLE_RESULT, out)
        assert ok is False  # does not auto-create parent directories


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

class TestExportCsv:
    def test_export_csv(self, tmp_path: Path):
        out = tmp_path / "commits.csv"
        ok = ResultExporter.export_csv(SAMPLE_COMMITS, out)
        assert ok
        with open(out, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        assert len(rows) == 2
        assert rows[0]["sha"] == "abc"
        assert "risk_score" in rows[0]

    def test_export_csv_empty_list_returns_false(self, tmp_path: Path):
        out = tmp_path / "empty.csv"
        ok = ResultExporter.export_csv([], out)
        assert ok is False  # empty list is rejected


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

class TestExportSqlite:
    def test_export_sqlite(self, tmp_path: Path):
        out = tmp_path / "analysis.db"
        ok = ResultExporter.export_sqlite(
            SAMPLE_COMMITS, SAMPLE_FILE_RESULTS, out
        )
        assert ok
        conn = sqlite3.connect(str(out))
        # Check commits table
        rows = conn.execute("SELECT commit_sha, author FROM commits").fetchall()
        assert len(rows) == 2
        # Check files table
        fr_rows = conn.execute(
            "SELECT filepath FROM files"
        ).fetchall()
        assert len(fr_rows) == 2
        conn.close()

    def test_export_sqlite_no_file_results(self, tmp_path: Path):
        out = tmp_path / "commits_only.db"
        ok = ResultExporter.export_sqlite(SAMPLE_COMMITS, [], out)
        assert ok
        conn = sqlite3.connect(str(out))
        rows = conn.execute("SELECT commit_sha FROM commits").fetchall()
        assert len(rows) == 2
        conn.close()


# ---------------------------------------------------------------------------
# Parquet (optional — skip when dependencies are missing)
# ---------------------------------------------------------------------------

class TestExportParquet:
    def test_export_parquet_or_graceful_skip(self, tmp_path: Path):
        out = tmp_path / "commits.parquet"
        try:
            import pyarrow  # noqa: F401
        except ImportError:
            # pyarrow not installed — verify the method returns False
            # rather than crashing
            ok = ResultExporter.export_parquet(SAMPLE_COMMITS, out)
            assert ok is False
        else:
            ok = ResultExporter.export_parquet(SAMPLE_COMMITS, out)
            assert ok
            assert out.exists()
