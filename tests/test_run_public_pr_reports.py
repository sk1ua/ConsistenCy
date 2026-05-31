# -*- coding: utf-8 -*-
"""Tests for evaluation/scripts/run_public_pr_reports.py.

These tests use ``--dry-run`` so they never hit the network nor invoke
``git`` for real. The point is to verify the manifest-driven loop, the
summary-record shape, and that incomplete manifest entries are reported as
failures rather than crashing the batch.
"""
from __future__ import annotations

import json
import sys
from importlib import util
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "evaluation" / "scripts" / "run_public_pr_reports.py"

spec = util.spec_from_file_location("run_public_pr_reports", SCRIPT_PATH)
assert spec and spec.loader
module = util.module_from_spec(spec)
sys.modules["run_public_pr_reports"] = module
spec.loader.exec_module(module)

main = module.main
process_entry = module._process_entry
autoderived = module._autoderived_report_path


def test_autoderived_report_path():
    p = autoderived(
        {"repo": "owner/repo-name", "pr_number": 42},
        Path("/tmp/results"),
    )
    assert p.name == "owner__repo-name_pr42.json"


def test_process_entry_dry_run_records_dry_run_status(tmp_path):
    record = process_entry(
        {
            "repo": "owner/repo", "pr_number": 1,
            "base_ref": "main", "head_ref": "feat",
        },
        repos_dir=tmp_path / "repos",
        results_dir=tmp_path / "results",
        dry_run=True,
    )
    assert record["status"] == "dry_run"
    assert record["error"] is None
    assert record["report_path"].endswith("owner__repo_pr1.json")


def test_process_entry_missing_refs_records_failure(tmp_path):
    record = process_entry(
        {"repo": "owner/repo", "pr_number": 2},  # base_ref/head_ref missing
        repos_dir=tmp_path / "repos",
        results_dir=tmp_path / "results",
        dry_run=True,
    )
    assert record["status"] == "skipped"
    assert "missing" in (record["error"] or "").lower()


def test_main_dry_run_summary(tmp_path, capsys):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([
        {
            "repo": "owner/repo", "pr_number": 1,
            "base_ref": "abc", "head_ref": "def",
            "model_report_path": "evaluation/results/owner__repo_pr1.json",
        },
        {
            # missing refs - should be tracked as a skip, not a crash
            "repo": "owner/other", "pr_number": 2,
        },
    ]), encoding="utf-8")

    summary_path = tmp_path / "summary.json"
    rc = main([
        "--manifest", str(manifest),
        "--repos-dir", str(tmp_path / "repos"),
        "--results-dir", str(tmp_path / "results"),
        "--summary", str(summary_path),
        "--dry-run",
    ])
    capsys.readouterr()  # discard interleaved DRY-RUN lines + summary line
    # Failure exit code is for failed (real) runs only; dry_run is success-equivalent.
    assert rc == 0

    out = json.loads(summary_path.read_text(encoding="utf-8"))
    assert out["total"] == 2
    assert out["dry_run"] == 1
    assert out["skipped"] == 1
    statuses = {r["status"] for r in out["rows"]}
    assert statuses == {"dry_run", "skipped"}


def test_main_missing_manifest(tmp_path, capsys):
    rc = main([
        "--manifest", str(tmp_path / "does_not_exist.json"),
        "--dry-run",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "manifest not found" in err


def test_main_invalid_json_manifest(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    rc = main([
        "--manifest", str(bad),
        "--dry-run",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "invalid JSON" in err


def test_main_manifest_not_a_list(tmp_path, capsys):
    obj = tmp_path / "obj.json"
    obj.write_text('{"key": "value"}', encoding="utf-8")
    rc = main([
        "--manifest", str(obj),
        "--dry-run",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "JSON list" in err


def test_process_entry_template_repo_name(tmp_path):
    """_repo_dir_name replaces / with __ for filesystem-safe dirs."""
    from run_public_pr_reports import _repo_dir_name
    assert _repo_dir_name("owner/repo") == "owner__repo"
    assert _repo_dir_name("single") == "single"


def test_process_entry_with_explicit_model_report_path(tmp_path):
    """When model_report_path is set, it is used instead of auto-derived."""
    record = process_entry(
        {
            "repo": "owner/repo", "pr_number": 3,
            "base_ref": "abc", "head_ref": "def",
            "model_report_path": "evaluation/results/custom_path.json",
        },
        repos_dir=tmp_path / "repos",
        results_dir=tmp_path / "results",
        dry_run=True,
    )
    assert record["status"] == "dry_run"
    assert record["report_path"].endswith("custom_path.json")


def test_main_with_limit_respects_limit(tmp_path, capsys):
    """--limit N processes at most N entries."""
    entries = []
    for i in range(10):
        entries.append({
            "repo": "owner/repo", "pr_number": i,
            "base_ref": "abc", "head_ref": "def",
        })
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(entries), encoding="utf-8")
    summary_path = tmp_path / "summary.json"

    rc = main([
        "--manifest", str(manifest),
        "--repos-dir", str(tmp_path / "repos"),
        "--results-dir", str(tmp_path / "results"),
        "--summary", str(summary_path),
        "--limit", "3",
        "--dry-run",
    ])
    assert rc == 0
    out = json.loads(summary_path.read_text(encoding="utf-8"))
    assert out["total"] == 3
    assert out["dry_run"] == 3


def test_process_entry_missing_repo_field(tmp_path):
    """Missing repo means status skipped, not a crash."""
    record = process_entry(
        {"pr_number": 1, "base_ref": "x", "head_ref": "y"},
        repos_dir=tmp_path / "repos",
        results_dir=tmp_path / "results",
        dry_run=True,
    )
    assert record["status"] == "skipped"
    assert "missing" in record["error"].lower()
