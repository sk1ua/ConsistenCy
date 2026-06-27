# -*- coding: utf-8 -*-
"""Tests for the Markdown rendering added to run_metrics.py.

Verifies that:
- The table headers required by the README spec are present.
- ``n/a`` is used for metrics that can not be computed (fewer than two
  evaluated samples), rather than printing implausibly precise zeros.
- The ``--markdown-output`` CLI flag actually writes the rendered table.
"""
from __future__ import annotations

import json
import sys
from importlib import util
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "evaluation" / "scripts" / "run_metrics.py"

spec = util.spec_from_file_location("run_metrics_module", SCRIPT_PATH)
assert spec and spec.loader
module = util.module_from_spec(spec)
sys.modules["run_metrics_module"] = module
spec.loader.exec_module(module)

render_markdown = module.render_markdown
format_metric = module._format_metric
main_fn = module.main


def test_format_metric_handles_missing():
    assert format_metric(None) == "n/a"
    assert format_metric(float("nan")) == "n/a"
    assert format_metric("abc") == "n/a"
    assert format_metric(0.5) == "0.500"


def test_render_markdown_with_evaluated_samples():
    summary = {
        "sample_count": 50,
        "evaluated_count": 47,
        "k": 3,
        "overall_spearman": 0.4321,
        "mean_precision_at_k": 0.6543,
        "mean_recall_at_k": 0.7654,
        "retrieval": {
            "evidence_recall_at_k": 0.6111,
            "average_compression_ratio": 0.247,
            "average_selected_evidence_count": 2.7,
            "files_with_evidence": 33,
        },
        "pairwise_cohens_kappa": 0.5111,
    }
    md = render_markdown(summary)
    assert "# ConsistenCy Public PR Evaluation" in md
    assert "| Metric | Value |" in md
    assert "| Samples | 50 |" in md
    assert "| Evaluated | 47 |" in md
    assert "| Precision@3 | 0.654 |" in md
    assert "| Recall@3 | 0.765 |" in md
    assert "| Evidence Recall@3 | 0.611 |" in md
    assert "| Average Compression Ratio | 0.247 |" in md
    assert "| Average Selected Evidence Count | 2.700 |" in md
    assert "| Files With Evidence | 33 |" in md
    assert "| False Evidence Rate | n/a |" in md
    assert "| Spearman | 0.432 |" in md
    assert "| Cohen's Kappa | 0.511 |" in md
    assert "## Notes" in md
    assert "weak labels" in md.lower()


def test_render_markdown_handles_no_evaluated_samples():
    summary = {
        "sample_count": 10,
        "evaluated_count": 0,
        "k": 3,
        "overall_spearman": 0.0,
        "mean_precision_at_k": 0.0,
        "mean_recall_at_k": 0.0,
        "retrieval": {},
        "pairwise_cohens_kappa": 0.0,
    }
    md = render_markdown(summary)
    # n/a everywhere because nothing was actually evaluated
    assert "| Spearman | n/a |" in md
    assert "| Cohen's Kappa | n/a |" in md
    assert "| Precision@3 | n/a |" in md
    assert "| Recall@3 | n/a |" in md
    assert "| Evidence Recall@3 | n/a |" in md


def test_render_markdown_handles_single_sample_for_spearman():
    summary = {
        "sample_count": 1,
        "evaluated_count": 1,
        "k": 3,
        "overall_spearman": 0.0,  # 1 sample - Spearman is meaningless
        "mean_precision_at_k": 0.5,
        "mean_recall_at_k": 0.5,
        "retrieval": {
            "evidence_recall_at_k": 1.0,
            "average_compression_ratio": 0.3,
            "average_selected_evidence_count": 2.0,
            "files_with_evidence": 1,
        },
        "pairwise_cohens_kappa": 0.0,
    }
    md = render_markdown(summary)
    # Per-sample stats are valid; rank stats need >= 2 evaluated samples
    assert "| Spearman | n/a |" in md
    assert "| Cohen's Kappa | n/a |" in md
    assert "| Precision@3 | 0.500 |" in md


def test_main_writes_markdown_output(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([]), encoding="utf-8")
    json_out = tmp_path / "metrics.json"
    md_out = tmp_path / "metrics.md"

    sys.argv = [
        "run_metrics.py",
        "--manifest", str(manifest),
        "--output", str(json_out),
        "--markdown-output", str(md_out),
    ]
    main_fn()

    assert md_out.exists()
    text = md_out.read_text(encoding="utf-8")
    assert "ConsistenCy Public PR Evaluation" in text
    assert "| Samples | 0 |" in text
