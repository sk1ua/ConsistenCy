# -*- coding: utf-8 -*-
"""Dashboard API cache tests."""
from __future__ import annotations

import importlib.util
from pathlib import Path


APP_PATH = Path(__file__).parent.parent / "frontend" / "app.py"
SPEC = importlib.util.spec_from_file_location("frontend_app", APP_PATH)
assert SPEC and SPEC.loader
frontend_app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(frontend_app)


class _FakePipeline:
    analyze_calls = 0
    history_calls = 0
    pr_report_calls = 0

    def __init__(self, repo_path: str) -> None:
        self.repo_path = repo_path

    def analyze_commit(self, commit_sha=None, baseline_n=50):
        _FakePipeline.analyze_calls += 1
        return {
            "commit": {"sha": (commit_sha or "HEAD")[:8]},
            "final_risk_score": 0.1234,
            "evolution_score": 0.1,
            "evolution_evidence": [],
            "files_analyzed": 1,
            "file_results": {},
            "baseline_n": baseline_n,
        }

    def weekly_history(self, weeks=12):
        _FakePipeline.history_calls += 1
        return [{
            "week": "2026-W10",
            "avg_risk": 0.2,
            "commit_count": 1,
            "real_sample_count": 1,
            "is_estimated": False,
        }]

    def pr_risk_report(self, base_ref, head_ref="HEAD", baseline_n=50, max_commits=40):
        _FakePipeline.pr_report_calls += 1
        return {
            "base_ref": base_ref,
            "head_ref": head_ref,
            "commit_count": 1,
            "avg_risk": 0.31,
            "max_risk": 0.31,
            "high_risk_commits": 0,
            "commits": [{
                "sha": "abcdef12",
                "date": "2026-03-11T00:00:00+00:00",
                "author": "tester",
                "message": "test",
                "risk_score": 0.31,
                "risk_level": "Minor Drift",
                "files_analyzed": 1,
            }],
            "top_risky_files": [],
            "cache": {},
        }



def test_repo_history_uses_cache(monkeypatch, tmp_path):
    frontend_app._cache_clear()
    _FakePipeline.history_calls = 0

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    monkeypatch.setattr(frontend_app, "AnalysisPipeline", _FakePipeline)
    frontend_app.app.config["TESTING"] = True

    with frontend_app.app.test_client() as client:
        res1 = client.get("/api/repo/history", query_string={"repo_path": str(repo_dir), "weeks": 4})
        res2 = client.get("/api/repo/history", query_string={"repo_path": str(repo_dir), "weeks": 4})

    assert res1.status_code == 200
    assert res2.status_code == 200
    assert _FakePipeline.history_calls == 1



def test_analyze_uses_cache(monkeypatch, tmp_path):
    frontend_app._cache_clear()
    _FakePipeline.analyze_calls = 0

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    monkeypatch.setattr(frontend_app, "AnalysisPipeline", _FakePipeline)
    frontend_app.app.config["TESTING"] = True

    payload = {
        "repo_path": str(repo_dir),
        "commit_sha": "abcdef1234",
        "baseline_commits": 20,
    }

    with frontend_app.app.test_client() as client:
        res1 = client.post("/api/analyze", json=payload)
        res2 = client.post("/api/analyze", json=payload)

    assert res1.status_code == 200
    assert res2.status_code == 200
    assert _FakePipeline.analyze_calls == 1


def test_repo_history_bad_repo_path_returns_400(tmp_path):
    frontend_app.app.config["TESTING"] = True
    missing_repo = tmp_path / "missing-repo"

    with frontend_app.app.test_client() as client:
        res = client.get("/api/repo/history", query_string={"repo_path": str(missing_repo), "weeks": 4})

    assert res.status_code == 400
    payload = res.get_json()
    assert payload["code"] == "INVALID_REPO_PATH"


def test_repo_history_invalid_weeks_returns_422(tmp_path):
    frontend_app.app.config["TESTING"] = True
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    with frontend_app.app.test_client() as client:
        res_non_int = client.get("/api/repo/history", query_string={"repo_path": str(repo_dir), "weeks": "abc"})
        res_out_of_range = client.get("/api/repo/history", query_string={"repo_path": str(repo_dir), "weeks": 0})

    assert res_non_int.status_code == 422
    assert res_non_int.get_json()["code"] == "INVALID_WEEKS"
    assert res_out_of_range.status_code == 422
    assert res_out_of_range.get_json()["code"] == "INVALID_WEEKS"


def test_analyze_invalid_baseline_commits_returns_422(tmp_path):
    frontend_app.app.config["TESTING"] = True
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    with frontend_app.app.test_client() as client:
        res = client.post(
            "/api/analyze",
            json={
                "repo_path": str(repo_dir),
                "baseline_commits": "not-int",
            },
        )

    assert res.status_code == 422
    assert res.get_json()["code"] == "INVALID_BASELINE_COMMITS"


def test_pr_report_uses_cache(monkeypatch, tmp_path):
    frontend_app._cache_clear()
    _FakePipeline.pr_report_calls = 0

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    monkeypatch.setattr(frontend_app, "AnalysisPipeline", _FakePipeline)
    frontend_app.app.config["TESTING"] = True

    payload = {
        "repo_path": str(repo_dir),
        "base_ref": "origin/main",
        "head_ref": "HEAD",
        "baseline_commits": 20,
        "max_commits": 10,
    }

    with frontend_app.app.test_client() as client:
        res1 = client.post("/api/pr/report", json=payload)
        res2 = client.post("/api/pr/report", json=payload)

    assert res1.status_code == 200
    assert res2.status_code == 200
    assert _FakePipeline.pr_report_calls == 1


def test_pr_report_missing_base_ref_returns_400(tmp_path):
    frontend_app.app.config["TESTING"] = True
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    with frontend_app.app.test_client() as client:
        res = client.post("/api/pr/report", json={"repo_path": str(repo_dir)})

    assert res.status_code == 400
    assert res.get_json()["code"] == "MISSING_BASE_REF"
