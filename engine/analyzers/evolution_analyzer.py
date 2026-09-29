# -*- coding: utf-8 -*-
"""
Evolution Agent
===============
Analyses **Git history** to compute software-evolution metrics.
These metrics capture *how a codebase changes over time* rather than
what any single commit looks like.

Metrics produced
----------------
churn_score         : Normalised code churn (lines_added + lines_deleted)
                      relative to project baseline.
entropy_score       : Shannon commit entropy — high entropy means many
                      files touched per commit, low entropy means focused
                      changes.  High entropy relative to baseline = anomaly.
hotspot_score       : Files with both high churn AND high complexity are
                      technical-debt hotspots.  Returns fraction of
                      files classified as hotspots.
ownership_gini      : Gini coefficient of commit counts per author —
                      0 = perfectly spread, 1 = single-author monopoly.
bus_factor_score    : Fraction of files where ≥80 % of commits come from
                      a single author.

Final evolution_anomaly = 0.30·churn_score + 0.30·entropy_score
                         + 0.25·hotspot_score + 0.15·bus_factor_score
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any

from .base_analyzer import AnalyzerBase, AnalyzerResult


# ---------------------------------------------------------------------------
# Shannon entropy helper
# ---------------------------------------------------------------------------

def _shannon_entropy(distribution: list[int]) -> float:
    """H = -Σ p_i · log2(p_i)  for a raw-count distribution."""
    total = sum(distribution)
    if total == 0:
        return 0.0
    return -sum(
        (c / total) * math.log2(c / total)
        for c in distribution if c > 0
    )


# ---------------------------------------------------------------------------
# Gini coefficient
# ---------------------------------------------------------------------------

def _gini(values: list[float]) -> float:
    """Gini coefficient of *values* ∈ [0, 1]."""
    if not values:
        return 0.0
    sorted_v = sorted(values)
    n = len(sorted_v)
    cumsum = sum((i + 1) * v for i, v in enumerate(sorted_v))
    total = sum(sorted_v) or 1e-9
    return (2 * cumsum) / (n * total) - (n + 1) / n


# ---------------------------------------------------------------------------
# Evolution Agent
# ---------------------------------------------------------------------------

class EvolutionAnalyzer(AnalyzerBase):
    """Compute software-evolution anomaly metrics from Git history data.

    Expected snapshot / baseline format
    ------------------------------------
    Both dicts should contain a ``commits`` key: a list of commit dicts,
    each with:
        sha         : str
        author      : str
        files       : list of str  (files touched)
        additions   : int
        deletions   : int
        file_churn_map : dict[filename, churn]  (optional, preferred)
        complexity_map : dict[filename, cyclomatic_complexity]  (optional)
    """

    WEIGHTS = {
        "churn": 0.30,
        "entropy": 0.30,
        "hotspot": 0.25,
        "bus_factor": 0.15,
    }

    @property
    def name(self) -> str:
        return "EvolutionAnalyzer"

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AnalyzerResult:
        commits_now = snapshot.get("commits", [])
        commits_base = baseline.get("commits", [])

        # --- Churn score ---
        churn_now = self._avg_churn(commits_now)
        churn_base = self._avg_churn(commits_base)
        churn_score = self.clamp(
            self.safe_div(abs(churn_now - churn_base), max(churn_base, 1))
        )

        # --- Entropy score ---
        entropy_now = self._avg_entropy(commits_now)
        entropy_base = self._avg_entropy(commits_base)
        # Normalise: max meaningful entropy ≈ log2(total unique files)
        all_files = {f for c in (commits_now + commits_base) for f in c.get("files", [])}
        max_entropy = math.log2(max(len(all_files), 2))
        entropy_score = self.clamp(abs(entropy_now - entropy_base) / max_entropy)

        # --- Hotspot score ---
        hotspot_score = self._hotspot_fraction(commits_now + commits_base)

        # --- Bus factor / ownership Gini ---
        bus_factor_score = self._bus_factor_fraction(commits_now + commits_base)

        # Weighted aggregate
        score = self.clamp(
            self.WEIGHTS["churn"] * churn_score
            + self.WEIGHTS["entropy"] * entropy_score
            + self.WEIGHTS["hotspot"] * hotspot_score
            + self.WEIGHTS["bus_factor"] * bus_factor_score
        )

        evidence: list[str] = []
        if churn_score > 0.3:
            evidence.append(
                f"Code churn anomaly: avg {churn_base:.0f} lines/commit (baseline) "
                f"→ {churn_now:.0f} now (Δ{churn_now - churn_base:+.0f})"
            )
        if entropy_score > 0.3:
            evidence.append(
                f"Commit entropy changed: {entropy_base:.2f} → {entropy_now:.2f} bits "
                f"(wide-spread vs focused changes)"
            )
        if hotspot_score > 0.2:
            evidence.append(
                f"Hotspot files detected (high churn + high complexity): "
                f"{hotspot_score:.0%} of touched files"
            )
        if bus_factor_score > 0.5:
            evidence.append(
                f"Bus-factor risk: {bus_factor_score:.0%} of files owned by a single author"
            )

        return AnalyzerResult(
            analyzer_name=self.name,
            score=score,
            details={
                "churn_score": churn_score,
                "entropy_score": entropy_score,
                "hotspot_score": hotspot_score,
                "bus_factor_score": bus_factor_score,
                "avg_churn_now": churn_now,
                "avg_churn_base": churn_base,
                "avg_entropy_now": entropy_now,
                "avg_entropy_base": entropy_base,
            },
            evidence=evidence,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _avg_churn(commits: list[dict]) -> float:
        if not commits:
            return 0.0
        total = sum(c.get("additions", 0) + c.get("deletions", 0) for c in commits)
        return total / len(commits)

    @staticmethod
    def _avg_entropy(commits: list[dict]) -> float:
        if not commits:
            return 0.0
        entropies = []
        for commit in commits:
            file_churn_map = commit.get("file_churn_map") or {}
            dist = [
                int(churn)
                for churn in file_churn_map.values()
                if isinstance(churn, (int, float)) and churn > 0
            ]

            if not dist:
                # Backward-compatible fallback: derive a coarse distribution
                # from commit-level churn and touched file count.
                files = commit.get("files", [])
                adds = commit.get("additions", 0)
                dels = commit.get("deletions", 0)
                total_churn = adds + dels
                n = len(files)
                if total_churn == 0 or n <= 1:
                    entropies.append(0.0)
                    continue
                base = max(total_churn // n, 1)
                dist = [base] * n
                dist[0] += total_churn - sum(dist)

            entropies.append(_shannon_entropy(dist))
        return sum(entropies) / len(entropies) if entropies else 0.0

    @staticmethod
    def _hotspot_fraction(commits: list[dict]) -> float:
        """Files that are in the top-25% churn AND top-25% complexity."""
        if not commits:
            return 0.0
        file_churn: Counter = Counter()
        file_complexity: dict[str, float] = {}
        for commit in commits:
            file_churn_map = commit.get("file_churn_map") or {}
            if file_churn_map:
                for filename, churn in file_churn_map.items():
                    if isinstance(churn, (int, float)) and churn > 0:
                        file_churn[filename] += churn
            else:
                churn = commit.get("additions", 0) + commit.get("deletions", 0)
                files = commit.get("files", [])
                per_file = churn / len(files) if files else 0
                for filename in files:
                    file_churn[filename] += per_file
            complexity_map = commit.get("complexity_map", {})
            for f, cc in complexity_map.items():
                file_complexity[f] = max(file_complexity.get(f, 0), cc)

        if not file_churn:
            return 0.0
        churn_vals = sorted(file_churn.values())
        q75_churn = churn_vals[int(0.75 * len(churn_vals))]
        cc_vals = sorted(file_complexity.values()) if file_complexity else []

        if not cc_vals:
            # complexity_map not populated — fall back to churn-only hotspot:
            # top-quartile churned files are treated as hotspots
            hotspots = sum(1 for c in file_churn.values() if c >= q75_churn)
            return hotspots / len(file_churn)

        q75_cc = cc_vals[int(0.75 * len(cc_vals))]
        hotspots = sum(
            1 for f, c in file_churn.items()
            if c >= q75_churn and file_complexity.get(f, 0) >= q75_cc
        )
        return hotspots / len(file_churn)

    @staticmethod
    def _bus_factor_fraction(commits: list[dict]) -> float:
        """Fraction of files where one author accounts for ≥80% of commits."""
        if not commits:
            return 0.0
        file_authors: defaultdict[str, Counter] = defaultdict(Counter)
        for commit in commits:
            author = commit.get("author", "unknown")
            for f in commit.get("files", []):
                file_authors[f][author] += 1

        if not file_authors:
            return 0.0
        risky = sum(
            1 for counter in file_authors.values()
            if counter.most_common(1)[0][1] / sum(counter.values()) >= 0.8
        )
        return risky / len(file_authors)
