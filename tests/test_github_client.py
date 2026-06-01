# -*- coding: utf-8 -*-
"""Tests for backend/src/remote/github_client.py.

All HTTP calls are mocked via responses or manual MagicMock — no real
GitHub API tokens or network access needed.
"""
from __future__ import annotations

import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.remote.github_client import (  # noqa: E402
    CommitInfo,
    GitHubClient,
    RepoMetadata,
)


# ---------------------------------------------------------------------------
# GitHubClient._parse_commit
# ---------------------------------------------------------------------------

SAMPLE_COMMIT_DATA = {
    "sha": "abc123def456",
    "commit": {
        "message": "fix: a bug\n\nbody text",
        "author": {
            "name": "Alice",
            "email": "alice@example.com",
            "date": "2026-05-30T10:00:00Z",
        },
        "committer": {
            "name": "Bob",
            "date": "2026-05-30T10:05:00Z",
        },
    },
    "stats": {"additions": 10, "deletions": 3, "total": 13},
    "files": [
        {"filename": "src/main.py", "status": "modified"},
        {"filename": "src/utils.py", "status": "added"},
    ],
    "parents": [{"sha": "parent001"}],
}


class TestParseCommit:
    def test_parse_full_commit(self):
        client = GitHubClient()
        commit = client._parse_commit(SAMPLE_COMMIT_DATA)
        assert commit is not None
        assert commit.sha == "abc123def456"
        assert commit.author_name == "Alice"
        assert commit.author_email == "alice@example.com"
        assert commit.message == "fix: a bug\n\nbody text"
        assert commit.stats["additions"] == 10
        assert len(commit.files) == 2
        assert len(commit.parents) == 1
        assert commit.parents[0]["sha"] == "parent001"

    def test_parse_commit_no_parents(self):
        data = {**SAMPLE_COMMIT_DATA, "parents": []}
        client = GitHubClient()
        commit = client._parse_commit(data)
        assert commit is not None
        assert commit.parents == []

    def test_parse_commit_no_files(self):
        data = {**SAMPLE_COMMIT_DATA, "files": []}
        client = GitHubClient()
        commit = client._parse_commit(data)
        assert commit is not None
        assert commit.files == []

    def test_parse_commit_missing_keys_returns_none(self):
        client = GitHubClient()
        assert client._parse_commit({}) is None
        assert client._parse_commit({"sha": "x"}) is None

    def test_parse_commit_defaults_missing_stats_and_files(self):
        data = {
            "sha": "abc",
            "commit": {
                "message": "msg",
                "author": {"name": "A", "date": "2026-01-01T00:00:00Z"},
                "committer": {"name": "C", "date": "2026-01-01T00:00:00Z"},
            },
            "parents": [],
        }
        client = GitHubClient()
        commit = client._parse_commit(data)
        assert commit is not None
        assert commit.author_name == "A"
        assert commit.stats == {"additions": 0, "deletions": 0, "total": 0}
        assert commit.files == []


# ---------------------------------------------------------------------------
# GitHubClient with mocked HTTP
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_session():
    """Return a MagicMock session that client will use."""
    return MagicMock()


@pytest.fixture
def client_with_session(monkeypatch, mock_session):
    """Create a client and inject the mocked session."""
    monkeypatch.setattr("src.remote.github_client.HAS_REQUESTS", True)
    monkeypatch.setattr("src.remote.github_client.requests", MagicMock())
    client = GitHubClient(token="ghp_test123")
    client._session = mock_session
    return client


class TestGitHubClientMocked:
    def test_get_repo_parses_metadata(self, client_with_session, mock_session):
        mock_session.get.return_value.json.return_value = {
            "owner": {"login": "test-org"},
            "name": "test-repo",
            "full_name": "test-org/test-repo",
            "description": "A test repo",
            "language": "Python",
            "stargazers_count": 42,
            "forks_count": 7,
            "open_issues_count": 3,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
            "pushed_at": "2025-06-01T00:00:00Z",
            "default_branch": "main",
            "size": 100,
        }
        mock_session.get.return_value.raise_for_status.return_value = None

        repo = client_with_session.get_repo("test-org", "test-repo")
        assert repo.full_name == "test-org/test-repo"
        assert repo.language == "Python"
        assert repo.stars == 42
        assert repo.default_branch == "main"

    def test_list_commits_paginates(self, client_with_session):
        """Simulate two pages of results, then empty page."""
        commit_data = [{**SAMPLE_COMMIT_DATA, "sha": "aaa"}, {**SAMPLE_COMMIT_DATA, "sha": "bbb"}]

        with patch.object(client_with_session, "_request") as mock_req:
            # First page: 2 commits. Second page: empty → break.
            mock_req.side_effect = [commit_data, []]

            commits = client_with_session.list_commits(
                "o", "r", max_pages=5, per_page=2
            )

            assert len(commits) == 2
            assert commits[0].sha == "aaa"
            assert commits[1].sha == "bbb"

    def test_get_commit_returns_single_commit(self, client_with_session, mock_session):
        mock_session.get.return_value.json.return_value = SAMPLE_COMMIT_DATA
        mock_session.get.return_value.raise_for_status.return_value = None

        with patch.object(client_with_session, "_request") as mock_req:
            mock_req.return_value = SAMPLE_COMMIT_DATA
            commit = client_with_session.get_commit("o", "r", "abc123")
            assert commit is not None
            assert commit.sha == "abc123def456"

    def test_get_file_content_decodes_base64(self, client_with_session, mock_session):
        content = b"def hello():\n    return 'world'\n"
        encoded = base64.b64encode(content).decode()
        mock_session.get.return_value.json.return_value = {
            "type": "file",
            "content": encoded,
        }
        mock_session.get.return_value.raise_for_status.return_value = None

        with patch.object(client_with_session, "_request") as mock_req:
            mock_req.return_value = {
                "type": "file",
                "content": encoded,
            }
            result = client_with_session.get_file_content("o", "r", "src/hello.py", "main")
            assert result is not None
            assert "def hello()" in result

    def test_get_file_content_directory_returns_none(self, client_with_session):
        with patch.object(client_with_session, "_request") as mock_req:
            mock_req.return_value = {"type": "dir"}
            result = client_with_session.get_file_content("o", "r", "dir/", "main")
            assert result is None

    def test_get_file_content_404_returns_none(self, client_with_session):
        with patch.object(client_with_session, "_request") as mock_req:
            # Simulate the method returning None (404 path in the real code
            # goes through requests.HTTPError handling)
            mock_req.side_effect = None
            mock_req.return_value = None
            result = client_with_session.get_file_content("o", "r", "missing.py")
            assert result is None

    def test_token_sets_auth_header(self, monkeypatch):
        """Client with a token passes it to session headers."""
        mock_session_cls = MagicMock()
        mock_session = MagicMock()
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session
        monkeypatch.setattr("src.remote.github_client.HAS_REQUESTS", True)
        monkeypatch.setattr("src.remote.github_client.requests.Session", mock_session_cls)
        client = GitHubClient(token="ghp_test")
        assert "Authorization" in mock_session.headers
        assert "ghp_test" in mock_session.headers["Authorization"]

    def test_no_token_no_auth_header(self, monkeypatch):
        mock_session_cls = MagicMock()
        mock_session = MagicMock()
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session
        monkeypatch.setattr("src.remote.github_client.HAS_REQUESTS", True)
        monkeypatch.setattr("src.remote.github_client.requests.Session", mock_session_cls)
        client = GitHubClient(token=None)
        assert "Authorization" not in mock_session.headers


# ---------------------------------------------------------------------------
# Dataclass round-trips
# ---------------------------------------------------------------------------

class TestDataclasses:
    def test_commit_info_defaults(self):
        c = CommitInfo(
            sha="abc",
            message="m",
            author_name="a",
            author_email=None,
            author_date=datetime.now(timezone.utc),
            committer_name="c",
            committer_date=datetime.now(timezone.utc),
            stats={},
            files=[],
        )
        assert c.parents == []

    def test_repo_metadata_defaults(self):
        r = RepoMetadata(
            owner="o",
            name="n",
            full_name="o/n",
            description=None,
            language=None,
            stars=0,
            forks=0,
            open_issues=0,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            pushed_at=None,
            default_branch="main",
            size_kb=0,
        )
        assert r.license is None
        assert r.topics == []
