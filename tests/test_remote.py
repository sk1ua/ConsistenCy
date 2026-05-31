# -*- coding: utf-8 -*-
"""Tests for the remote analysis baseline strategy and cache compatibility.

These tests exercise the code paths added in Task A of the evaluation
enhancement work:

- ``RemoteFileAnalysis`` round-trips the new ``baseline_strategy``,
  ``current_ref`` and ``baseline_ref`` fields.
- The cache layer tolerates legacy entries that pre-date these fields.
- ``_analyze_commit`` records a meaningful baseline strategy for parent /
  new-file / no-parent scenarios without making real GitHub API calls.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.remote.github_client import CommitInfo, RepoMetadata  # noqa: E402
from src.remote.remote_pipeline import (  # noqa: E402
    RemoteAnalysisPipeline,
    RemoteCommitAnalysis,
    RemoteFileAnalysis,
)


# ---------------------------------------------------------------------------
# Dataclass serialization
# ---------------------------------------------------------------------------

def test_remote_file_analysis_defaults_for_legacy_payload():
    """Constructing without the new fields must not crash and must use the
    documented legacy default. This is the contract that lets old caches load."""
    f = RemoteFileAnalysis(
        path="src/foo.py",
        language="python",
        risk_score=0.42,
        risk_level="Minor Drift",
        breakdown={"style": 0.1},
        metrics={},
    )
    assert f.baseline_strategy == "unknown_legacy_cache"
    assert f.current_ref == ""
    assert f.baseline_ref is None


def test_remote_file_analysis_round_trip():
    f = RemoteFileAnalysis(
        path="src/foo.py",
        language="python",
        risk_score=0.42,
        risk_level="Minor Drift",
        breakdown={"style": 0.1},
        metrics={},
        baseline_strategy="parent_commit",
        current_ref="abc123",
        baseline_ref="def456",
    )
    payload = {
        "path": f.path,
        "language": f.language,
        "risk_score": f.risk_score,
        "risk_level": f.risk_level,
        "breakdown": f.breakdown,
        "metrics": f.metrics,
        "baseline_strategy": f.baseline_strategy,
        "current_ref": f.current_ref,
        "baseline_ref": f.baseline_ref,
    }
    raw = json.dumps(payload)
    rebuilt = RemoteFileAnalysis(**json.loads(raw))
    assert rebuilt.baseline_strategy == "parent_commit"
    assert rebuilt.current_ref == "abc123"
    assert rebuilt.baseline_ref == "def456"


# ---------------------------------------------------------------------------
# Pipeline + mocked GitHubClient
# ---------------------------------------------------------------------------

def _make_pipeline(tmp_path: Path) -> tuple[RemoteAnalysisPipeline, MagicMock]:
    client = MagicMock()
    pipeline = RemoteAnalysisPipeline(client, cache_dir=tmp_path)
    return pipeline, client


def _commit(sha: str, parents: list[str], filename: str = "src/foo.py") -> CommitInfo:
    return CommitInfo(
        sha=sha,
        message="msg",
        author_name="a",
        author_email=None,
        author_date=datetime.now(timezone.utc),
        committer_name="a",
        committer_date=datetime.now(timezone.utc),
        stats={"additions": 1, "deletions": 0, "total": 1},
        files=[{"filename": filename, "status": "modified"}],
        parents=[{"sha": p} for p in parents],
    )


def test_analyze_commit_uses_parent_commit_baseline(tmp_path: Path):
    pipeline, client = _make_pipeline(tmp_path)
    # current and parent versions both exist - true diff path
    fetch_results = {
        ("aaa", "src/foo.py"): "def f():\n    return 2\n",
        ("bbb", "src/foo.py"): "def f():\n    return 1\n",
    }
    client.get_file_content = lambda owner, repo, path, ref: fetch_results.get((ref, path))

    commit = _commit(sha="aaa", parents=["bbb"])
    result = pipeline._analyze_commit("o", "r", commit)

    assert result is not None
    assert len(result.file_results) == 1
    f = result.file_results[0]
    assert f.baseline_strategy == "parent_commit"
    assert f.current_ref == "aaa"
    assert f.baseline_ref == "bbb"


def test_analyze_commit_new_file_when_parent_missing(tmp_path: Path):
    pipeline, client = _make_pipeline(tmp_path)
    fetch_results = {("aaa", "src/foo.py"): "def f():\n    return 2\n"}
    client.get_file_content = lambda owner, repo, path, ref: fetch_results.get((ref, path))

    commit = _commit(sha="aaa", parents=["bbb"])
    result = pipeline._analyze_commit("o", "r", commit)

    assert result is not None
    f = result.file_results[0]
    assert f.baseline_strategy in {
        "new_file_template_baseline",  # baseline_strategy.get_template_baseline returned content
        "new_file_empty_baseline",     # template lookup returned nothing
    }
    assert f.current_ref == "aaa"
    assert f.baseline_ref is None


def test_analyze_commit_no_parent_uses_empty_baseline(tmp_path: Path):
    pipeline, client = _make_pipeline(tmp_path)
    client.get_file_content = lambda owner, repo, path, ref: (
        "def f():\n    return 2\n" if ref == "aaa" else None
    )

    commit = _commit(sha="aaa", parents=[])  # initial commit
    result = pipeline._analyze_commit("o", "r", commit)

    assert result is not None
    f = result.file_results[0]
    assert f.baseline_strategy == "empty_no_parent"
    assert f.current_ref == "aaa"
    assert f.baseline_ref is None


# ---------------------------------------------------------------------------
# Cache backwards compatibility
# ---------------------------------------------------------------------------

def test_cache_load_legacy_payload(tmp_path: Path):
    pipeline, _ = _make_pipeline(tmp_path)

    # Synthesize a cache row written by the pre-Task-A code (no new fields).
    legacy_payload = {
        "sha": "aaa",
        "message": "old",
        "author": "a",
        "date": datetime.now(timezone.utc).isoformat(),
        "risk_score": 0.3,
        "risk_level": "Minor Drift",
        "files_analyzed": 1,
        "file_results": [
            {
                "path": "src/foo.py",
                "language": "python",
                "risk_score": 0.3,
                "risk_level": "Minor Drift",
                "breakdown": {"style": 0.1},
                "metrics": {},
            }
        ],
        "evolution_score": 0.0,
    }
    conn = sqlite3.connect(str(pipeline.cache_db))
    conn.execute(
        "INSERT INTO analysis_cache VALUES (?, ?, ?, ?, ?)",
        ("o", "r", "aaa", json.dumps(legacy_payload),
         datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()

    cached = pipeline._get_cached_analysis("o", "r", "aaa")
    assert isinstance(cached, RemoteCommitAnalysis)
    f = cached.file_results[0]
    assert f.baseline_strategy == "unknown_legacy_cache"
    assert f.current_ref == ""
    assert f.baseline_ref is None


def test_cache_round_trip_preserves_strategy(tmp_path: Path):
    pipeline, _ = _make_pipeline(tmp_path)
    new_result = RemoteCommitAnalysis(
        sha="aaa", message="m", author="a",
        date=datetime.now(timezone.utc),
        risk_score=0.4, risk_level="Minor Drift",
        files_analyzed=1,
        file_results=[
            RemoteFileAnalysis(
                path="src/foo.py", language="python",
                risk_score=0.4, risk_level="Minor Drift",
                breakdown={}, metrics={},
                baseline_strategy="parent_commit",
                current_ref="aaa", baseline_ref="bbb",
            )
        ],
        evolution_score=0.0,
    )
    pipeline._cache_analysis("o", "r", "aaa", new_result)
    rebuilt = pipeline._get_cached_analysis("o", "r", "aaa")
    assert rebuilt is not None
    f = rebuilt.file_results[0]
    assert f.baseline_strategy == "parent_commit"
    assert f.current_ref == "aaa"
    assert f.baseline_ref == "bbb"
