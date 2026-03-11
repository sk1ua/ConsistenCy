# -*- coding: utf-8 -*-
"""
ConsistenCy Web Dashboard
=========================
Flask application that serves the analysis dashboard.

Routes
------
GET  /                  → Dashboard home (index.html)
POST /api/analyze       → Run multi-agent analysis on a local repo path
GET  /api/repo/history  → Return time-series risk scores for a repo
GET  /api/repo/files    → Return per-file analysis summary
GET  /api/repo/authors  → Return per-author risk breakdown
GET  /api/repo/hotspots → Return technical-debt hotspot data
POST /api/pr/report     → Return initial PR risk report for base_ref..head_ref
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path
from threading import Lock
from typing import Any

# Ensure backend package is importable when run directly
_BACKEND = Path(__file__).parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from flask import Flask, jsonify, render_template, request

from src.agents import (
    DuplicationAgent,
    EvolutionAgent,
    ParserAgent,
    RiskScoringAgent,
    SemanticAgent,
    StructuralAgent,
    StyleAgent,
)
from src.pipeline import AnalysisPipeline

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["JSON_SORT_KEYS"] = False

_CACHE_DIR = Path(__file__).parent.parent / "data" / "cache"
_CACHE_FILE = _CACHE_DIR / "dashboard_api_cache.json"
_CACHE_TTL_SECONDS = int(os.environ.get("CONSISTENCYCY_DASHBOARD_CACHE_TTL", "300"))
_CACHE_MAX_ENTRIES = int(os.environ.get("CONSISTENCYCY_DASHBOARD_CACHE_MAX_ENTRIES", "300"))
_cache_lock = Lock()

_parser = ParserAgent()
_style = StyleAgent()
_structural = StructuralAgent()
_semantic = SemanticAgent()
_evolution = EvolutionAgent()
_duplication = DuplicationAgent()
_risk = RiskScoringAgent()


def _load_cache() -> dict[str, dict[str, Any]]:
    """Load dashboard API cache from JSON file."""
    try:
        if not _CACHE_FILE.exists():
            return {}
        payload = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        entries = payload.get("entries", {})
        return entries if isinstance(entries, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _save_cache(cache_entries: dict[str, dict[str, Any]]) -> None:
    """Persist dashboard API cache to disk."""
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"entries": cache_entries}
    _CACHE_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def _cache_key(endpoint: str, repo_path: str, params: dict[str, Any] | None = None) -> str:
    """Return a deterministic cache key from endpoint and parameters."""
    raw = {
        "endpoint": endpoint,
        "repo_path": str(Path(repo_path).resolve()),
        "params": params or {},
    }
    digest = hashlib.sha1(
        json.dumps(raw, ensure_ascii=True, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return digest


_cache_entries = _load_cache()


def _cache_get(key: str) -> Any | None:
    """Get cached API payload if key exists and has not expired."""
    with _cache_lock:
        entry = _cache_entries.get(key)
        if not entry:
            return None

        created_at = float(entry.get("created_at", 0.0))
        if (time.time() - created_at) > _CACHE_TTL_SECONDS:
            _cache_entries.pop(key, None)
            _save_cache(_cache_entries)
            return None

        return entry.get("payload")


def _cache_set(key: str, payload: Any) -> None:
    """Store payload in cache and flush to disk."""
    with _cache_lock:
        _cache_entries[key] = {
            "created_at": time.time(),
            "payload": payload,
        }

        # Keep cache size bounded by dropping oldest entries.
        if len(_cache_entries) > _CACHE_MAX_ENTRIES:
            overflow = len(_cache_entries) - _CACHE_MAX_ENTRIES
            oldest = sorted(
                _cache_entries.items(),
                key=lambda kv: float(kv[1].get("created_at", 0.0)),
            )[:overflow]
            for old_key, _ in oldest:
                _cache_entries.pop(old_key, None)

        _save_cache(_cache_entries)


def _cache_clear() -> None:
    """Clear in-memory and on-disk cache (used by tests and maintenance)."""
    with _cache_lock:
        _cache_entries.clear()
        _save_cache(_cache_entries)


def _error(message: str, code: str, status: int):
    """Standard API error shape."""
    return jsonify({"error": message, "code": code}), status


def _validate_repo_path(repo_path: str, required_message: str = "repo_path is required"):
    """Validate repo_path presence and directory existence."""
    if not repo_path:
        return _error(required_message, "MISSING_REPO_PATH", 400)
    if not Path(repo_path).is_dir():
        return _error("repo_path must be a valid directory", "INVALID_REPO_PATH", 400)
    return None


def _parse_int_arg(name: str, value: Any, min_value: int, max_value: int):
    """Parse and validate bounded integer query/body parameter."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None, _error(
            f"{name} must be an integer",
            f"INVALID_{name.upper()}",
            422,
        )
    if parsed < min_value or parsed > max_value:
        return None, _error(
            f"{name} must be between {min_value} and {max_value}",
            f"INVALID_{name.upper()}",
            422,
        )
    return parsed, None


# ---------------------------------------------------------------------------
# HTML views
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """Analyze a single commit's Python files against the project baseline.

    Request JSON
    ------------
    {
        "repo_path": "/path/to/repo",
        "commit_sha": "abc1234",          # optional — uses HEAD if omitted
        "baseline_commits": 50            # optional — how many commits to baseline
    }
    """
    body: dict[str, Any] = request.get_json(silent=True) or {}
    repo_path = body.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    commit_sha = body.get("commit_sha")
    baseline_n, parse_err = _parse_int_arg(
        "baseline_commits",
        body.get("baseline_commits", 50),
        1,
        500,
    )
    if parse_err:
        return parse_err

    cache_key = _cache_key(
        endpoint="analyze",
        repo_path=repo_path,
        params={"commit_sha": commit_sha or "HEAD", "baseline_commits": baseline_n},
    )

    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        pipeline = AnalysisPipeline(repo_path)
        result = pipeline.analyze_commit(commit_sha=commit_sha, baseline_n=baseline_n)
        _cache_set(cache_key, result)
        return jsonify(result)
    except Exception as exc:  # noqa: BLE001
        return _error(str(exc), "INTERNAL_ERROR", 500)


@app.route("/api/repo/history")
def repo_history():
    """Return weekly risk-score time series.

    Query params: repo_path, weeks (default 12)
    """
    repo_path = request.args.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    weeks, parse_err = _parse_int_arg("weeks", request.args.get("weeks", 12), 1, 260)
    if parse_err:
        return parse_err

    cache_key = _cache_key(
        endpoint="repo_history",
        repo_path=repo_path,
        params={"weeks": weeks},
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        pipeline = AnalysisPipeline(repo_path)
        history = pipeline.weekly_history(weeks=weeks)
        _cache_set(cache_key, history)
        return jsonify(history)
    except Exception as exc:  # noqa: BLE001
        return _error(str(exc), "INTERNAL_ERROR", 500)


@app.route("/api/repo/files")
def repo_files():
    """Return per-file analysis summary for the latest commit."""
    repo_path = request.args.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    cache_key = _cache_key(endpoint="repo_files", repo_path=repo_path)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        pipeline = AnalysisPipeline(repo_path)
        files = pipeline.file_summary()
        _cache_set(cache_key, files)
        return jsonify(files)
    except Exception as exc:  # noqa: BLE001
        return _error(str(exc), "INTERNAL_ERROR", 500)


@app.route("/api/repo/authors")
def repo_authors():
    """Return per-author risk contribution breakdown."""
    repo_path = request.args.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    cache_key = _cache_key(endpoint="repo_authors", repo_path=repo_path)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        pipeline = AnalysisPipeline(repo_path)
        authors = pipeline.author_breakdown()
        _cache_set(cache_key, authors)
        return jsonify(authors)
    except Exception as exc:  # noqa: BLE001
        return _error(str(exc), "INTERNAL_ERROR", 500)


@app.route("/api/repo/hotspots")
def repo_hotspots():
    """Return technical-debt hotspot data (high churn + high complexity files)."""
    repo_path = request.args.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    cache_key = _cache_key(endpoint="repo_hotspots", repo_path=repo_path)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        pipeline = AnalysisPipeline(repo_path)
        hotspots = pipeline.hotspot_data()
        _cache_set(cache_key, hotspots)
        return jsonify(hotspots)
    except Exception as exc:  # noqa: BLE001
        return _error(str(exc), "INTERNAL_ERROR", 500)


@app.route("/api/pr/report", methods=["POST"])
def pr_report():
    """Return initial PR risk report for base_ref..head_ref commit range.

    Request JSON
    ------------
    {
      "repo_path": "/path/to/repo",
      "base_ref": "origin/main",
      "head_ref": "HEAD",            # optional
      "baseline_commits": 50,          # optional
      "max_commits": 40                # optional
    }
    """
    body: dict[str, Any] = request.get_json(silent=True) or {}
    repo_path = body.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    base_ref = str(body.get("base_ref", "")).strip()
    if not base_ref:
        return _error("base_ref is required", "MISSING_BASE_REF", 400)

    head_ref = str(body.get("head_ref", "HEAD")).strip() or "HEAD"

    baseline_n, baseline_err = _parse_int_arg(
        "baseline_commits",
        body.get("baseline_commits", 50),
        1,
        500,
    )
    if baseline_err:
        return baseline_err

    max_commits, max_err = _parse_int_arg(
        "max_commits",
        body.get("max_commits", 40),
        1,
        200,
    )
    if max_err:
        return max_err

    cache_key = _cache_key(
        endpoint="pr_report",
        repo_path=repo_path,
        params={
            "base_ref": base_ref,
            "head_ref": head_ref,
            "baseline_commits": baseline_n,
            "max_commits": max_commits,
        },
    )

    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        pipeline = AnalysisPipeline(repo_path)
        report = pipeline.pr_risk_report(
            base_ref=base_ref,
            head_ref=head_ref,
            baseline_n=baseline_n,
            max_commits=max_commits,
        )
        _cache_set(cache_key, report)
        return jsonify(report)
    except Exception as exc:  # noqa: BLE001
        return _error(str(exc), "INTERNAL_ERROR", 500)


# ---------------------------------------------------------------------------
# Dev entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=True)
