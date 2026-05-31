# -*- coding: utf-8 -*-
"""
Repository Scanner
==================
Trigger and manage analysis for GitHub repositories.

Integrates with:
- GitHub API for code checkout
- AnalysisPipeline for risk analysis
- PR comment posting
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Optional GitHub SDK
try:
    from github import Github, Auth
    from github.Repository import Repository
    HAS_PYGITHUB = True
except ImportError:
    HAS_PYGITHUB = False
    Github = None  # type: ignore

from ..pipeline import AnalysisPipeline
from ..review_suggestions import generate_review_comment


@dataclass
class ScanResult:
    """Result of a repository scan."""
    success: bool
    repo_full_name: str
    commit_sha: str
    risk_score: float
    risk_level: str
    findings_count: int
    report: dict[str, Any] | None = None
    error: str | None = None


class RepositoryScanner:
    """Scan GitHub repositories for consistency issues.
    
    Example:
        scanner = RepositoryScanner()
        result = scanner.scan_pr(
            repo_full_name="owner/repo",
            base_sha="abc123",
            head_sha="def456",
            access_token="ghp_xxx"
        )
    """
    
    def __init__(self, work_dir: str | Path | None = None) -> None:
        """Initialize scanner.
        
        Parameters
        ----------
        work_dir : str | Path | None
            Directory for temporary clones. If None, uses system temp.
        """
        self.work_dir = Path(work_dir) if work_dir else Path(tempfile.gettempdir()) / "consistency_scans"
        self.work_dir.mkdir(parents=True, exist_ok=True)
    
    def scan_pr(
        self,
        repo_full_name: str,
        base_sha: str,
        head_sha: str,
        access_token: str,
        pr_number: int | None = None,
        installation_id: int | None = None,
        post_comment: bool = True,
    ) -> ScanResult:
        """Scan a pull request.
        
        Parameters
        ----------
        repo_full_name : str
            Full repository name (owner/repo)
        base_sha : str
            Base commit SHA
        head_sha : str
            Head commit SHA
        access_token : str
            GitHub access token
        pr_number : int | None
            Pull request number (for tracking/comments)
        installation_id : int | None
            Installation ID (for tracking)
        post_comment : bool
            Whether to post PR comment
            
        Returns
        -------
        ScanResult
            Scan result with report
        """
        if not HAS_PYGITHUB:
            return ScanResult(
                success=False,
                repo_full_name=repo_full_name,
                commit_sha=head_sha,
                risk_score=0.0,
                risk_level="unknown",
                findings_count=0,
                error="PyGithub not installed",
            )
        
        clone_path = self.work_dir / repo_full_name.replace("/", "_")
        
        try:
            # Clone repository
            self._clone_repo(repo_full_name, access_token, clone_path)
            
            # Run analysis
            pipeline = AnalysisPipeline(str(clone_path))
            report = pipeline.pr_risk_report(
                base_ref=base_sha,
                head_ref=head_sha,
            )
            
            result = ScanResult(
                success=True,
                repo_full_name=repo_full_name,
                commit_sha=head_sha,
                risk_score=report.get("avg_risk", 0.0),
                risk_level=self._risk_level(report.get("avg_risk", 0.0)),
                findings_count=len(report.get("security_findings", [])),
                report=report,
            )
            
            # Post comment if requested
            if post_comment and pr_number:
                self.post_pr_comment(
                    repo_full_name=repo_full_name,
                    pr_number=pr_number,
                    result=result,
                    access_token=access_token,
                )
            
            return result
            
        except Exception as e:
            return ScanResult(
                success=False,
                repo_full_name=repo_full_name,
                commit_sha=head_sha,
                risk_score=0.0,
                risk_level="error",
                findings_count=0,
                error=str(e),
            )
        finally:
            # Cleanup
            self._cleanup_clone(clone_path)
    
    def scan_push(
        self,
        repo_full_name: str,
        commit_sha: str,
        access_token: str,
    ) -> ScanResult:
        """Scan a push event (analyze commit against baseline).
        
        Parameters
        ----------
        repo_full_name : str
            Full repository name
        commit_sha : str
            Commit SHA to analyze
        access_token : str
            GitHub access token
            
        Returns
        -------
        ScanResult
            Scan result
        """
        if not HAS_PYGITHUB:
            return ScanResult(
                success=False,
                repo_full_name=repo_full_name,
                commit_sha=commit_sha,
                risk_score=0.0,
                risk_level="unknown",
                findings_count=0,
                error="PyGithub not installed",
            )
        
        clone_path = self.work_dir / repo_full_name.replace("/", "_")
        
        try:
            self._clone_repo(repo_full_name, access_token, clone_path)
            
            pipeline = AnalysisPipeline(str(clone_path))
            # Use full SHA, not truncated - GitPython can handle both
            result = pipeline.analyze_commit(commit_sha=commit_sha)
            
            return ScanResult(
                success=True,
                repo_full_name=repo_full_name,
                commit_sha=commit_sha,
                risk_score=result.get("final_risk_score", 0.0),
                risk_level=result.get("risk_level", "unknown"),
                findings_count=result.get("files_analyzed", 0),
                report=result,
            )
            
        except Exception as e:
            return ScanResult(
                success=False,
                repo_full_name=repo_full_name,
                commit_sha=commit_sha,
                risk_score=0.0,
                risk_level="error",
                findings_count=0,
                error=str(e),
            )
        finally:
            self._cleanup_clone(clone_path)
    
    def _clone_repo(
        self,
        repo_full_name: str,
        access_token: str,
        clone_path: Path,
    ) -> None:
        """Clone repository using GitHub installation token.

        Credentials are embedded in the URL (standard GitHub App pattern).
        The token is stripped from all error output before raising so it
        never surfaces in logs or exception tracebacks.
        """
        import subprocess
        import re

        # Guard against URL/path injection via repo_full_name
        if not re.fullmatch(r"[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+", repo_full_name):
            raise ValueError(f"Invalid repository name: {repo_full_name!r}")

        # Remove existing clone
        if clone_path.exists():
            self._cleanup_clone(clone_path)

        # Embed token in URL – standard GitHub App cloning pattern.
        # Error messages are sanitized below so the secret cannot leak.
        auth_url = f"https://x-access-token:{access_token}@github.com/{repo_full_name}.git"

        result = subprocess.run(
            ["git", "clone", "--depth", "50", auth_url, str(clone_path)],
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            # Always strip token before surfacing the error
            error_msg = result.stderr.replace(access_token, "***TOKEN***")
            raise RuntimeError(f"Clone failed: {error_msg}")
    
    def _cleanup_clone(self, clone_path: Path) -> None:
        """Remove cloned repository."""
        import shutil
        if clone_path.exists():
            shutil.rmtree(clone_path, ignore_errors=True)
    
    def _post_pr_comment(
        self,
        repo_full_name: str,
        commit_sha: str,
        report: dict[str, Any],
        access_token: str,
    ) -> bool:
        """Post analysis comment to PR."""
        if not HAS_PYGITHUB:
            return False
        
        try:
            auth = Auth.Token(access_token)
            g = Github(auth=auth)
            
            owner, repo = repo_full_name.split("/", 1)
            repository = g.get_repo(repo_full_name)
            
            # Find PR for this commit
            prs = repository.get_pulls(state="open")
            target_pr = None
            
            for pr in prs:
                if pr.head.sha == commit_sha:
                    target_pr = pr
                    break
            
            if not target_pr:
                return False
            
            # Generate and post comment
            comment = generate_review_comment(report, use_llm=False)
            target_pr.create_issue_comment(comment)
            
            return True
            
        except Exception as e:
            print(f"Failed to post comment: {e}")
            return False
    
    def post_pr_comment(
        self,
        repo_full_name: str,
        pr_number: int,
        result: ScanResult,
        access_token: str,
    ) -> bool:
        """Post analysis comment to PR.
        
        Parameters
        ----------
        repo_full_name : str
            Full repository name (owner/repo)
        pr_number : int
            PR number
        result : ScanResult
            Scan result to post
        access_token : str
            GitHub access token
            
        Returns
        -------
        bool
            True if comment posted successfully
        """
        if not HAS_PYGITHUB:
            return False
        
        try:
            from github import Auth
            from github import Github
            
            auth = Auth.Token(access_token)
            g = Github(auth=auth)
            
            repository = g.get_repo(repo_full_name)
            pr = repository.get_pull(pr_number)
            
            # Generate comment body
            risk_emoji = {
                "High Risk": "🔴",
                "Significant Drift": "🟠", 
                "Minor Drift": "🟡",
                "Consistent": "🟢",
            }.get(result.risk_level, "⚪")
            
            comment = f"""## {risk_emoji} ConsistenCy Analysis Report

**Risk Level:** {result.risk_level}
**Risk Score:** {result.risk_score:.1%}
**Files Analyzed:** {result.findings_count}

### Summary
This PR has been analyzed for code consistency, style adherence, and potential risks.

<details>
<summary>View detailed report</summary>

```json
{json.dumps(result.report, indent=2, default=str)[:2000]}
```

</details>

---
*Generated by ConsistenCy v2.5.0*
"""
            
            pr.create_issue_comment(comment)
            return True
            
        except Exception as e:
            import logging
            logging.error(f"Failed to post PR comment: {e}")
            return False

    def scan_commit(
        self,
        repo_full_name: str,
        commit_sha: str,
        access_token: str,
        installation_id: int | None = None,
    ) -> ScanResult:
        """Scan a specific commit (alias for scan_push).
        
        Parameters
        ----------
        repo_full_name : str
            Full repository name
        commit_sha : str
            Commit SHA to analyze
        access_token : str
            GitHub access token
        installation_id : int | None
            Optional installation ID for tracking
            
        Returns
        -------
        ScanResult
            Scan result
        """
        return self.scan_push(repo_full_name, commit_sha, access_token)

    @staticmethod
    def _risk_level(score: float) -> str:
        """Convert score to risk level."""
        if score >= 0.75:
            return "High Risk"
        elif score >= 0.50:
            return "Significant Drift"
        elif score >= 0.25:
            return "Minor Drift"
        return "Consistent"
    
    def get_org_dashboard_data(
        self,
        account_login: str,
        installation_manager: Any,
    ) -> dict[str, Any]:
        """Get dashboard data for organization.
        
        Parameters
        ----------
        account_login : str
            Organization login
        installation_manager : InstallationManager
            Installation manager instance
            
        Returns
        -------
        dict
            Dashboard data for all repos in org
        """
        stats = installation_manager.get_org_stats(account_login)
        
        # Get all repos for org
        with installation_manager._lock:
            conn = sqlite3.connect(str(installation_manager.db_path))
            cursor = conn.cursor()
            
            cursor.execute("""
                SELECT r.full_name, r.enabled, r.config
                FROM repo_settings r
                JOIN installations i ON r.installation_id = i.id
                WHERE i.account_login = ?
            """, (account_login,))
            
            repos = []
            for row in cursor.fetchall():
                repos.append({
                    "full_name": row[0],
                    "enabled": bool(row[1]),
                    "config": json.loads(row[2]) if row[2] else {},
                })
            
            conn.close()
        
        return {
            "account_login": account_login,
            "stats": stats,
            "repositories": repos,
        }
