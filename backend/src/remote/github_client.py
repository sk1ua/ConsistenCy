# -*- coding: utf-8 -*-
"""
GitHub API Client
=================

Client for fetching repository data from GitHub API.
Supports both public repos (no token) and private repos (with token).
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

# Optional requests
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False
    requests = None  # type: ignore


@dataclass
class RepoMetadata:
    """Repository metadata from GitHub API."""
    owner: str
    name: str
    full_name: str
    description: str | None
    language: str | None
    stars: int
    forks: int
    open_issues: int
    created_at: datetime
    updated_at: datetime
    pushed_at: datetime | None
    default_branch: str
    size_kb: int
    license: str | None = None
    topics: list[str] = field(default_factory=list)


@dataclass
class CommitInfo:
    """Commit information from GitHub API."""
    sha: str
    message: str
    author_name: str
    author_email: str | None
    author_date: datetime
    committer_name: str
    committer_date: datetime
    stats: dict[str, int]  # additions, deletions, total
    files: list[dict[str, Any]]  # changed files


@dataclass
class TreeEntry:
    """Git tree entry."""
    path: str
    type: str  # blob (file), tree (dir), commit (submodule)
    sha: str
    size: int | None = None  # only for blobs


class GitHubClient:
    """Client for GitHub REST API.
    
    Parameters
    ----------
    token : str | None
        GitHub personal access token (optional for public repos)
    base_url : str
        GitHub API base URL (default: https://api.github.com)
    rate_limit_delay : float
        Delay between requests to avoid rate limiting (seconds)
    """
    
    def __init__(
        self,
        token: str | None = None,
        base_url: str = "https://api.github.com",
        rate_limit_delay: float = 0.5,
    ) -> None:
        if not HAS_REQUESTS:
            raise ImportError("requests library required for remote analysis")
        
        self.token = token or os.environ.get("GITHUB_TOKEN")
        self.base_url = base_url.rstrip("/")
        self.rate_limit_delay = rate_limit_delay
        self._last_request_time: float = 0
        
        self._session = requests.Session()
        if self.token:
            self._session.headers["Authorization"] = f"token {self.token}"
        self._session.headers["Accept"] = "application/vnd.github.v3+json"
    
    def _request(self, endpoint: str, params: dict | None = None) -> dict | list:
        """Make rate-limited request to GitHub API."""
        # Rate limiting
        elapsed = time.time() - self._last_request_time
        if elapsed < self.rate_limit_delay:
            time.sleep(self.rate_limit_delay - elapsed)
        
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        response = self._session.get(url, params=params or {})
        self._last_request_time = time.time()
        
        if response.status_code == 403:
            # Rate limited
            reset_time = int(response.headers.get("X-RateLimit-Reset", 0))
            if reset_time:
                wait = max(0, reset_time - time.time())
                print(f"Rate limited. Waiting {wait:.0f}s...")
                time.sleep(wait)
                return self._request(endpoint, params)
        
        response.raise_for_status()
        return response.json()
    
    def get_repo(self, owner: str, repo: str) -> RepoMetadata:
        """Fetch repository metadata."""
        data = self._request(f"/repos/{quote(owner)}/{quote(repo)}")
        
        return RepoMetadata(
            owner=data["owner"]["login"],
            name=data["name"],
            full_name=data["full_name"],
            description=data.get("description"),
            language=data.get("language"),
            stars=data["stargazers_count"],
            forks=data["forks_count"],
            open_issues=data["open_issues_count"],
            created_at=datetime.fromisoformat(data["created_at"].replace("Z", "+00:00")),
            updated_at=datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00")),
            pushed_at=datetime.fromisoformat(data["pushed_at"].replace("Z", "+00:00")) if data["pushed_at"] else None,
            default_branch=data["default_branch"],
            size_kb=data["size"],
            license=data["license"]["spdx_id"] if data.get("license") else None,
            topics=data.get("topics", []),
        )
    
    def list_commits(
        self,
        owner: str,
        repo: str,
        sha: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        per_page: int = 100,
        max_pages: int = 10,
    ) -> list[CommitInfo]:
        """List commits with optional filtering."""
        commits: list[CommitInfo] = []
        page = 1
        
        while page <= max_pages:
            params: dict[str, Any] = {
                "per_page": per_page,
                "page": page,
            }
            if sha:
                params["sha"] = sha
            if since:
                params["since"] = since.isoformat()
            if until:
                params["until"] = until.isoformat()
            
            data = self._request(f"/repos/{quote(owner)}/{quote(repo)}/commits", params)
            
            if not data:
                break
            
            for commit_data in data:
                commit = self._parse_commit(commit_data)
                if commit:
                    commits.append(commit)
            
            page += 1
        
        return commits
    
    def _parse_commit(self, data: dict) -> CommitInfo | None:
        """Parse commit data from API response."""
        try:
            commit_info = data["commit"]
            author = commit_info.get("author", {})
            committer = commit_info.get("committer", {})
            
            return CommitInfo(
                sha=data["sha"],
                message=commit_info["message"],
                author_name=author.get("name", "Unknown"),
                author_email=author.get("email"),
                author_date=datetime.fromisoformat(author["date"].replace("Z", "+00:00")),
                committer_name=committer.get("name", "Unknown"),
                committer_date=datetime.fromisoformat(committer["date"].replace("Z", "+00:00")),
                stats=data.get("stats", {"additions": 0, "deletions": 0, "total": 0}),
                files=data.get("files", []),
            )
        except (KeyError, ValueError):
            return None
    
    def get_commit(self, owner: str, repo: str, sha: str) -> CommitInfo | None:
        """Fetch single commit details."""
        data = self._request(f"/repos/{quote(owner)}/{quote(repo)}/commits/{sha}")
        return self._parse_commit(data)
    
    def get_file_content(
        self,
        owner: str,
        repo: str,
        path: str,
        ref: str | None = None,
    ) -> str | None:
        """Fetch file content from repository.
        
        Returns None if file not found or is binary.
        """
        params = {"ref": ref} if ref else {}
        
        try:
            # First get file metadata
            data = self._request(
                f"/repos/{quote(owner)}/{quote(repo)}/contents/{quote(path, safe='')}",
                params,
            )
            
            if isinstance(data, dict) and data.get("type") == "file":
                import base64
                content = data.get("content", "")
                if content:
                    return base64.b64decode(content).decode("utf-8")
            
            return None
        except requests.HTTPError as e:
            if e.response.status_code == 404:
                return None
            raise
    
    def get_directory_tree(
        self,
        owner: str,
        repo: str,
        ref: str | None = None,
        recursive: bool = True,
    ) -> list[TreeEntry]:
        """Get repository file tree."""
        ref = ref or "HEAD"
        params = {"recursive": "1"} if recursive else {}
        
        data = self._request(
            f"/repos/{quote(owner)}/{quote(repo)}/git/trees/{quote(ref)}",
            params,
        )
        
        entries = []
        for item in data.get("tree", []):
            entries.append(TreeEntry(
                path=item["path"],
                type=item["type"],
                sha=item["sha"],
                size=item.get("size"),
            ))
        
        return entries
    
    def get_rate_limit(self) -> dict[str, Any]:
        """Get current rate limit status."""
        return self._request("/rate_limit")
