"""CLI regression tests for the bundled consistency-review analyzer script."""
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / ".agents" / "skills" / "consistency-review" / "scripts" / "analyze_repo.py"
TMP_SOURCE = REPO_ROOT / "analyze_cli_tmp_source.py"


def _run_cli(*args: str) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )


def _entry(payload: dict, path: str) -> dict:
    return next(file for file in payload["files"] if file["path"] == path)


def test_baseline_ref_gives_confidence_for_a_tracked_file():
    completed = _run_cli("--baseline-ref", "HEAD", "engine/workflow/spec.py")
    assert completed.returncode == 0, completed.stderr[-2000:]
    entry = _entry(json.loads(completed.stdout), "engine/workflow/spec.py")
    # Files with a baseline snapshot land in [0.45, 0.80].
    assert entry["confidence"] >= 0.45


def test_file_absent_at_baseline_ref_keeps_low_confidence():
    TMP_SOURCE.write_text("def placeholder():\n    return 1\n", encoding="utf-8")
    try:
        completed = _run_cli("--baseline-ref", "HEAD", "analyze_cli_tmp_source.py")
    finally:
        TMP_SOURCE.unlink(missing_ok=True)
    assert completed.returncode == 0, completed.stderr[-2000:]
    entry = _entry(json.loads(completed.stdout), "analyze_cli_tmp_source.py")
    # No baseline: confidence stays below the baseline floor - review lead only.
    assert entry["confidence"] < 0.45


def test_rejects_paths_outside_the_repository():
    completed = _run_cli("..")
    assert completed.returncode == 2
    assert "escapes the repository" in completed.stderr
