# -*- coding: utf-8 -*-
"""Schema contract tests for Python report outputs."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND = PROJECT_ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from src.pipeline import AnalysisPipeline, analyze_sources  # noqa: E402


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(schema_name: str) -> Draft202012Validator:
    schema = _load_json(PROJECT_ROOT / "schemas" / schema_name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _assert_valid(instance: dict, schema_name: str) -> None:
    validator = _validator(schema_name)
    errors = sorted(validator.iter_errors(instance), key=lambda err: err.path)
    assert not errors, "\n".join(
        f"{'/'.join(map(str, err.path)) or '<root>'}: {err.message}"
        for err in errors
    )


def test_pr_report_fixture_matches_schema():
    report = _load_json(PROJECT_ROOT / "tests" / "fixtures" / "pr_report_minimal.json")
    _assert_valid(report, "pr_report.schema.json")


def test_analyze_sources_demo_output_matches_schema():
    source_now = (PROJECT_ROOT / "examples" / "demo_new.py").read_text(encoding="utf-8")
    source_base = (PROJECT_ROOT / "examples" / "demo_base.py").read_text(encoding="utf-8")

    result = analyze_sources(
        source_now,
        source_base,
        filepath=str(PROJECT_ROOT / "examples" / "demo_new.py"),
    )

    _assert_valid(result, "analysis_result.schema.json")


def test_pipeline_pr_report_matches_schema_when_git_history_available():
    try:
        pipeline = AnalysisPipeline(str(PROJECT_ROOT))
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Git repo not available: {exc}")

    commits = list(pipeline.repo.iter_commits(max_count=2))
    if len(commits) < 2:
        pytest.skip("Need at least two commits for a PR report range")

    report = pipeline.pr_risk_report(
        base_ref=commits[1].hexsha,
        head_ref=commits[0].hexsha,
        baseline_n=20,
        max_commits=5,
    )

    _assert_valid(report, "pr_report.schema.json")
