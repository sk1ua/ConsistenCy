# -*- coding: utf-8 -*-
"""
Analysis Pipeline
=================
Orchestrates all agents to produce a complete analysis report for a
repository or a single commit.

This module bridges the Git history layer (GitPython) with the
multi-agent analysis layer.
"""
from __future__ import annotations

import hashlib
import os
import statistics
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import git
    HAS_GIT = True
except ImportError:
    HAS_GIT = False

from .agents import (
    DuplicationAgent,
    EvolutionAgent,
    ParserAgent,
    RiskScoringAgent,
    SemanticAgent,
    SecurityAgent,
    StructuralAgent,
    StyleAgent,
)
from .agents.base_agent import AgentResult
from .agents.structural_agent import _build_class_bases_map
from .baseline_strategy import (
    detect_file_scenario,
    select_baseline_strategy,
    get_template_baseline,
)
from .baseline_storage import BaselineStorage

# Multi-language support
try:
    from .parsers import get_supported_extensions, is_supported_file
    _SUPPORTED_EXTS = get_supported_extensions()
except ImportError:
    _SUPPORTED_EXTS = [".py"]  # Fallback to Python only

try:
    from config import PIPELINE_CONFIG as _PCFG
except ImportError:
    _PCFG = {}

_MAX_FILES_PER_COMMIT = _PCFG.get("max_files_per_commit", 20)
_MAX_FILES_PER_WEEKLY = _PCFG.get("max_files_per_weekly_commit", 5)
_LLM_REVIEW_TOP = _PCFG.get("llm_review_top_files", 5)
_WEEKLY_FULL = _PCFG.get("weekly_full_analysis", True)
_WEEKLY_MAX_COMMITS = _PCFG.get("weekly_history_max_commits", 200)
_AUTHOR_FULL = _PCFG.get("author_breakdown_full_analysis", True)
_AUTHOR_MAX_COMMITS = _PCFG.get("author_breakdown_max_commits", 100)
_AUTHOR_MAX_FILES_PER_COMMIT = _PCFG.get("max_files_per_author_commit", 5)
_AUTHOR_BASELINE_COMMITS = _PCFG.get("author_breakdown_baseline_commits", 30)
_HOTSPOT_MAX_COMMITS = _PCFG.get("hotspot_max_commits", 100)
_HOTSPOT_TOP_N = _PCFG.get("hotspot_top_n", 30)

_parser = ParserAgent()
_style = StyleAgent()
_structural = StructuralAgent()
_semantic = SemanticAgent()
_evolution = EvolutionAgent()
_duplication = DuplicationAgent()
_security = SecurityAgent()
_risk = RiskScoringAgent()


# ---------------------------------------------------------------------------
# Multi-language helpers
# ---------------------------------------------------------------------------

def _is_analyzable_file(filepath: str) -> bool:
    """Check if file extension is supported for analysis."""
    return any(filepath.lower().endswith(ext) for ext in _SUPPORTED_EXTS)


def _get_file_language(filepath: str) -> str:
    """Detect programming language from file extension."""
    ext = Path(filepath).suffix.lower()
    lang_map = {
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
    }
    return lang_map.get(ext, "unknown")


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def _file_source(commit, path: str) -> str:
    """Return the decoded text content of *path* at *commit*."""
    try:
        blob = commit.tree[path]
        return blob.data_stream.read().decode("utf-8", errors="replace")
    except (KeyError, AttributeError):
        return ""


def _commit_diff_stats(commit) -> dict[str, Any]:
    """Return supported-file churn, touched files, and commit metadata."""
    additions = deletions = 0
    files: list[str] = []
    file_churn_map: dict[str, int] = {}
    try:
        for filepath, diff in commit.stats.files.items():
            if not _is_analyzable_file(filepath):
                continue

            ins = diff.get("insertions", 0)
            dels = diff.get("deletions", 0)
            churn = ins + dels
            additions += ins
            deletions += dels

            files.append(filepath)
            file_churn_map[filepath] = churn
    except Exception:  # noqa: BLE001
        pass
    return {
        "sha": commit.hexsha[:8],
        "author": commit.author.name or "unknown",
        "message": (commit.message or "").strip()[:120],
        "date": commit.committed_datetime.isoformat(),
        "additions": additions,
        "deletions": deletions,
        "files": files,
        "file_churn_map": file_churn_map,
    }


def _score_to_level(score: float) -> str:
    if score >= 0.75:
        return "High Risk"
    if score >= 0.50:
        return "Significant Drift"
    if score >= 0.25:
        return "Minor Drift"
    return "Consistent"


# ---------------------------------------------------------------------------
# Source-level analysis (no git required)
# ---------------------------------------------------------------------------

def analyze_sources(
    source_now: str,
    source_base: str,
    project_class_bases: dict[str, list[str]] | None = None,
    aggregated_baseline: dict[str, Any] | None = None,
    filepath: str | None = None,
) -> dict[str, Any]:
    """Run all code-level agents on two source strings.

    Parameters
    ----------
    source_now : str
        Current version of the file.
    source_base : str
        Baseline version of the file.
    project_class_bases : dict | None
        Cross-file class hierarchy map {class_name: [base_names]} built
        from the full project.  Passed to StructuralAgent for accurate
        inheritance depth analysis.
    aggregated_baseline : dict | None
        When provided, this pre-parsed/aggregated snapshot dict is used
        as the baseline instead of parsing *source_base* fresh.  This
        enables multi-version statistical baselines.
    filepath : str | None
        File path for language detection (enables multi-language support)

    Returns a dict with per-agent scores and the final risk score.
    """
    # Use multi-language parser if filepath provided
    if filepath:
        snapshot_now = _parser.parse_file(source_now, filepath)
    else:
        snapshot_now = _parser.parse(source_now)
    snapshot_now["source"] = source_now

    # Use aggregated baseline if available, otherwise parse single source
    if aggregated_baseline is not None:
        snapshot_base = aggregated_baseline
    else:
        if filepath:
            snapshot_base = _parser.parse_file(source_base, filepath)
        else:
            snapshot_base = _parser.parse(source_base)
        snapshot_base["source"] = source_base

    # Cross-file class map for StructuralAgent
    if project_class_bases:
        snapshot_now["project_class_bases"] = project_class_bases

    results: dict[str, AgentResult] = {
        "ParserAgent": _parser.run(snapshot_now, snapshot_base),
        "StyleAgent": _style.run(snapshot_now, snapshot_base),
        "StructuralAgent": _structural.run(snapshot_now, snapshot_base),
        "SemanticAgent": _semantic.run(snapshot_now, snapshot_base),
        "DuplicationAgent": _duplication.run(snapshot_now, snapshot_base),
        "SecurityAgent": _security.run(snapshot_now, snapshot_base),
    }

    final = _risk.aggregate(results)

    return {
        "risk_score": round(final.score, 4),
        "risk_level": final.details.get("risk_level", ""),
        "risk_colour": final.details.get("risk_colour", ""),
        "breakdown": final.details.get("breakdown", {}),
        "evidence": final.evidence,
        "agent_details": {
            name: {
                "score": round(r.score, 4),
                "evidence": r.evidence,
                "elapsed_ms": round(r.elapsed_ms, 2),
            }
            for name, r in results.items()
        },
    }


# ---------------------------------------------------------------------------
# Pipeline class (requires GitPython)
# ---------------------------------------------------------------------------

class AnalysisPipeline:
    """Full pipeline: Git repo → per-commit analysis → aggregated reports."""

    def __init__(self, repo_path: str, enable_persistent_cache: bool = True) -> None:
        if not HAS_GIT:
            raise ImportError("gitpython is required for AnalysisPipeline")
        self.repo = git.Repo(repo_path)
        self.repo_path = Path(repo_path)
        # Cache source retrieval by (commit_sha, filepath)
        self._file_source_cache: dict[tuple[str, str], str] = {}
        # Cache aggregated baseline source by (filepath + commit-window fingerprint)
        self._baseline_window_cache: dict[str, str] = {}
        self._cache_stats: dict[str, int] = {
            "file_source_hit": 0,
            "file_source_miss": 0,
            "baseline_hit": 0,
            "baseline_miss": 0,
            "persistent_hit": 0,
            "persistent_miss": 0,
        }
        # Persistent baseline storage (optional)
        self._persistent_cache = None
        if enable_persistent_cache:
            db_path = self.repo_path / ".consistency_baseline.db"
            try:
                self._persistent_cache = BaselineStorage(str(db_path))
            except Exception:
                # Fail gracefully if persistent cache can't be initialized
                pass

    # ------------------------------------------------------------------
    # Internal caching helpers
    # ------------------------------------------------------------------

    def _source_at_commit(self, commit, filepath: str) -> str:
        """Get file source at commit with per-instance cache."""
        key = (commit.hexsha, filepath)
        if key in self._file_source_cache:
            self._cache_stats["file_source_hit"] += 1
            return self._file_source_cache[key]

        self._cache_stats["file_source_miss"] += 1
        src = _file_source(commit, filepath)
        self._file_source_cache[key] = src
        return src

    @staticmethod
    def _commit_window_fingerprint(commits: list, limit: int = 40) -> str:
        """Return a stable fingerprint for a commit window."""
        if not commits:
            return "empty-window"
        head = commits[:limit]
        raw = "|".join(c.hexsha for c in head) + f"|count={len(commits)}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def _select_representative_baseline(versions: list[str]) -> str:
        """Select a representative source from multiple historical versions.

        Preference order:
        1) The most frequent normalised version (mode) if repeated.
        2) Otherwise, the version with LOC closest to the median LOC.
        """
        if not versions:
            return ""
        if len(versions) == 1:
            return versions[0]

        def _normalise(src: str) -> str:
            lines = [line.rstrip() for line in src.splitlines() if line.strip()]
            return "\n".join(lines)

        digests: list[str] = []
        locs: list[int] = []
        for src in versions:
            digests.append(hashlib.sha1(_normalise(src).encode("utf-8")).hexdigest())
            locs.append(len(src.splitlines()))

        digest_count: dict[str, int] = defaultdict(int)
        first_idx: dict[str, int] = {}
        for idx, digest in enumerate(digests):
            digest_count[digest] += 1
            if digest not in first_idx:
                first_idx[digest] = idx

        top_freq = max(digest_count.values())
        if top_freq > 1:
            top_digests = {d for d, c in digest_count.items() if c == top_freq}
            chosen = min(first_idx[d] for d in top_digests)
            return versions[chosen]

        median_loc = statistics.median(locs)
        best_idx = min(
            range(len(versions)),
            key=lambda i: (abs(locs[i] - median_loc), i),
        )
        return versions[best_idx]

    @staticmethod
    def _aggregate_baseline_snapshot(versions: list[str]) -> dict[str, Any] | None:
        """Parse multiple historical versions and aggregate their metrics.

        Returns a synthetic baseline snapshot dict where numeric metrics
        represent the median across all versions, and set-valued metrics
        (imports, api calls) represent the union.  This gives a more
        statistically stable baseline than picking a single version.

        Returns None if fewer than 2 valid versions (in that case, fall
        back to the single-version path).
        """
        if len(versions) < 2:
            return None

        parsed: list[dict[str, Any]] = []
        for src in versions:
            snap = _parser.parse(src)
            if "error" not in snap:
                snap["source"] = src
                parsed.append(snap)

        if len(parsed) < 2:
            return None

        # --- Aggregate numeric metrics via median ---
        cc_vals = [p.get("cyclomatic_avg", 0.0) for p in parsed]
        halsteads = [p.get("halstead", {}) for p in parsed]

        agg: dict[str, Any] = {}
        agg["cyclomatic_avg"] = statistics.median(cc_vals)

        # Halstead: median of each sub-metric
        hal_keys = ("n1", "n2", "N1", "N2", "volume", "difficulty", "effort")
        agg_hal: dict[str, float] = {}
        for k in hal_keys:
            vals = [h.get(k, 0.0) for h in halsteads]
            agg_hal[k] = statistics.median(vals)
        agg["halstead"] = agg_hal

        # LOC: median
        loc_keys = ("total", "code", "blank", "comment")
        agg_loc: dict[str, int] = {}
        for k in loc_keys:
            vals = [p.get("loc", {}).get(k, 0) for p in parsed]
            agg_loc[k] = int(statistics.median(vals))
        agg["loc"] = agg_loc

        # --- Set-valued metrics: frequency-weighted union ---
        # Imports: keep imports that appear in >50% of versions
        from collections import Counter as _Counter
        import_counter: _Counter[str] = _Counter()
        for p in parsed:
            for imp in p.get("imports", []):
                import_counter[imp] += 1
        threshold = len(parsed) / 2
        agg["imports"] = [imp for imp, cnt in import_counter.items() if cnt >= threshold]

        # Use the representative source (median LOC) for AST-dependent analysis
        rep_src = AnalysisPipeline._select_representative_baseline(versions)
        agg["source"] = rep_src

        # Functions/classes from representative version (for docstring ratio etc.)
        rep_snap = _parser.parse(rep_src)
        agg["functions"] = rep_snap.get("functions", [])
        agg["classes"] = rep_snap.get("classes", [])

        return agg

    def _baseline_source_from_window(
        self,
        filepath: str,
        commits: list,
        max_versions: int = 8,
        target_commit: Any | None = None,
    ) -> str:
        """Return aggregated baseline source using file+commit-window cache with scenario detection.
        
        Parameters
        ----------
        filepath : str
            Path to file
        commits : list
            List of baseline commits
        max_versions : int
            Maximum versions to collect
        target_commit : Any | None
            Target commit for scenario detection (uses HEAD if None)
        """
        window_fp = self._commit_window_fingerprint(commits)
        cache_key = f"{filepath}|{window_fp}|v{max_versions}"

        # Check in-memory cache first
        if cache_key in self._baseline_window_cache:
            self._cache_stats["baseline_hit"] += 1
            return self._baseline_window_cache[cache_key]

        # Check persistent cache if available
        if self._persistent_cache:
            persistent_result = self._persistent_cache.get_baseline(filepath, window_fp)
            if persistent_result:
                self._cache_stats["persistent_hit"] += 1
                self._baseline_window_cache[cache_key] = persistent_result
                return persistent_result
            self._cache_stats["persistent_miss"] += 1

        self._cache_stats["baseline_miss"] += 1
        
        # Temporarily collect versions with default max to detect scenario
        # We'll recollect with strategy-adjusted max_versions after scenario detection
        temp_versions = self._collect_versions(filepath, commits, max_versions)

        # Detect file scenario and adjust strategy
        if not temp_versions:
            template = get_template_baseline(filepath)
            self._baseline_window_cache[cache_key] = template
            if self._persistent_cache:
                self._persistent_cache.store_baseline(
                    filepath, window_fp, template, scenario_type="NEW_FILE"
                )
            return template
        
        # Get current version for scenario detection (use target_commit if provided)
        if target_commit is None:
            target_commit = self.repo.head.commit
        current_src = self._source_at_commit(target_commit, filepath)
        
        scenario = detect_file_scenario(filepath, current_src, list(reversed(temp_versions)))
        strategy = select_baseline_strategy(scenario, default_window=max_versions)
        
        # Use strategy-driven max_versions (not hardcoded 8)
        strategy_max_versions = strategy.get("max_versions", max_versions)
        
        # Recollect versions if strategy specifies fewer
        if strategy_max_versions < len(temp_versions):
            versions = temp_versions[:strategy_max_versions]
        else:
            versions = temp_versions
        
        # For NEW_FILE scenario with no versions, try template fallback
        if scenario.scenario_type == "NEW_FILE" and strategy["use_template_fallback"]:
            template = get_template_baseline(filepath)
            if template:
                self._baseline_window_cache[cache_key] = template
                if self._persistent_cache:
                    self._persistent_cache.store_baseline(
                        filepath, window_fp, template, scenario_type="NEW_FILE"
                    )
                return template
        
        # Use scenario-aware version selection
        baseline = self._select_representative_baseline(versions)
        self._baseline_window_cache[cache_key] = baseline
        
        # Store in persistent cache
        if self._persistent_cache:
            self._persistent_cache.store_baseline(
                filepath, window_fp, baseline, scenario_type=scenario.scenario_type
            )
            self._persistent_cache.store_scenario(
                filepath,
                scenario.scenario_type,
                scenario.confidence,
                scenario.reason,
            )
        
        return baseline

    def _collect_versions(
        self,
        filepath: str,
        commits: list,
        max_versions: int = 8,
    ) -> list[str]:
        """Collect up to *max_versions* historical source strings for a file."""
        versions: list[str] = []
        for commit in commits:
            src = self._source_at_commit(commit, filepath)
            if src:
                versions.append(src)
            if len(versions) >= max_versions:
                break
        return versions

    def _get_aggregated_baseline(
        self,
        filepath: str,
        commits: list,
        max_versions: int = 8,
    ) -> dict[str, Any] | None:
        """Try to build a multi-version aggregated baseline snapshot.

        Returns an aggregated snapshot dict if ≥ 2 valid versions exist,
        otherwise None (caller should fall back to single-version path).
        """
        versions = self._collect_versions(filepath, commits, max_versions)
        if len(versions) < 2:
            return None
        return self._aggregate_baseline_snapshot(versions)

    def _build_project_class_map(self, commit) -> dict[str, list[str]]:
        """Build a project-wide class-to-bases map for cross-file inheritance.

        Scans all .py files at *commit* and merges their class definitions
        into a single lookup table used by StructuralAgent.
        """
        merged: dict[str, list[str]] = {}
        for item in commit.tree.traverse():
            path = getattr(item, "path", "")
            if not _is_analyzable_file(path):
                continue
            src = self._source_at_commit(commit, path)
            if src:
                merged.update(_build_class_bases_map(src))
        return merged

    def cache_stats(self) -> dict[str, int]:
        """Expose current in-memory and persistent cache usage metrics."""
        stats = {
            **self._cache_stats,
            "file_source_entries": len(self._file_source_cache),
            "baseline_entries": len(self._baseline_window_cache),
        }
        
        # Add persistent cache stats if available
        if self._persistent_cache:
            persistent_stats = self._persistent_cache.get_storage_stats()
            stats["persistent_baseline_entries"] = persistent_stats.get("baseline_entries", 0)
            stats["persistent_db_size_bytes"] = persistent_stats.get("db_size_bytes", 0)
        
        return stats

    def cleanup_persistent_cache(self, days_threshold: int = 30) -> int:
        """Clean up old baseline entries from persistent cache.
        
        Parameters
        ----------
        days_threshold : int
            Remove entries not accessed in this many days
        
        Returns
        -------
        int
            Number of entries removed
        """
        if not self._persistent_cache:
            return 0
        return self._persistent_cache.cleanup_old_entries(days_threshold)

    def export_baselines(self, output_path: str) -> bool:
        """Export all cached baselines to JSON file for distribution/backup.
        
        Parameters
        ----------
        output_path : str
            Path to output JSON file
        
        Returns
        -------
        bool
            True if export successful
        """
        if not self._persistent_cache:
            return False
        return self._persistent_cache.export_baselines_json(output_path)

    # ------------------------------------------------------------------
    # Commit-level analysis
    # ------------------------------------------------------------------

    def analyze_commit(
        self,
        commit_sha: str | None = None,
        baseline_n: int = 50,
    ) -> dict[str, Any]:
        """Analyze a single commit against the last *baseline_n* commits."""
        target = (
            self.repo.commit(commit_sha) if commit_sha
            else self.repo.head.commit
        )
        # Baseline must be relative to the target commit, not always HEAD.
        baseline_commits_raw = list(
            self.repo.iter_commits(rev=target.hexsha, max_count=baseline_n + 1)
        )[1:]  # exclude target itself

        # Build evolution snapshot / baseline
        evol_snapshot = {"commits": [_commit_diff_stats(target)]}
        evol_baseline = {"commits": [_commit_diff_stats(c) for c in baseline_commits_raw]}

        evol_result = _evolution.run(evol_snapshot, evol_baseline)

        # Per-file code analysis
        py_files = [f for f in target.stats.files if _is_analyzable_file(f)]
        file_results: dict[str, dict] = {}
        all_risk_scores: list[float] = []

        # Build project-wide class hierarchy for cross-file inheritance
        project_class_bases = self._build_project_class_map(target)

        # Pre-fetch sources (I/O) sequentially, then analyse in parallel
        file_pairs: list[tuple[str, str, str, dict | None]] = []
        for filepath in py_files[:_MAX_FILES_PER_COMMIT]:
            src_now = self._source_at_commit(target, filepath)
            src_base = self._baseline_source_from_window(
                filepath=filepath,
                commits=baseline_commits_raw,
                max_versions=8,
                target_commit=target,
            )
            if not src_now or not src_base:
                continue
            # Try multi-version aggregated baseline
            agg = self._get_aggregated_baseline(
                filepath, baseline_commits_raw, max_versions=8,
            )
            file_pairs.append((filepath, src_now, src_base, agg))

        # Parallel agent execution per file
        if len(file_pairs) > 1:
            with ThreadPoolExecutor(max_workers=min(len(file_pairs), 4)) as pool:
                futures = {
                    pool.submit(
                        analyze_sources, src_now, src_base,
                        project_class_bases, agg_snap, filepath,
                    ): filepath
                    for filepath, src_now, src_base, agg_snap in file_pairs
                }
                for future in as_completed(futures):
                    filepath = futures[future]
                    analysis = future.result()
                    file_results[filepath] = analysis
                    all_risk_scores.append(analysis["risk_score"])
        else:
            for filepath, src_now, src_base, agg_snap in file_pairs:
                analysis = analyze_sources(
                    src_now, src_base, project_class_bases, agg_snap, filepath,
                )
                file_results[filepath] = analysis
                all_risk_scores.append(analysis["risk_score"])

        # Aggregate risk including evolution
        mean_code_risk = (
            statistics.mean(all_risk_scores) if all_risk_scores else 0.0
        )
        # Blend in evolution anomaly (10 % weight already in risk formula)
        final_risk = round(
            0.90 * mean_code_risk + 0.10 * evol_result.score, 4
        )

        # Convert file_results dict to list format for API consistency
        file_results_list = [
            {
                "file": filepath,
                "risk_score": analysis["risk_score"],
                "risk_level": analysis["risk_level"],
                "breakdown": analysis.get("breakdown", {}),
            }
            for filepath, analysis in file_results.items()
        ]
        # Sort by risk score descending
        file_results_list.sort(key=lambda x: x["risk_score"], reverse=True)

        return {
            "commit": _commit_diff_stats(target),
            "final_risk_score": final_risk,
            "risk_level": _score_to_level(final_risk),
            "evolution_score": round(evol_result.score, 4),
            "evolution_details": evol_result.details,
            "evolution_evidence": evol_result.evidence,
            "files_analyzed": len(file_results_list),
            "file_results": file_results_list,
        }

    # ------------------------------------------------------------------
    # Range analysis
    # ------------------------------------------------------------------

    def analyze_range(
        self,
        weeks: int = 12,
        baseline_n: int = 50,
        max_commits: int = 40,
    ) -> dict[str, Any]:
        """Run commit-by-commit real analysis for a recent time range."""
        since = datetime.now(tz=timezone.utc) - timedelta(weeks=weeks)
        commits = list(self.repo.iter_commits(since=since, max_count=max_commits))
        commits = list(reversed(commits))  # oldest → newest

        if not commits:
            return {
                "weeks": weeks,
                "since": since.isoformat(),
                "commit_count": 0,
                "avg_risk": 0.0,
                "max_risk": 0.0,
                "high_risk_commits": 0,
                "commits": [],
                "weekly": [],
                "cache": self.cache_stats(),
            }

        entries: list[dict[str, Any]] = []
        weekly_scores: dict[str, list[float]] = defaultdict(list)

        for commit in commits:
            res = self.analyze_commit(commit_sha=commit.hexsha, baseline_n=baseline_n)
            score = float(res.get("final_risk_score", 0.0))
            commit_info = res.get("commit", {})
            week_key = commit.committed_datetime.strftime("%Y-W%U")
            weekly_scores[week_key].append(score)
            entries.append({
                "sha": commit_info.get("sha", commit.hexsha[:8]),
                "date": commit_info.get("date", commit.committed_datetime.isoformat()),
                "author": commit_info.get("author", "unknown"),
                "message": commit_info.get("message", ""),
                "risk_score": round(score, 4),
                "risk_level": _score_to_level(score),
                "files_analyzed": int(res.get("files_analyzed", 0)),
            })

        scores = [e["risk_score"] for e in entries]
        weekly = [
            {
                "week": week,
                "avg_risk": round(statistics.mean(vals), 4),
                "commit_count": len(vals),
                "is_estimated": False,
                "real_sample_count": len(vals),
            }
            for week, vals in sorted(weekly_scores.items())
        ]

        return {
            "weeks": weeks,
            "since": since.isoformat(),
            "commit_count": len(entries),
            "avg_risk": round(statistics.mean(scores), 4),
            "max_risk": round(max(scores), 4),
            "high_risk_commits": sum(1 for s in scores if s >= 0.75),
            "commits": entries,
            "weekly": weekly,
            "cache": self.cache_stats(),
        }

    # ------------------------------------------------------------------
    # Time-series history
    # ------------------------------------------------------------------

    def weekly_history(
        self,
        weeks: int = 12,
        full_analysis_per_week: int = 1,
    ) -> list[dict[str, Any]]:
        """Return one aggregated risk score per calendar week.

        Strategy
        --------
        When ``weekly_full_analysis`` is **True** (the default, set in
        ``config.PIPELINE_CONFIG``), *every* commit in every week bucket
        receives a real multi-agent analysis on its Python files.  This
        eliminates the lightweight churn-based proxy that was used for
        all-but-one commits per week.

        When ``weekly_full_analysis`` is **False**, only the first
        *full_analysis_per_week* commits per week receive real analysis;
        the remainder fall back to a churn-based proxy score.
        """
        since = datetime.now(tz=timezone.utc) - timedelta(weeks=weeks)

        all_commits = list(self.repo.iter_commits(since=since, max_count=_WEEKLY_MAX_COMMITS))
        if len(all_commits) < 2:
            return []

        # Group commits by ISO week key
        weekly_commits: dict[str, list] = defaultdict(list)
        for commit in all_commits:
            week_key = commit.committed_datetime.strftime("%Y-W%U")
            weekly_commits[week_key].append(commit)

        result_weeks: list[dict[str, Any]] = []

        for week_key in sorted(weekly_commits):
            commits_in_week = weekly_commits[week_key]
            scores: list[float] = []
            real_sample_count = 0

            # Decide which commits get real analysis
            if _WEEKLY_FULL:
                real_commits = commits_in_week
                proxy_commits: list = []
            else:
                real_commits = commits_in_week[:full_analysis_per_week]
                proxy_commits = commits_in_week[full_analysis_per_week:]

            # --- Real multi-agent analysis ---
            for commit in real_commits:
                baseline_commits = list(
                    self.repo.iter_commits(rev=commit.hexsha, max_count=31)
                )[1:]
                py_files = [f for f in commit.stats.files if _is_analyzable_file(f)]
                file_scores: list[float] = []
                for filepath in py_files[:_MAX_FILES_PER_WEEKLY]:
                    src_now = self._source_at_commit(commit, filepath)
                    src_base = self._baseline_source_from_window(
                        filepath=filepath,
                        commits=baseline_commits,
                        max_versions=8,
                        target_commit=commit,
                    )
                    if src_now and src_base:
                        analysis = analyze_sources(src_now, src_base, filepath=filepath)
                        file_scores.append(analysis["risk_score"])
                if file_scores:
                    scores.append(statistics.mean(file_scores))
                    real_sample_count += 1
                else:
                    # No analysable Python files → lightweight churn fallback
                    diff = _commit_diff_stats(commit)
                    scores.append(min((diff["additions"] + diff["deletions"]) / 500, 1.0))

            # --- Proxy scores for remaining commits (legacy / non-full mode) ---
            for commit in proxy_commits:
                diff = _commit_diff_stats(commit)
                churn = diff["additions"] + diff["deletions"]
                scores.append(min(churn / 500, 1.0))

            result_weeks.append({
                "week": week_key,
                "avg_risk": round(statistics.mean(scores), 4),
                "commit_count": len(commits_in_week),
                "real_sample_count": real_sample_count,
                "is_estimated": real_sample_count == 0,
            })

        return result_weeks

    # ------------------------------------------------------------------
    # File summary
    # ------------------------------------------------------------------

    def file_summary(self) -> list[dict[str, Any]]:
        """Return per-file risk summary for the working tree."""
        results: list[dict[str, Any]] = []
        head = self.repo.head.commit
        baseline_commits = list(self.repo.iter_commits(max_count=20))[1:]

        for item in head.tree.traverse():
            item_path = getattr(item, "path", "")
            if not item_path or not _is_analyzable_file(item_path):
                continue
            src_now = self._source_at_commit(head, item.path)
            src_base = self._baseline_source_from_window(
                filepath=item.path,
                commits=baseline_commits,
                max_versions=8,
                target_commit=head,
            )
            if not src_now:
                continue
            if not src_base:
                src_base = ""  # new file — compare against empty baseline

            analysis = analyze_sources(src_now, src_base, filepath=item.path)
            results.append({
                "file": item.path,
                "risk_score": analysis["risk_score"],
                "risk_level": analysis["risk_level"],
                "breakdown": analysis["breakdown"],
            })

        results.sort(key=lambda x: x["risk_score"], reverse=True)
        return results

    # ------------------------------------------------------------------
    # Author breakdown
    # ------------------------------------------------------------------

    def author_breakdown(self) -> list[dict[str, Any]]:
        """Return per-author aggregated drift statistics.

        When ``author_breakdown_full_analysis`` is enabled, each commit
        score is derived from real multi-agent file analysis. Commits with
        no analysable Python files still fall back to churn proxy.
        """
        author_scores: dict[str, list[float]] = defaultdict(list)
        author_proxy_scores: dict[str, list[float]] = defaultdict(list)
        author_commits: dict[str, int] = defaultdict(int)
        author_real_samples: dict[str, int] = defaultdict(int)
        author_proxy_samples: dict[str, int] = defaultdict(int)

        for commit in self.repo.iter_commits(max_count=_AUTHOR_MAX_COMMITS):
            author = commit.author.name or "unknown"
            author_commits[author] += 1
            churn = sum(
                v.get("insertions", 0) + v.get("deletions", 0)
                for v in commit.stats.files.values()
            )

            proxy_score = min(churn / 500, 1.0)
            author_proxy_scores[author].append(proxy_score)

            if not _AUTHOR_FULL:
                author_scores[author].append(proxy_score)
                author_proxy_samples[author] += 1
                continue

            baseline_commits = list(
                self.repo.iter_commits(
                    rev=commit.hexsha,
                    max_count=_AUTHOR_BASELINE_COMMITS + 1,
                )
            )[1:]
            py_files = [f for f in commit.stats.files if _is_analyzable_file(f)]

            file_scores: list[float] = []
            for filepath in py_files[:_AUTHOR_MAX_FILES_PER_COMMIT]:
                src_now = self._source_at_commit(commit, filepath)
                src_base = self._baseline_source_from_window(
                    filepath=filepath,
                    commits=baseline_commits,
                    max_versions=8,
                    target_commit=commit,
                )
                if src_now and src_base:
                    analysis = analyze_sources(src_now, src_base, filepath=filepath)
                    file_scores.append(analysis["risk_score"])

            if file_scores:
                author_scores[author].append(statistics.mean(file_scores))
                author_real_samples[author] += 1
            else:
                author_scores[author].append(proxy_score)
                author_proxy_samples[author] += 1

        analysis_mode = "full" if _AUTHOR_FULL else "proxy"
        return sorted(
            [
                {
                    "author": author,
                    "commit_count": author_commits[author],
                    "avg_risk": round(statistics.mean(scores), 4),
                    "avg_risk_proxy": round(statistics.mean(author_proxy_scores[author]), 4),
                    "analysis_mode": analysis_mode,
                    "real_sample_count": author_real_samples[author],
                    "proxy_sample_count": author_proxy_samples[author],
                }
                for author, scores in author_scores.items()
            ],
            key=lambda x: x["avg_risk"],
            reverse=True,
        )

    # ------------------------------------------------------------------
    # Hotspot data
    # ------------------------------------------------------------------

    def hotspot_data(self) -> list[dict[str, Any]]:
        """Return files ranked by churn * complexity (hotspot score)."""
        file_churn: dict[str, int] = defaultdict(int)
        head = self.repo.head.commit

        for commit in self.repo.iter_commits(max_count=100):
            for filepath, stats in commit.stats.files.items():
                if _is_analyzable_file(filepath):
                    file_churn[filepath] += (
                        stats.get("insertions", 0) + stats.get("deletions", 0)
                    )

        hotspots: list[dict[str, Any]] = []
        for filepath, churn in file_churn.items():
            src = self._source_at_commit(head, filepath)
            if not src:
                continue
            snapshot = _parser.parse(src)
            cc = snapshot.get("cyclomatic_avg", 0.0)
            loc = snapshot.get("loc", {}).get("code", 0)
            hotspot_score = round(
                (min(churn / 1000, 1.0) + min(cc / 10, 1.0)) / 2, 4
            )
            hotspots.append({
                "file": filepath,
                "churn": churn,
                "cyclomatic_avg": round(cc, 2),
                "loc": loc,
                "hotspot_score": hotspot_score,
            })

        hotspots.sort(key=lambda x: x["hotspot_score"], reverse=True)
        return hotspots[:_HOTSPOT_TOP_N]

    # ------------------------------------------------------------------
    # PR risk report
    # ------------------------------------------------------------------

    def pr_risk_report(
        self,
        base_ref: str,
        head_ref: str = "HEAD",
        baseline_n: int = 50,
        max_commits: int = 40,
    ) -> dict[str, Any]:
        """Return an initial PR-level risk report for commit range base..head."""
        range_expr = f"{base_ref}..{head_ref}"
        commits = list(self.repo.iter_commits(range_expr, max_count=max_commits))
        commits = list(reversed(commits))  # oldest → newest for readability

        if not commits:
            return {
                "base_ref": base_ref,
                "head_ref": head_ref,
                "commit_count": 0,
                "avg_risk": 0.0,
                "max_risk": 0.0,
                "high_risk_commits": 0,
                "commits": [],
                "top_risky_files": [],
                "cache": self.cache_stats(),
            }

        commit_entries: list[dict[str, Any]] = []
        file_scores: dict[str, list[float]] = defaultdict(list)
        file_breakdown_series: dict[str, dict[str, list[float]]] = defaultdict(
            lambda: defaultdict(list)
        )
        file_churn_totals: dict[str, int] = defaultdict(int)
        file_authors: dict[str, Counter] = defaultdict(Counter)
        file_complexities: dict[str, list[float]] = defaultdict(list)
        file_agent_evidence: dict[str, dict[str, list[str]]] = defaultdict(
            lambda: defaultdict(list)
        )
        security_findings: list[dict[str, Any]] = []

        for commit in commits:
            res = self.analyze_commit(commit_sha=commit.hexsha, baseline_n=baseline_n)
            score = float(res.get("final_risk_score", 0.0))
            info = res.get("commit", {})
            commit_churn_map = info.get("file_churn_map", {})

            commit_entries.append({
                "sha": info.get("sha", commit.hexsha[:8]),
                "date": info.get("date", commit.committed_datetime.isoformat()),
                "author": info.get("author", "unknown"),
                "message": info.get("message", ""),
                "risk_score": round(score, 4),
                "risk_level": _score_to_level(score),
                "evolution_score": float(res.get("evolution_score", 0.0)),
                "evolution_details": res.get("evolution_details", {}),
                "files_analyzed": int(res.get("files_analyzed", 0)),
                "evolution_evidence": res.get("evolution_evidence", []),
            })

            # file_results is now a list format
            for file_res in res.get("file_results", []):
                filepath = file_res.get("file", "")
                if not filepath:
                    continue
                risk_score = float(file_res.get("risk_score", 0.0))
                file_scores[filepath].append(risk_score)

                bd = file_res.get("breakdown", {})
                for key in ("style", "structural", "semantic", "duplication", "security"):
                    file_breakdown_series[filepath][key].append(float(bd.get(key, 0.0)))

                file_churn_totals[filepath] += int(commit_churn_map.get(filepath, 0))
                file_authors[filepath][info.get("author", "unknown")] += 1

                src_now = self._source_at_commit(commit, filepath)
                if src_now:
                    snap = _parser.parse(src_now)
                    cc = snap.get("cyclomatic_avg")
                    if isinstance(cc, (int, float)):
                        file_complexities[filepath].append(float(cc))

                # Collect security findings for the report
                for agent_name, adetails in file_res.get("agent_details", {}).items():
                    lowered = agent_name.lower()

                    if lowered.startswith("structural"):
                        for ev in adetails.get("evidence", [])[:3]:
                            if ev and ev not in file_agent_evidence[filepath]["structural"]:
                                file_agent_evidence[filepath]["structural"].append(ev)

                    if lowered.startswith("semantic"):
                        for ev in adetails.get("evidence", [])[:3]:
                            if ev and ev not in file_agent_evidence[filepath]["semantic"]:
                                file_agent_evidence[filepath]["semantic"].append(ev)

                    if "security" in agent_name.lower() and adetails.get("score", 0) > 0:
                        for ev in adetails.get("evidence", []):
                            if ev != "No security issues detected.":
                                security_findings.append({
                                    "filepath": filepath,
                                    "commit_sha": info.get("sha", commit.hexsha[:8]),
                                    "author": info.get("author", "unknown"),
                                    "evidence": ev,
                                })

        scores = [c["risk_score"] for c in commit_entries]

        file_rows: list[dict[str, Any]] = []
        for filepath, vals in file_scores.items():
            owner_counter = file_authors.get(filepath, Counter())
            owner = owner_counter.most_common(1)[0][0] if owner_counter else "unknown"
            owner_share = (
                owner_counter.most_common(1)[0][1] / max(sum(owner_counter.values()), 1)
                if owner_counter else 0.0
            )

            complexity_avg = (
                statistics.mean(file_complexities[filepath])
                if file_complexities.get(filepath) else 0.0
            )

            breakdown_avg = {
                key: round(statistics.mean(vals_by_key), 4) if vals_by_key else 0.0
                for key, vals_by_key in file_breakdown_series.get(filepath, {}).items()
            }
            for key in ("style", "structural", "semantic", "duplication", "security"):
                breakdown_avg.setdefault(key, 0.0)

            churn_lines = int(file_churn_totals.get(filepath, 0))
            hotspot_impact = round(
                (min(churn_lines / 1000, 1.0) + min(complexity_avg / 10, 1.0)) / 2,
                4,
            )

            file_rows.append({
                "file": filepath,
                "avg_risk": round(statistics.mean(vals), 4),
                "max_risk": round(max(vals), 4),
                "hits": len(vals),
                "churn_lines": churn_lines,
                "complexity": round(complexity_avg, 3),
                "owner": owner,
                "owner_share": round(owner_share, 4),
                "hotspot_impact": hotspot_impact,
                "risk_breakdown": breakdown_avg,
            })

        file_rows.sort(
            key=lambda x: (x["avg_risk"], x["max_risk"], x["hits"]),
            reverse=True,
        )
        if file_rows:
            total_files = len(file_rows)
            for idx, item in enumerate(file_rows):
                item["risk_percentile"] = round((total_files - idx) / total_files, 4)
                item["rank_in_pr"] = idx + 1
                item["total_pr_files"] = total_files

                effort_center = (
                    3.0
                    + min(item.get("churn_lines", 0) / 120.0, 8.0)
                    + min(item.get("complexity", 0.0) / 2.5, 6.0)
                    + min(item.get("avg_risk", 0.0) * 6.0, 6.0)
                )
                effort_min = max(3, int(round(effort_center - 2)))
                effort_max = max(effort_min + 1, int(round(effort_center + 2)))
                item["review_effort_min"] = effort_min
                item["review_effort_max"] = effort_max

        top_risky_files = file_rows[:20]

        evolution_scores = [float(c.get("evolution_score", 0.0)) for c in commit_entries]
        all_file_breakdowns: dict[str, list[float]] = defaultdict(list)
        for row in file_rows:
            for key, value in row.get("risk_breakdown", {}).items():
                all_file_breakdowns[key].append(float(value))

        composition_avg = {
            key: round(statistics.mean(vals), 4) if vals else 0.0
            for key, vals in all_file_breakdowns.items()
        }
        for key in ("style", "structural", "semantic", "duplication", "security"):
            composition_avg.setdefault(key, 0.0)
        composition_avg["evolution"] = (
            round(statistics.mean(evolution_scores), 4) if evolution_scores else 0.0
        )

        weights_used = getattr(_risk, "weights", {"style": 0.28, "structural": 0.39, "semantic": 0.33})
        duplication_boost_avg = (
            0.05 * min(composition_avg["duplication"] / 0.30, 1.0)
            if composition_avg["duplication"] > 0.05
            else 0.0
        )
        security_boost_avg = composition_avg["security"] * 0.50
        contribution_raw = {
            "style": 0.90 * weights_used.get("style", 0.28) * composition_avg["style"],
            "structural": 0.90 * weights_used.get("structural", 0.39) * composition_avg["structural"],
            "semantic": 0.90 * weights_used.get("semantic", 0.33) * composition_avg["semantic"],
            "duplication": 0.90 * duplication_boost_avg,
            "security": 0.90 * security_boost_avg,
            "evolution": 0.10 * composition_avg["evolution"],
        }
        total_contribution = sum(contribution_raw.values()) or 1.0
        contribution_pct = {
            key: round(value / total_contribution, 4)
            for key, value in contribution_raw.items()
        }

        commit_trend: list[dict[str, Any]] = []
        prev_score: float | None = None
        for entry in commit_entries:
            current = float(entry.get("risk_score", 0.0))
            delta = None if prev_score is None else (current - prev_score)
            delta_pct = None
            if prev_score is not None and prev_score > 0:
                delta_pct = delta / prev_score
            commit_trend.append({
                "sha": entry.get("sha", ""),
                "date": entry.get("date", ""),
                "risk_score": round(current, 4),
                "delta": round(delta, 4) if delta is not None else None,
                "delta_pct": round(delta_pct, 4) if delta_pct is not None else None,
            })
            prev_score = current

        evidence_summary: list[dict[str, Any]] = []
        evolution_details = [
            c.get("evolution_details", {}) for c in commit_entries
            if isinstance(c.get("evolution_details", {}), dict)
        ]
        if evolution_details:
            churn_base_vals = [float(d.get("avg_churn_base", 0.0)) for d in evolution_details]
            churn_now_vals = [float(d.get("avg_churn_now", 0.0)) for d in evolution_details]
            if churn_base_vals and churn_now_vals:
                churn_base = statistics.mean(churn_base_vals)
                churn_now = statistics.mean(churn_now_vals)
                churn_delta = churn_now - churn_base
                churn_delta_pct = (churn_delta / churn_base) if churn_base > 0 else None
                evidence_summary.append({
                    "type": "churn_anomaly",
                    "baseline": round(churn_base, 2),
                    "current": round(churn_now, 2),
                    "delta": round(churn_delta, 2),
                    "delta_pct": round(churn_delta_pct, 4) if churn_delta_pct is not None else None,
                    "text": (
                        f"Code churn: baseline {churn_base:.0f} → current {churn_now:.0f} "
                        f"lines/commit (Δ{churn_delta:+.0f})"
                    ),
                })

            hotspot_vals = [float(d.get("hotspot_score", 0.0)) for d in evolution_details]
            if hotspot_vals:
                hotspot_avg = statistics.mean(hotspot_vals)
                evidence_summary.append({
                    "type": "hotspot_impact",
                    "current": round(hotspot_avg, 4),
                    "text": f"Hotspot impact: {hotspot_avg:.1%} of touched files",
                })

            bus_vals = [float(d.get("bus_factor_score", 0.0)) for d in evolution_details]
            if bus_vals:
                bus_avg = statistics.mean(bus_vals)
                if bus_avg > 0.0:
                    evidence_summary.append({
                        "type": "knowledge_concentration",
                        "current": round(bus_avg, 4),
                        "text": f"Knowledge concentration (bus-factor risk): {bus_avg:.1%}",
                    })

        # Build code snippets for the top risky files (for LLM review)
        code_snippets: list[dict[str, Any]] = []
        head_commit = commits[-1] if commits else None
        if head_commit and top_risky_files:
            from src.llm_ready_snippets import prepare_code_for_llm
            for item in top_risky_files[:_LLM_REVIEW_TOP]:
                src = self._source_at_commit(head_commit, item["file"])
                if src:
                    code_snippets.append(
                        prepare_code_for_llm(src, filepath=item["file"])
                    )

        snippet_map = {s.get("filepath", ""): s for s in code_snippets}

        def _snippet_around_line(source: str, line_no: int, context: int = 4) -> str:
            lines = source.splitlines()
            if line_no < 1 or line_no > len(lines):
                return ""
            start = max(1, line_no - context)
            end = min(len(lines), line_no + context)
            return "\n".join(
                f"{idx:>4}: {lines[idx - 1]}"
                for idx in range(start, end + 1)
            )

        def _primary_region(lines: list[int]) -> str:
            if not lines:
                return ""
            window = sorted(lines[:5])
            start = window[0]
            end = window[-1]
            return f"L{start}" if start == end else f"L{start}-L{end}"

        deep_dive: list[dict[str, Any]] = []
        for item in top_risky_files[:3]:
            filepath = item["file"]
            source = self._source_at_commit(head_commit, filepath) if head_commit else ""
            code_meta = snippet_map.get(filepath, {})
            risky_lines = sorted(
                {
                    int(s.get("location"))
                    for s in code_meta.get("risky_snippets", [])
                    if isinstance(s.get("location"), int)
                }
            )

            snippet_text = ""
            if source and risky_lines:
                snippet_text = _snippet_around_line(source, risky_lines[0])

            diff_excerpt = ""
            try:
                diff_text = self.repo.git.diff(base_ref, head_ref, "--", filepath, unified=3)
                if diff_text:
                    diff_excerpt = "\n".join(diff_text.splitlines()[:80])
            except Exception:
                diff_excerpt = ""

            structural_signals = list(file_agent_evidence.get(filepath, {}).get("structural", []))
            semantic_signals = list(file_agent_evidence.get(filepath, {}).get("semantic", []))

            imports = code_meta.get("imports", [])
            functions = code_meta.get("functions", [])
            classes = code_meta.get("classes", [])
            risky_snippets = code_meta.get("risky_snippets", [])

            if imports and len(imports) >= 5:
                msg = f"{len(imports)} imports detected (dependency surface expanded)."
                if msg not in structural_signals:
                    structural_signals.append(msg)
            if classes:
                msg = f"{len(classes)} class definition(s) touched in this file."
                if msg not in structural_signals:
                    structural_signals.append(msg)

            complex_funcs = [f for f in functions if f.get("complexity") in {"moderate", "complex"}]
            if complex_funcs:
                msg = f"{len(complex_funcs)} function(s) marked moderate/complex."
                if msg not in structural_signals:
                    structural_signals.append(msg)

            risky_reasons = [s.get("reason") for s in risky_snippets if s.get("reason")]
            for reason in risky_reasons[:3]:
                if reason not in semantic_signals:
                    semantic_signals.append(reason)

            primary_region = _primary_region(risky_lines)
            effort_min = int(item.get("review_effort_min", 3))
            effort_max = int(item.get("review_effort_max", max(effort_min + 1, 4)))

            deep_dive.append({
                "file": filepath,
                "risk": item.get("avg_risk", 0.0),
                "rank_in_pr": item.get("rank_in_pr", 1),
                "total_pr_files": item.get("total_pr_files", len(file_rows) or 1),
                "risk_breakdown": item.get("risk_breakdown", {}),
                "risky_lines": risky_lines,
                "primary_risk_region": primary_region,
                "estimated_review_effort": f"{effort_min}-{effort_max} minutes",
                "structural_signals": structural_signals[:5],
                "semantic_signals": semantic_signals[:5],
                "code_excerpt": snippet_text,
                "diff_excerpt": diff_excerpt,
            })

        return {
            "base_ref": base_ref,
            "head_ref": head_ref,
            "commit_count": len(commit_entries),
            "avg_risk": round(statistics.mean(scores), 4),
            "max_risk": round(max(scores), 4),
            "high_risk_commits": sum(1 for s in scores if s >= 0.75),
            "commits": commit_entries,
            "commit_trend": commit_trend,
            "risk_composition": {
                "formula": "commit_risk = 0.90*mean(file_risk) + 0.10*evolution",
                "file_formula": "file_risk = 0.28*style + 0.39*structural + 0.33*semantic + duplication/security adjustments",
                "components_avg": composition_avg,
                "contributions_pct": contribution_pct,
                "percentile_basis": "within_pr_files",
                "scale_max": 1.0,
            },
            "evidence_summary": evidence_summary,
            "top_risky_files": top_risky_files,
            "file_deep_dive": deep_dive,
            "security_findings": security_findings,
            "code_snippets": code_snippets,
            "cache": self.cache_stats(),
        }

# end of pipeline.py
