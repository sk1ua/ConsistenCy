"""Tests for frontend Flask API."""

import json
import os
import sys
from pathlib import Path

import pytest

# Add backend src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend" / "src"))
sys.path.insert(0, str(Path(__file__).parent.parent / "frontend"))

from unittest.mock import MagicMock, patch


@pytest.fixture
def app():
    """Create a test Flask app."""
    from app import app as flask_app
    flask_app.config.update({
        "TESTING": True,
    })
    return flask_app


@pytest.fixture
def client(app):
    """Create a test client."""
    return app.test_client()


class TestHealthEndpoint:
    """Tests for /api/health endpoint."""

    def test_health_returns_200(self, client):
        """Health endpoint should return 200."""
        response = client.get("/api/health")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "ok"
        assert "version" in data


class TestAnalyzeEndpoint:
    """Tests for /api/analyze endpoint."""

    def test_analyze_requires_repo_path(self, client):
        """Should return 400 if repo_path missing."""
        response = client.post("/api/analyze", json={})
        assert response.status_code == 400
        data = json.loads(response.data)
        assert "error" in data

    def test_analyze_requires_valid_repo_path(self, client):
        """Should return 400 for invalid repo path."""
        response = client.post("/api/analyze", json={"repo_path": "/not/a/repo"})
        assert response.status_code == 400
        data = json.loads(response.data)
        assert "error" in data

    @patch("app.AnalysisPipeline")
    def test_analyze_success(self, mock_pipeline_class, client, tmp_path):
        """Should return analysis results."""
        mock_pipeline = MagicMock()
        mock_pipeline.analyze_commit.return_value = {
            "files_analyzed": 2,
            "file_results": [
                {"file": "test.py", "risk_score": 0.5}
            ]
        }
        mock_pipeline_class.return_value = mock_pipeline

        # Create a fake git repo
        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.post("/api/analyze", json={"repo_path": str(tmp_path)})
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["files_analyzed"] == 2


class TestAnalyzeRangeEndpoint:
    """Tests for /api/analyze-range endpoint."""

    def test_range_requires_repo_path(self, client):
        """Should return 400 if repo_path missing."""
        response = client.post("/api/analyze-range", json={})
        assert response.status_code == 400
        data = json.loads(response.data)
        assert "error" in data

    def test_range_validates_weeks(self, client, tmp_path):
        """Should validate weeks parameter."""
        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.post("/api/analyze-range", json={
            "repo_path": str(tmp_path),
            "weeks": 100  # Too high
        })
        # API returns 422 for validation errors
        assert response.status_code in (400, 422)

    @patch("app.AnalysisPipeline")
    def test_range_success(self, mock_pipeline_class, client, tmp_path):
        """Should return range analysis results."""
        mock_pipeline = MagicMock()
        mock_pipeline.analyze_range.return_value = {
            "weeks": [
                {"week": "2024-W01", "avg_risk": 0.5, "commit_count": 5}
            ]
        }
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.post("/api/analyze-range", json={
            "repo_path": str(tmp_path),
            "weeks": 4
        })
        assert response.status_code == 200
        data = json.loads(response.data)
        assert "weeks" in data


class TestPRReportEndpoint:
    """Tests for /api/pr/report endpoint."""

    def test_pr_report_requires_base_ref(self, client, tmp_path):
        """Should return 400 if base_ref missing."""
        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.post("/api/pr/report", json={
            "repo_path": str(tmp_path)
        })
        assert response.status_code == 400
        data = json.loads(response.data)
        assert "error" in data

    @patch("app.AnalysisPipeline")
    def test_pr_report_success(self, mock_pipeline_class, client, tmp_path):
        """Should return PR report."""
        mock_pipeline = MagicMock()
        mock_pipeline.pr_risk_report.return_value = {
            "pr_risk_score": 0.6,
            "pr_risk_level": "medium",
            "commits_analyzed": 3,
            "files": []
        }
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.post("/api/pr/report", json={
            "repo_path": str(tmp_path),
            "base_ref": "origin/main"
        })
        assert response.status_code == 200
        data = json.loads(response.data)
        assert "pr_risk_score" in data


class TestExportEndpoint:
    """Tests for /api/export endpoint."""

    def test_export_requires_repo_path(self, client):
        """Should return 400 if repo_path missing."""
        response = client.post("/api/export", json={})
        assert response.status_code == 400
        data = json.loads(response.data)
        assert "error" in data

    @patch("app.AnalysisPipeline")
    def test_export_json_format(self, mock_pipeline_class, client, tmp_path):
        """Should export JSON format."""
        mock_pipeline = MagicMock()
        mock_pipeline.analyze_commit.return_value = {
            "final_risk_score": 0.5,
            "risk_level": "medium",
            "files_analyzed": 2
        }
        mock_pipeline.weekly_history.return_value = []
        mock_pipeline.file_summary.return_value = []
        mock_pipeline.author_breakdown.return_value = []
        mock_pipeline.hotspot_data.return_value = []
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.post("/api/export", json={
            "repo_path": str(tmp_path),
            "format": "json"
        })
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["format"] == "json"
        assert "summary" in data

    @patch("app.AnalysisPipeline")
    def test_export_invalid_format(self, mock_pipeline_class, client, tmp_path):
        """Should return 400 for invalid format."""
        mock_pipeline = MagicMock()
        mock_pipeline.analyze_commit.return_value = {
            "final_risk_score": 0.5,
            "risk_level": "medium",
            "files_analyzed": 2
        }
        mock_pipeline.weekly_history.return_value = []
        mock_pipeline.file_summary.return_value = []
        mock_pipeline.author_breakdown.return_value = []
        mock_pipeline.hotspot_data.return_value = []
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.post("/api/export", json={
            "repo_path": str(tmp_path),
            "format": "xml"  # Invalid
        })
        assert response.status_code == 400


class TestRepoInfoEndpoints:
    """Tests for /api/repo/* endpoints (GET with query params)."""

    @patch("app.AnalysisPipeline")
    def test_history_endpoint(self, mock_pipeline_class, client, tmp_path):
        """Should return weekly history."""
        mock_pipeline = MagicMock()
        mock_pipeline.weekly_history.return_value = [
            {"week": "2024-W01", "avg_risk": 0.5}
        ]
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.get(f"/api/repo/history?repo_path={tmp_path}&weeks=4")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert isinstance(data, list)

    @patch("app.AnalysisPipeline")
    def test_files_endpoint(self, mock_pipeline_class, client, tmp_path):
        """Should return file summary."""
        mock_pipeline = MagicMock()
        mock_pipeline.file_summary.return_value = [
            {"file": "test.py", "risk_score": 0.5}
        ]
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.get(f"/api/repo/files?repo_path={tmp_path}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert isinstance(data, list)

    @patch("app.AnalysisPipeline")
    def test_authors_endpoint(self, mock_pipeline_class, client, tmp_path):
        """Should return author breakdown."""
        mock_pipeline = MagicMock()
        mock_pipeline.author_breakdown.return_value = [
            {"author": "test", "avg_risk": 0.5}
        ]
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.get(f"/api/repo/authors?repo_path={tmp_path}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert isinstance(data, list)

    @patch("app.AnalysisPipeline")
    def test_hotspots_endpoint(self, mock_pipeline_class, client, tmp_path):
        """Should return hotspot data."""
        mock_pipeline = MagicMock()
        mock_pipeline.hotspot_data.return_value = [
            {"file": "test.py", "hotspot_score": 0.8}
        ]
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        response = client.get(f"/api/repo/hotspots?repo_path={tmp_path}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert isinstance(data, list)


class TestCacheFunctionality:
    """Tests for caching functionality."""

    @patch("app.AnalysisPipeline")
    def test_caching_returns_cached_result(self, mock_pipeline_class, client, tmp_path):
        """Should return cached result on second request."""
        mock_pipeline = MagicMock()
        mock_pipeline.analyze_commit.return_value = {"files_analyzed": 2}
        mock_pipeline_class.return_value = mock_pipeline

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        # First request
        response1 = client.post("/api/analyze", json={"repo_path": str(tmp_path)})
        assert response1.status_code == 200

        # Second request should hit cache
        response2 = client.post("/api/analyze", json={"repo_path": str(tmp_path)})
        assert response2.status_code == 200

        # Pipeline should only be called once
        assert mock_pipeline_class.call_count == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
