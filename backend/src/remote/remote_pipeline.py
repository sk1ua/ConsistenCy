# -*- coding: utf-8 -*-
"""
Remote Analysis Pipeline
========================

Analyze GitHub repositories without local cloning.
Fetches data via GitHub API and runs analysis agents.
"""
from __future__ import annotations

import json
import sqlite3
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..pipeline import analyze_sources
from ..agents.parser_agent import ParserAgent
from ..baseline_strategy import detect_file_scenario, FileScenario, get_template_baseline
from .github_client import GitHubClient, RepoMetadata, CommitInfo


@dataclass
class RemoteFileAnalysis:
    """Analysis result for a single file.

    Fields ``baseline_strategy``, ``current_ref`` and ``baseline_ref`` describe
    HOW the comparison baseline was chosen so that downstream consumers (CLI
    JSON output, evaluation scripts, dashboards) can reason about whether the
    score reflects a true commit-vs-parent diff or a degenerate fallback.

    ``baseline_strategy`` values:
      - ``"parent_commit"``           - real diff against parent commit content.
      - ``"new_file_empty_baseline"`` - file did not exist in parent; empty baseline.
      - ``"new_file_template_baseline"`` - file did not exist in parent; a language
        template was used as baseline (better signal than empty).
      - ``"empty_no_parent"``         - the commit has no parent (initial commit).
      - ``"unknown_legacy_cache"``    - loaded from a cache written before these
        fields existed; the actual strategy is unknown.
    """
    path: str
    language: str
    risk_score: float
    risk_level: str
    breakdown: dict[str, float]
    metrics: dict[str, Any]
    baseline_strategy: str = "unknown_legacy_cache"
    current_ref: str = ""
    baseline_ref: str | None = None


@dataclass
class RemoteCommitAnalysis:
    """Analysis result for a single commit."""
    sha: str
    message: str
    author: str
    date: datetime
    risk_score: float
    risk_level: str
    files_analyzed: int
    file_results: list[RemoteFileAnalysis]
    evolution_score: float


@dataclass
class RemoteRepoAnalysis:
    """Complete repository analysis result."""
    metadata: RepoMetadata
    analyzed_at: datetime
    commits_analyzed: int
    overall_risk: float
    risk_level: str
    commit_results: list[RemoteCommitAnalysis]
    top_risky_files: list[RemoteFileAnalysis]
    language_breakdown: dict[str, int]


@dataclass
class TrendReport:
    """Historical trend analysis report."""
    repo_full_name: str
    period: str  # "weekly", "monthly", "quarterly"
    start_date: datetime
    end_date: datetime
    data_points: list[dict[str, Any]]  # time series data
    trends: dict[str, Any]  # trend analysis results
    insights: list[str]  # natural language insights


@dataclass
class ComparisonReport:
    """Compare two time periods."""
    repo_full_name: str
    baseline_period: str
    current_period: str
    baseline_risk: float
    current_risk: float
    risk_delta: float
    risk_delta_percent: float
    file_changes: dict[str, Any]
    new_files: list[str]
    removed_files: list[str]
    modified_files: list[str]


class RemoteAnalysisPipeline:
    """Analyze GitHub repositories remotely.
    
    Parameters
    ----------
    client : GitHubClient
        GitHub API client
    cache_dir : Path | None
        Directory for caching downloaded files
    """
    
    def __init__(
        self,
        client: GitHubClient,
        cache_dir: Path | None = None,
    ) -> None:
        self.client = client
        self.cache_dir = cache_dir or Path(tempfile.gettempdir()) / "consistency_remote_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
        # Initialize cache database
        self._init_cache()
        
        # Parser agent for file analysis
        self._parser = ParserAgent()
    
    def _init_cache(self) -> None:
        """Initialize SQLite cache for downloaded files."""
        self.cache_db = self.cache_dir / "remote_cache.db"
        conn = sqlite3.connect(str(self.cache_db))
        cursor = conn.cursor()
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS file_cache (
                repo_owner TEXT,
                repo_name TEXT,
                file_path TEXT,
                commit_sha TEXT,
                content TEXT,
                fetched_at TEXT,
                PRIMARY KEY (repo_owner, repo_name, file_path, commit_sha)
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS analysis_cache (
                repo_owner TEXT,
                repo_name TEXT,
                commit_sha TEXT,
                result_json TEXT,
                analyzed_at TEXT,
                PRIMARY KEY (repo_owner, repo_name, commit_sha)
            )
        """)
        
        conn.commit()
        conn.close()
    
    def analyze_repo(
        self,
        owner: str,
        repo: str,
        since: datetime | None = None,
        until: datetime | None = None,
        max_commits: int = 50,
    ) -> RemoteRepoAnalysis:
        """Analyze a remote repository.
        
        Parameters
        ----------
        owner : str
            Repository owner
        repo : str
            Repository name
        since : datetime | None
            Start date for analysis
        until : datetime | None
            End date for analysis
        max_commits : int
            Maximum commits to analyze
            
        Returns
        -------
        RemoteRepoAnalysis
            Complete analysis results
        """
        # Fetch metadata
        metadata = self.client.get_repo(owner, repo)
        
        # Default date range: last 90 days
        if until is None:
            until = datetime.now(timezone.utc)
        if since is None:
            since = until - timedelta(days=90)
        
        # Fetch commits
        commits = self.client.list_commits(
            owner, repo,
            since=since,
            until=until,
            max_pages=max_commits // 100 + 1,
        )[:max_commits]
        
        # Analyze each commit
        commit_results: list[RemoteCommitAnalysis] = []
        all_file_results: list[RemoteFileAnalysis] = []
        language_counts: dict[str, int] = {}
        
        for commit in commits:
            result = self._analyze_commit(owner, repo, commit)
            if result:
                commit_results.append(result)
                all_file_results.extend(result.file_results)
                
                for f in result.file_results:
                    language_counts[f.language] = language_counts.get(f.language, 0) + 1
        
        # Calculate overall risk
        if commit_results:
            overall_risk = sum(c.risk_score for c in commit_results) / len(commit_results)
        else:
            overall_risk = 0.0
        
        # Get top risky files
        file_risk_map: dict[str, RemoteFileAnalysis] = {}
        for f in all_file_results:
            if f.path not in file_risk_map or f.risk_score > file_risk_map[f.path].risk_score:
                file_risk_map[f.path] = f
        
        top_risky = sorted(file_risk_map.values(), key=lambda x: x.risk_score, reverse=True)[:10]
        
        return RemoteRepoAnalysis(
            metadata=metadata,
            analyzed_at=datetime.now(timezone.utc),
            commits_analyzed=len(commit_results),
            overall_risk=overall_risk,
            risk_level=self._risk_level(overall_risk),
            commit_results=commit_results,
            top_risky_files=top_risky,
            language_breakdown=language_counts,
        )
    
    def _analyze_commit(
        self,
        owner: str,
        repo: str,
        commit: CommitInfo,
    ) -> RemoteCommitAnalysis | None:
        """Analyze a single commit."""
        # Check cache
        cached = self._get_cached_analysis(owner, repo, commit.sha)
        if cached:
            return cached
        
        # Analyze changed files
        file_results: list[RemoteFileAnalysis] = []
        parent_sha: str | None = commit.parents[0]["sha"] if commit.parents else None

        for file_info in commit.files[:20]:  # Limit files per commit
            path = file_info.get("filename", "")

            # Skip non-code files
            if not self._is_code_file(path):
                continue

            # Fetch current and parent-commit versions for true drift comparison
            current_content = self._fetch_file(owner, repo, path, commit.sha)
            if not current_content:
                continue

            # Decide baseline strategy. Order:
            #   1. parent_commit         - parent has this file, use its content.
            #   2. new_file_empty_baseline / new_file_template_baseline
            #      - parent exists but file is new in this commit.
            #   3. empty_no_parent       - commit has no parent (initial commit).
            baseline_content = ""
            baseline_ref: str | None = None
            if parent_sha is None:
                baseline_strategy = "empty_no_parent"
            else:
                parent_content = self._fetch_file(owner, repo, path, parent_sha)
                if parent_content:
                    baseline_content = parent_content
                    baseline_ref = parent_sha
                    baseline_strategy = "parent_commit"
                else:
                    template = get_template_baseline(path)
                    if template:
                        baseline_content = template
                        baseline_strategy = "new_file_template_baseline"
                    else:
                        baseline_strategy = "new_file_empty_baseline"

            # Analyze
            try:
                result = analyze_sources(current_content, baseline_content, filepath=path)

                file_results.append(RemoteFileAnalysis(
                    path=path,
                    language=self._detect_language(path),
                    risk_score=result["risk_score"],
                    risk_level=result["risk_level"],
                    breakdown=result.get("breakdown", {}),
                    metrics={},
                    baseline_strategy=baseline_strategy,
                    current_ref=commit.sha,
                    baseline_ref=baseline_ref,
                ))
            except Exception:
                continue
        
        if not file_results:
            return None
        
        # Calculate commit risk
        avg_risk = sum(f.risk_score for f in file_results) / len(file_results)
        
        result = RemoteCommitAnalysis(
            sha=commit.sha,
            message=commit.message,
            author=commit.author_name,
            date=commit.author_date,
            risk_score=avg_risk,
            risk_level=self._risk_level(avg_risk),
            files_analyzed=len(file_results),
            file_results=file_results,
            evolution_score=0.0,  # Simplified for remote analysis
        )
        
        # Cache result
        self._cache_analysis(owner, repo, commit.sha, result)
        
        return result
    
    def _fetch_file(
        self,
        owner: str,
        repo: str,
        path: str,
        ref: str,
    ) -> str | None:
        """Fetch file content with caching."""
        # Check cache
        conn = sqlite3.connect(str(self.cache_db))
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT content FROM file_cache
            WHERE repo_owner = ? AND repo_name = ? AND file_path = ? AND commit_sha = ?
        """, (owner, repo, path, ref))
        
        row = cursor.fetchone()
        if row:
            conn.close()
            return row[0]
        
        # Fetch from API
        content = self.client.get_file_content(owner, repo, path, ref)
        
        if content:
            # Cache it
            cursor.execute("""
                INSERT OR REPLACE INTO file_cache
                (repo_owner, repo_name, file_path, commit_sha, content, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (owner, repo, path, ref, content, datetime.now(timezone.utc).isoformat()))
            conn.commit()
        
        conn.close()
        return content
    
    def _get_cached_analysis(
        self,
        owner: str,
        repo: str,
        sha: str,
    ) -> RemoteCommitAnalysis | None:
        """Get cached analysis result."""
        conn = sqlite3.connect(str(self.cache_db))
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT result_json FROM analysis_cache
            WHERE repo_owner = ? AND repo_name = ? AND commit_sha = ?
        """, (owner, repo, sha))
        
        row = cursor.fetchone()
        conn.close()
        
        if row:
            try:
                data = json.loads(row[0])
                # Reconstruct object - tolerate legacy cache entries that lack
                # the baseline_strategy/current_ref/baseline_ref fields.
                file_results: list[RemoteFileAnalysis] = []
                for f in data["file_results"]:
                    file_results.append(RemoteFileAnalysis(
                        path=f["path"],
                        language=f["language"],
                        risk_score=f["risk_score"],
                        risk_level=f["risk_level"],
                        breakdown=f.get("breakdown", {}),
                        metrics=f.get("metrics", {}),
                        baseline_strategy=f.get("baseline_strategy", "unknown_legacy_cache"),
                        current_ref=f.get("current_ref", ""),
                        baseline_ref=f.get("baseline_ref"),
                    ))
                return RemoteCommitAnalysis(
                    sha=data["sha"],
                    message=data["message"],
                    author=data["author"],
                    date=datetime.fromisoformat(data["date"]),
                    risk_score=data["risk_score"],
                    risk_level=data["risk_level"],
                    files_analyzed=data["files_analyzed"],
                    file_results=file_results,
                    evolution_score=data["evolution_score"],
                )
            except Exception:
                return None
        
        return None
    
    def _cache_analysis(
        self,
        owner: str,
        repo: str,
        sha: str,
        result: RemoteCommitAnalysis,
    ) -> None:
        """Cache analysis result."""
        conn = sqlite3.connect(str(self.cache_db))
        cursor = conn.cursor()
        
        data = {
            "sha": result.sha,
            "message": result.message,
            "author": result.author,
            "date": result.date.isoformat(),
            "risk_score": result.risk_score,
            "risk_level": result.risk_level,
            "files_analyzed": result.files_analyzed,
            "file_results": [
                {
                    "path": f.path,
                    "language": f.language,
                    "risk_score": f.risk_score,
                    "risk_level": f.risk_level,
                    "breakdown": f.breakdown,
                    "metrics": f.metrics,
                    "baseline_strategy": f.baseline_strategy,
                    "current_ref": f.current_ref,
                    "baseline_ref": f.baseline_ref,
                }
                for f in result.file_results
            ],
            "evolution_score": result.evolution_score,
        }
        
        cursor.execute("""
            INSERT OR REPLACE INTO analysis_cache
            (repo_owner, repo_name, commit_sha, result_json, analyzed_at)
            VALUES (?, ?, ?, ?, ?)
        """, (owner, repo, sha, json.dumps(data), datetime.now(timezone.utc).isoformat()))
        
        conn.commit()
        conn.close()
    
    def analyze_trends(
        self,
        owner: str,
        repo: str,
        period: str = "monthly",
        months: int = 12,
    ) -> TrendReport:
        """Analyze historical trends.
        
        Parameters
        ----------
        owner : str
            Repository owner
        repo : str
            Repository name
        period : str
            "weekly", "monthly", or "quarterly"
        months : int
            Number of months to analyze
        """
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=30 * months)
        
        # Analyze repo over time
        analysis = self.analyze_repo(owner, repo, since=start_date, until=end_date)
        
        # Group by period
        data_points: list[dict[str, Any]] = []
        
        if period == "monthly":
            # Group commits by month
            monthly_data: dict[str, list[RemoteCommitAnalysis]] = {}
            for commit in analysis.commit_results:
                key = commit.date.strftime("%Y-%m")
                monthly_data.setdefault(key, []).append(commit)
            
            for month, commits in sorted(monthly_data.items()):
                if commits:
                    avg_risk = sum(c.risk_score for c in commits) / len(commits)
                    data_points.append({
                        "period": month,
                        "commits": len(commits),
                        "avg_risk": avg_risk,
                        "risk_level": self._risk_level(avg_risk),
                    })
        
        # Generate insights
        insights = self._generate_trend_insights(data_points)
        
        return TrendReport(
            repo_full_name=f"{owner}/{repo}",
            period=period,
            start_date=start_date,
            end_date=end_date,
            data_points=data_points,
            trends={},
            insights=insights,
        )
    
    def _generate_trend_insights(self, data_points: list[dict]) -> list[str]:
        """Generate natural language insights from trend data."""
        insights: list[str] = []
        
        if len(data_points) < 2:
            return ["Insufficient data for trend analysis."]
        
        # Check for increasing/decreasing trend
        first_risk = data_points[0]["avg_risk"]
        last_risk = data_points[-1]["avg_risk"]
        delta = last_risk - first_risk
        
        if delta > 0.1:
            insights.append(f"Risk has increased by {delta:.1%} over the analysis period.")
        elif delta < -0.1:
            insights.append(f"Risk has decreased by {abs(delta):.1%} over the analysis period.")
        else:
            insights.append("Risk has remained stable over the analysis period.")
        
        # Find highest risk period
        max_risk = max(data_points, key=lambda x: x["avg_risk"])
        insights.append(f"Highest risk period: {max_risk['period']} ({max_risk['avg_risk']:.1%})")
        
        return insights
    
    def _is_code_file(self, path: str) -> bool:
        """Check if file is a supported code file."""
        code_extensions = {".py", ".js", ".jsx", ".ts", ".tsx"}
        return any(path.endswith(ext) for ext in code_extensions)
    
    def _detect_language(self, path: str) -> str:
        """Detect language from file extension."""
        ext_map = {
            ".py": "python",
            ".js": "javascript",
            ".jsx": "javascript",
            ".ts": "typescript",
            ".tsx": "typescript",
        }
        for ext, lang in ext_map.items():
            if path.endswith(ext):
                return lang
        return "unknown"
    
    def _risk_level(self, score: float) -> str:
        """Convert score to risk level."""
        if score >= 0.75:
            return "High Risk"
        elif score >= 0.50:
            return "Significant Drift"
        elif score >= 0.25:
            return "Minor Drift"
        return "Consistent"
