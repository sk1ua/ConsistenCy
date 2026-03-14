# -*- coding: utf-8 -*-
"""
Remote Repository Analysis
==========================

Analyze GitHub repositories without local cloning.

Features:
- Fetch repository data via GitHub API
- Lazy loading of file contents
- Historical trend analysis
- Shareable reports

Usage:
    from src.remote import GitHubClient, RemoteAnalysisPipeline
    
    client = GitHubClient(token="ghp_xxx")
    pipeline = RemoteAnalysisPipeline(client)
    
    # Analyze a remote repo
    result = pipeline.analyze_repo("facebook", "react")
    
    # Historical trends
    trends = pipeline.analyze_trends("facebook", "react", period="monthly")
"""
from __future__ import annotations

from .github_client import GitHubClient, RepoMetadata, CommitInfo
from .remote_pipeline import RemoteAnalysisPipeline, TrendReport, ComparisonReport

__all__ = [
    "GitHubClient",
    "RepoMetadata",
    "CommitInfo",
    "RemoteAnalysisPipeline",
    "TrendReport",
    "ComparisonReport",
]
