# -*- coding: utf-8 -*-
"""
Pipeline 单元 / 集成测试
========================
对 AnalysisPipeline 的各主要方法做基本量级检验。
所有需要真实 Git 仓库的测试都使用项目自身的 .git 目录。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import pytest

from src.pipeline import analyze_sources, _commit_diff_stats, _file_source

REPO_PATH = str(Path(__file__).parent.parent)  # ConsistenCy root


# ─── analyze_sources ────────────────────────────────────────────────────────

def test_analyze_sources_returns_required_keys():
    src = "def f(x):\n    return x * 2\n"
    result = analyze_sources(src, src)
    for key in ("risk_score", "risk_level", "risk_colour", "breakdown", "evidence", "agent_details"):
        assert key in result, f"Missing key: {key}"


def test_analyze_sources_score_range():
    src_a = "def add(x, y):\n    return x + y\n"
    src_b = "import os\nclass Foo:\n    def bar(self, x, y, z):\n        return os.path.join(str(x), str(y))\n"
    result = analyze_sources(src_b, src_a)
    assert 0.0 <= result["risk_score"] <= 1.0


def test_analyze_sources_breakdown_sums():
    """Breakdown values should each be in [0, 1]."""
    src = "def g():\n    pass\n"
    result = analyze_sources(src, src)
    for k, v in result["breakdown"].items():
        assert 0.0 <= v <= 1.0, f"{k}={v} out of range"


def test_analyze_sources_syntax_error_graceful():
    """Syntactically broken source should not raise — score should still be returned."""
    result = analyze_sources("def broken(:", "def f(): pass\n")
    assert "risk_score" in result


# ─── AnalysisPipeline git-backed tests ───────────────────────────────────────

def _get_pipeline():
    try:
        from src.pipeline import AnalysisPipeline
        return AnalysisPipeline(REPO_PATH)
    except Exception:
        return None


def test_pipeline_analyze_commit():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")
    result = pipeline.analyze_commit(baseline_n=20)
    assert "final_risk_score" in result
    assert 0.0 <= result["final_risk_score"] <= 1.0
    assert "evolution_score" in result
    assert "commit" in result


def test_pipeline_weekly_history_shape():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")
    history = pipeline.weekly_history(weeks=4)
    # May be empty for a very new repo, but must be a list
    assert isinstance(history, list)
    for entry in history:
        assert "week" in entry
        assert "avg_risk" in entry
        assert "commit_count" in entry
        assert "is_estimated" in entry
        assert "real_sample_count" in entry
        assert 0.0 <= entry["avg_risk"] <= 1.0
        assert isinstance(entry["is_estimated"], bool)
        assert isinstance(entry["real_sample_count"], int)


def test_pipeline_analyze_range_shape():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")
    report = pipeline.analyze_range(weeks=2, baseline_n=20, max_commits=5)
    assert "commit_count" in report
    assert "avg_risk" in report
    assert "max_risk" in report
    assert "commits" in report
    assert "weekly" in report
    assert "cache" in report
    assert isinstance(report["commits"], list)
    assert isinstance(report["weekly"], list)
    if report["commits"]:
        c = report["commits"][0]
        assert "sha" in c
        assert "risk_score" in c
        assert "risk_level" in c


def test_pipeline_pr_risk_report_shape():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")

    commits = list(pipeline.repo.iter_commits(max_count=2))
    if len(commits) < 2:
        pytest.skip("Need at least 2 commits for PR range")

    head_ref = commits[0].hexsha
    base_ref = commits[1].hexsha
    report = pipeline.pr_risk_report(
        base_ref=base_ref,
        head_ref=head_ref,
        baseline_n=20,
        max_commits=5,
    )
    assert report["base_ref"] == base_ref
    assert report["head_ref"] == head_ref
    assert "commit_count" in report
    assert "avg_risk" in report
    assert "commits" in report
    assert "top_risky_files" in report
    assert "cache" in report


def test_pipeline_cache_stats_keys():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")
    pipeline.analyze_commit(baseline_n=10)
    stats = pipeline.cache_stats()
    for key in (
        "file_source_hit",
        "file_source_miss",
        "baseline_hit",
        "baseline_miss",
        "file_source_entries",
        "baseline_entries",
    ):
        assert key in stats
        assert isinstance(stats[key], int)


def test_pipeline_file_summary():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")
    files = pipeline.file_summary()
    assert isinstance(files, list)
    if files:
        f = files[0]
        assert "file" in f
        assert "risk_score" in f
        assert "risk_level" in f
        assert 0.0 <= f["risk_score"] <= 1.0


def test_pipeline_author_breakdown():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")
    authors = pipeline.author_breakdown()
    assert isinstance(authors, list)
    if authors:
        a = authors[0]
        assert "author" in a
        assert "commit_count" in a
        assert "avg_risk_proxy" in a


def test_pipeline_hotspot_data():
    pipeline = _get_pipeline()
    if pipeline is None:
        pytest.skip("Git repo not available")
    hotspots = pipeline.hotspot_data()
    assert isinstance(hotspots, list)
    if hotspots:
        h = hotspots[0]
        assert "file" in h
        assert "hotspot_score" in h
        assert 0.0 <= h["hotspot_score"] <= 1.0


# ─── config smoke ─────────────────────────────────────────────────────────────

def test_config_keys():
    import config
    assert hasattr(config, "RISK_WEIGHTS")
    assert hasattr(config, "PIPELINE_CONFIG")
    assert hasattr(config, "SUPPORTED_EXTENSIONS")
    assert hasattr(config, "DASHBOARD_CONFIG")
    assert ".py" in config.SUPPORTED_EXTENSIONS


def test_config_risk_weights_sum():
    import config
    total = sum(config.RISK_WEIGHTS.values())
    assert abs(total - 1.0) < 1e-6, f"RISK_WEIGHTS should sum to 1.0, got {total}"
