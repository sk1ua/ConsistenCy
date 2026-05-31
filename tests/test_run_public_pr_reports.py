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
