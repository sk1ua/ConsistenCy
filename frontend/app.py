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
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

# Ensure backend package is importable when run directly
_BACKEND = Path(__file__).parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from flask import Flask, abort, jsonify, render_template, request

from src.agents import (
    DuplicationAgent,
    EvolutionAgent,
    ParserAgent,
    RiskScoringAgent,
    SemanticAgent,
    StructuralAgent,
    StyleAgent,
)
from src.pipeline import AnalysisPipeline, analyze_sources

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["JSON_SORT_KEYS"] = False

# ---------------------------------------------------------------------------
# Rate limiting (simple token-bucket, no external dependency)
# ---------------------------------------------------------------------------

_RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "60"))
_rate_limit_store: dict[str, tuple[float, int]] = {}  # ip → (window_start, count)
_rate_limit_lock = Lock()


@app.before_request
def _rate_limit_check() -> None:
    """Simple sliding-window rate limiter per client IP."""
    if request.path == "/api/health":
        return  # health check is always allowed

    now = time.time()
    client_ip = request.remote_addr or "127.0.0.1"

    with _rate_limit_lock:
        window_start, count = _rate_limit_store.get(client_ip, (now, 0))
        if now - window_start > 60.0:
            window_start, count = now, 0
        count += 1
        _rate_limit_store[client_ip] = (window_start, count)

        # Clean up stale entries periodically
        if len(_rate_limit_store) > 10_000:
            stale = [ip for ip, (ws, _) in _rate_limit_store.items() if now - ws > 60.0]
            for ip in stale:
                _rate_limit_store.pop(ip, None)

    if count > _RATE_LIMIT_PER_MINUTE:
        abort(429, description="Rate limit exceeded. Try again later.")

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


def _handle_exception(exc: Exception, operation: str) -> tuple:
    """Sanitized exception handler - logs details, returns safe error to client.
    
    Parameters
    ----------
    exc : Exception
        The caught exception
    operation : str
        Description of the operation that failed (e.g., "analyze", "export")
        
    Returns
    -------
    tuple
        Flask response tuple (jsonify, status_code)
    """
    import logging
    # Log full exception details server-side
    logging.error(f"{operation} failed: {exc}", exc_info=True)
    # Return sanitized error to client (no internal details exposed)
    return _error(
        f"{operation.capitalize()} failed. Please try again or contact support.",
        f"{operation.upper()}_FAILED",
        500
    )


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


@app.route("/showcase")
def showcase():
    """Portfolio-ready multi-agent collaboration view."""
    return render_template("showcase.html")


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------


@app.route("/api/health")
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "version": "2.5.0"})


@app.route("/api/demo/collaboration")
def demo_collaboration():
    """Return a deterministic no-Git multi-agent collaboration demo payload."""
    root = Path(__file__).parent.parent
    base_path = root / "examples" / "demo_base.py"
    new_path = root / "examples" / "demo_new.py"
    try:
        source_base = base_path.read_text(encoding="utf-8")
        source_now = new_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        source_base = "def load_user_profile(user_id):\n    return {'id': user_id}\n"
        source_now = (
            "import sqlite3\n"
            "TOKEN = 'sk_live_demo_token'\n"
            "def loadUserProfile(userId):\n"
            "    query = \"select * from users where id = '%s'\" % userId\n"
            "    return sqlite3.connect('profiles.db').execute(query).fetchone()\n"
        )

    result = analyze_sources(
        source_now,
        source_base,
        filepath="examples/demo_new.py",
    )
    board = result.get("agent_collaboration", {})
    votes = board.get("votes", [])
    payload = {
        "scenario": {
            "title": "Profile service PR",
            "base_file": "examples/demo_base.py",
            "changed_file": "examples/demo_new.py",
            "summary": "A small PR adds database access, broadens API behavior, and introduces security-sensitive evidence.",
        },
        "risk": {
            "score": result.get("risk_score", 0.0),
            "level": result.get("risk_level", "Unknown"),
            "colour": result.get("risk_colour", "GREEN"),
        },
        "signals": result.get("breakdown", {}),
        "signal_composition": result.get("signal_composition", {}),
        "dominant_signals": result.get("dominant_signals", []),
        "agent_collaboration": board,
        "review_queue": board.get("review_queue", []),
        "top_findings": board.get("top_findings", []),
        "votes": votes,
        "evidence_chain": result.get("explainability", {}).get("evidence_chain", []),
    }
    return jsonify(payload)


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
        import logging
        logging.error(f"Analysis failed: {exc}")
        # Sanitized error - don't expose internal details
        return _error("Analysis failed. Check server logs.", "ANALYSIS_FAILED", 500)


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
        return _handle_exception(exc, "history")


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
        return _handle_exception(exc, "files")


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
        return _handle_exception(exc, "authors")


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
        return _handle_exception(exc, "hotspots")


@app.route("/api/analyze-range", methods=["POST"])
def analyze_range():
    """Analyze risk over a time range.
    
    Request JSON
    ------------
    {
      "repo_path": "/path/to/repo",
      "weeks": 12,
      "baseline_commits": 50,
      "max_commits": 40
    }
    """
    body: dict[str, Any] = request.get_json(silent=True) or {}
    repo_path = body.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    weeks, weeks_err = _parse_int_arg("weeks", body.get("weeks", 12), 1, 52)
    if weeks_err:
        return weeks_err

    baseline_n, baseline_err = _parse_int_arg(
        "baseline_commits", body.get("baseline_commits", 50), 1, 500
    )
    if baseline_err:
        return baseline_err

    max_commits, max_err = _parse_int_arg(
        "max_commits", body.get("max_commits", 40), 1, 200
    )
    if max_err:
        return max_err

    cache_key = _cache_key(
        endpoint="analyze_range",
        repo_path=repo_path,
        params={"weeks": weeks, "baseline_commits": baseline_n, "max_commits": max_commits},
    )

    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        pipeline = AnalysisPipeline(repo_path)
        report = pipeline.analyze_range(
            weeks=weeks, baseline_n=baseline_n, max_commits=max_commits
        )
        _cache_set(cache_key, report)
        return jsonify(report)
    except Exception as exc:
        return _handle_exception(exc, "range")


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
    except Exception as exc:
        return _handle_exception(exc, "pr_report")


@app.route("/api/export", methods=["POST"])
def export_data():
    """Export analysis data in various formats.
    
    Request JSON
    ------------
    {
      "repo_path": "/path/to/repo",
      "format": "json",  # json, csv, markdown
      "weeks": 12
    }
    """
    body: dict[str, Any] = request.get_json(silent=True) or {}
    repo_path = body.get("repo_path", "")
    repo_err = _validate_repo_path(repo_path)
    if repo_err:
        return repo_err

    fmt = body.get("format", "json")
    weeks = body.get("weeks", 12)

    try:
        pipeline = AnalysisPipeline(repo_path)
        
        # Get all data
        history = pipeline.weekly_history(weeks=weeks)
        files = pipeline.file_summary()
        authors = pipeline.author_breakdown()
        hotspots = pipeline.hotspot_data()
        
        # Get latest commit analysis
        latest = pipeline.analyze_commit()

        export_data = {
            "repo_path": repo_path,
            "export_time": datetime.now(timezone.utc).isoformat(),
            "format": fmt,
            "summary": {
                "avg_risk": latest.get("final_risk_score", 0),
                "risk_level": latest.get("risk_level", "unknown"),
                "files_analyzed": latest.get("files_analyzed", 0),
            },
            "history": history,
            "files": files,
            "authors": authors,
            "hotspots": hotspots,
        }

        if fmt == "json":
            return jsonify(export_data)
        elif fmt == "csv":
            # Return files as CSV
            return jsonify({
                "format": "csv",
                "data": files,
                "filename": f"consistency-export-{datetime.now().strftime('%Y%m%d')}.csv"
            })
        elif fmt == "markdown":
            return jsonify({
                "format": "markdown",
                "data": export_data,
                "filename": f"consistency-report-{datetime.now().strftime('%Y%m%d')}.md"
            })
        else:
            return _error(f"Unsupported format: {fmt}", "INVALID_FORMAT", 400)
            
    except Exception as exc:
        return _handle_exception(exc, "export")


# ---------------------------------------------------------------------------
# Dev entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # Debug mode controlled by environment, default False for security
    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
