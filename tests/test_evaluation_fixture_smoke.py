"""Offline smoke: fixtures make evaluation/scripts/run_metrics.py runnable without HF."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = PROJECT_ROOT / "evaluation" / "fixtures" / "sampled_prs.json"
SCRIPT = PROJECT_ROOT / "evaluation" / "scripts" / "run_metrics.py"


def test_fixture_manifest_is_complete():
    samples = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert len(samples) >= 2
    for sample in samples:
        report = PROJECT_ROOT / sample["model_report_path"]
        assert report.is_file(), sample["model_report_path"]
        assert sample.get("annotations"), sample["repo"]


def test_run_metrics_fixture_smoke(tmp_path: Path):
    out_json = tmp_path / "metrics.json"
    out_md = tmp_path / "metrics.md"
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--manifest",
            str(MANIFEST.relative_to(PROJECT_ROOT)),
            "--output",
            str(out_json),
            "--markdown-output",
            str(out_md),
        ],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    summary = json.loads(out_json.read_text(encoding="utf-8"))
    assert summary["sample_count"] == 2
    assert summary["evaluated_count"] == 2
    assert summary["mean_recall_at_k"] == 1.0
    md = out_md.read_text(encoding="utf-8")
    assert "| Evaluated | 2 |" in md
    assert "weak labels" in md.lower()
