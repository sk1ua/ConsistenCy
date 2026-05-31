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
from .collaboration import build_file_consensus
from .models import score_to_risk_colour, score_to_risk_label
from .scoring import (
    build_confidence,
    build_explainability_block,
    dominant_signals,
    file_contributions,
    normalize_signal_results,
)

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
    except (KeyError, AttributeError, ValueError, TypeError):  # noqa: BLE001
        # gitpython can raise ValueError when stats can't be computed
        # (e.g., binary files, empty commits).  We return defaults.
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


_score_to_level = score_to_risk_label  # canonical, imported from models


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
    agent_details = {
        name: {
            "score": round(r.score, 4),
            "evidence": r.evidence,
            "elapsed_ms": round(r.elapsed_ms, 2),
        }
        for name, r in results.items()
    }
    signal_results = {
        name: signal.to_dict()
        for name, signal in normalize_signal_results(agent_details).items()
    }
    breakdown = final.details.get("breakdown", {})
    non_zero_signals = sum(
        1 for value in breakdown.values()
        if isinstance(value, (int, float)) and float(value) > 0.05
    )
    signal_agreement = min(non_zero_signals / 3.0, 1.0)
    evidence_by_signal = {
        name: signal.get("evidence", [])
        for name, signal in signal_results.items()
    }
    confidence = build_confidence(
        baseline_versions=int((aggregated_baseline or {}).get("sample_count", 1)),
        signal_agreement=signal_agreement,
        history_depth=int((aggregated_baseline or {}).get("history_depth", 1)),
    )
    agent_collaboration = build_file_consensus(
        agent_details,
        breakdown,
        confidence=confidence,
        filepath=filepath,
    )

    return {
        "risk_score": round(final.score, 4),
        "risk_level": final.details.get("risk_level", ""),
        "risk_colour": final.details.get("risk_colour", ""),
        "breakdown": breakdown,
        "signal_results": signal_results,
        "signal_composition": file_contributions(breakdown),
        "dominant_signals": dominant_signals(file_contributions(breakdown)),
        "confidence": confidence,
        "explainability": build_explainability_block(
            breakdown,
            evidence_by_signal,
            confidence=confidence,
        ),
        "agent_collaboration": agent_collaboration,
        "evidence": final.evidence,
        "agent_details": agent_details,
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
        # _collect_versions returns newest→oldest; aggregate expects oldest→newest
        return self._aggregate_baseline_snapshot(list(reversed(versions)))

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
                "signal_results": analysis.get("signal_results", {}),
                "signal_composition": analysis.get("signal_composition", {}),
                "dominant_signals": analysis.get("dominant_signals", []),
                "confidence": analysis.get("confidence", 0.0),
                "explainability": analysis.get("explainability", {}),
                "agent_collaboration": analysis.get("agent_collaboration", {}),
                "evidence": analysis.get("evidence", []),
                "agent_details": analysis.get("agent_details", {}),
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
        """Return an initial PR-level risk report for commit range base..head.

        Delegates to PRReportBuilder for the actual report construction.
        """
        from .pr_report_builder import PRReportBuilder
        builder = PRReportBuilder(self)
        return builder.build(
            base_ref=base_ref,
            head_ref=head_ref,
            baseline_n=baseline_n,
            max_commits=max_commits,
        )

# end of pipeline.py
