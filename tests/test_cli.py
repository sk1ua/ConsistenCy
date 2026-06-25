# -*- coding: utf-8 -*-
"""Smoke tests for the ConsistenCy CLI (backend/cli.py).

Coverage goal: move CLI from 0% to at least basic assertion coverage
for the Click group, --help output, and key subcommands.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from click.testing import CliRunner

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from cli import cli  # noqa: E402


# ---------------------------------------------------------------------------
# Group / root
# ---------------------------------------------------------------------------

def test_cli_group_help():
    """``consistency --help`` prints usage and the project name."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "ConsistenCy" in result.output


def test_cli_version():
    """``--version`` prints the current version number."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--version"])
    assert result.exit_code == 0
    assert "2.5" in result.output


# ---------------------------------------------------------------------------
# Subcommand registration
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("subcommand", [
    "scan",
    "analyze-commit",
    "analyze-range",
    "analyze-file",
    "pr-report",
    "export-range",
    "export-by-file",
    "export-by-author",
    "analyze-remote",
    "trend",
])
def test_subcommand_exists_in_help(subcommand: str):
    runner = CliRunner()
    result = runner.invoke(cli, [subcommand, "--help"])
    assert result.exit_code == 0
    assert subcommand in result.output


# ---------------------------------------------------------------------------
# Minimal invoke paths (no repo required — expect graceful failure)
# ---------------------------------------------------------------------------

def test_scan_missing_repo_gives_error():
    runner = CliRunner()
    result = runner.invoke(cli, ["scan", "/nonexistent/repo/path"])
    assert result.exit_code != 0


def test_analyze_commit_missing_repo_option():
    runner = CliRunner()
    result = runner.invoke(cli, ["analyze-commit"])
    assert result.exit_code != 0


def test_pr_report_missing_options():
    runner = CliRunner()
    result = runner.invoke(cli, ["pr-report", "--json-output"])
    assert result.exit_code != 0


def test_analyze_file_missing_args():
    runner = CliRunner()
    result = runner.invoke(cli, ["analyze-file"])
    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# analyze-file with real fixture files
# ---------------------------------------------------------------------------

def test_analyze_file_with_project_examples():
    runner = CliRunner()
    demo_new = Path(__file__).parent.parent / "examples" / "demo_new.py"
    demo_base = Path(__file__).parent.parent / "examples" / "demo_base.py"
    if not demo_new.exists() or not demo_base.exists():
        pytest.skip("example files not found")
    result = runner.invoke(cli, [
        "analyze-file", str(demo_new), str(demo_base),
        "--json-output",
    ])
    assert result.exit_code == 0
    import json
    data = json.loads(result.output)
    assert "risk_score" in data
    assert "agent_collaboration" in data
    assert 0.0 <= data["risk_score"] <= 1.0


def test_analyze_file_rich_output():
    runner = CliRunner()
    demo_new = Path(__file__).parent.parent / "examples" / "demo_new.py"
    demo_base = Path(__file__).parent.parent / "examples" / "demo_base.py"
    if not demo_new.exists() or not demo_base.exists():
        pytest.skip("example files not found")
    result = runner.invoke(cli, [
        "analyze-file", str(demo_new), str(demo_base),
    ])
    assert result.exit_code == 0
    assert "Risk score" in result.output


# ---------------------------------------------------------------------------
# scan against project repo itself
# ---------------------------------------------------------------------------

def test_scan_project_repo():
    runner = CliRunner()
    repo_path = str(Path(__file__).parent.parent.resolve())
    result = runner.invoke(cli, ["scan", repo_path])
    assert result.exit_code == 0
    assert "Scan complete" in result.output


# ---------------------------------------------------------------------------
# analyze-commit against project repo
# ---------------------------------------------------------------------------

def test_analyze_commit_json_output():
    runner = CliRunner()
    repo_path = str(Path(__file__).parent.parent.resolve())
    result = runner.invoke(cli, [
        "analyze-commit", "--repo", repo_path,
        "--baseline-commits", "5",
        "--json-output",
    ])
    assert result.exit_code == 0
    import json
    data = json.loads(result.output)
    assert "final_risk_score" in data
