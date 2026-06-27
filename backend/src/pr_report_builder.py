# -*- coding: utf-8 -*-
"""
PR Report Builder
=================
Constructs the PR-level risk report from per-commit analysis results.

Extracted from AnalysisPipeline to keep the pipeline class focused on
analysis orchestration and caching.
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .pipeline import AnalysisPipeline

from .agents import ParserAgent
from .collaboration import aggregate_file_consensus, build_pr_consensus
from .scoring import (
    build_explainability_block,
    dominant_signals,
    file_contributions,
)
from .scoring.composer import DEFAULT_FILE_WEIGHTS
from .models import score_to_risk_label as _score_to_level
from .retrieval import build_retrieval_section

_parser = ParserAgent()
_LLM_REVIEW_TOP = 5
_RETRIEVAL_CONTEXT_BUDGET_TOKENS = 2000


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


class PRReportBuilder:
    """Build a PR risk report from a pipeline's analysis results.

    Parameters
    ----------
    pipeline : AnalysisPipeline
        The pipeline instance providing source access and cache stats.
    llm_review_top : int
        Max number of top risky files to include code snippets for (LLM).
    """

    def __init__(
        self,
        pipeline: AnalysisPipeline,
        llm_review_top: int = _LLM_REVIEW_TOP,
    ) -> None:
        self._pipeline = pipeline
        self._llm_review_top = llm_review_top

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def build(
        self,
        base_ref: str,
        head_ref: str = "HEAD",
        baseline_n: int = 50,
        max_commits: int = 40,
    ) -> dict[str, Any]:
        """Build a full PR-level risk report for base_ref..head_ref."""
        pipeline = self._pipeline
        range_expr = f"{base_ref}..{head_ref}"
        commits = list(pipeline.repo.iter_commits(range_expr, max_count=max_commits))
        commits = list(reversed(commits))  # oldest → newest for readability

        if not commits:
            return self._empty_report(base_ref, head_ref)

        # Collect per-commit data
        commit_entries, file_data, security_findings = self._collect_commit_data(
            commits, baseline_n,
        )

        # Build file rows with ranking
        file_rows = self._build_file_rows(file_data)
        top_risky_files = file_rows[:20]

        # Composition & contributions
        risk_composition = self._build_risk_composition(commit_entries, file_rows)

        # Evidence summary from evolution data
        evidence_summary = self._build_evidence_summary(commit_entries)

        # Code snippets for LLM
        code_snippets = self._build_code_snippets(commits, top_risky_files)
        snippet_map = {s.get("filepath", ""): s for s in code_snippets}

        # Deep dive
        deep_dive = self._build_deep_dive(
            base_ref, head_ref, commits, top_risky_files,
            file_data, snippet_map, file_rows,
        )
        retrieval = self._build_retrieval(
            deep_dive,
            security_findings=security_findings,
            evidence_summary=evidence_summary,
        )
        self._attach_retrieval_to_top_files(top_risky_files, retrieval)

        # Agent consensus / handoff planner consumes evidence-pack summaries
        agent_collaboration = build_pr_consensus(
            top_risky_files,
            commit_entries=commit_entries,
            security_findings=security_findings,
        )

        # Commit trend
        commit_trend = self._build_commit_trend(commit_entries)

        scores = [c["risk_score"] for c in commit_entries]

        return {
            "base_ref": base_ref,
            "head_ref": head_ref,
            "commit_count": len(commit_entries),
            "avg_risk": round(statistics.mean(scores), 4),
            "max_risk": round(max(scores), 4),
            "high_risk_commits": sum(1 for s in scores if s >= 0.75),
            "commits": commit_entries,
            "commit_trend": commit_trend,
            "risk_composition": risk_composition,
            "evidence_summary": evidence_summary,
            "top_risky_files": top_risky_files,
            "file_deep_dive": deep_dive,
            "retrieval": retrieval,
            "security_findings": security_findings,
            "agent_collaboration": agent_collaboration,
            "code_snippets": code_snippets,
            "cache": pipeline.cache_stats(),
        }

    # ------------------------------------------------------------------
    # Internal builders
    # ------------------------------------------------------------------

    def _empty_report(self, base_ref: str, head_ref: str) -> dict[str, Any]:
        return {
            "base_ref": base_ref,
            "head_ref": head_ref,
            "commit_count": 0,
            "avg_risk": 0.0,
            "max_risk": 0.0,
            "high_risk_commits": 0,
            "commits": [],
            "top_risky_files": [],
            "risk_composition": {
                "formula": "R_pr = h({R_c}, {R_f})",
                "file_formula": "R_f = g(S_style, S_struct, S_sem, S_dup, S_sec)",
                "components_avg": {},
                "contributions_pct": {},
                "percentile_basis": "within_pr_files",
                "scale_max": 1.0,
            },
            "evidence_summary": [],
            "commit_trend": [],
            "file_deep_dive": [],
            "retrieval": self._empty_retrieval(),
            "security_findings": [],
            "agent_collaboration": build_pr_consensus([]),
            "code_snippets": [],
            "cache": self._pipeline.cache_stats(),
        }

    def _collect_commit_data(
        self, commits: list, baseline_n: int,
    ) -> tuple[list[dict], dict, list[dict]]:
        """Iterate commits, run analysis, and accumulate file-level data."""
        pipeline = self._pipeline

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
        file_confidences: dict[str, list[float]] = defaultdict(list)
        file_collaborations: dict[str, list[dict[str, Any]]] = defaultdict(list)
        security_findings: list[dict[str, Any]] = []

        for commit in commits:
            res = pipeline.analyze_commit(commit_sha=commit.hexsha, baseline_n=baseline_n)
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

            for file_res in res.get("file_results", []):
                filepath = file_res.get("file", "")
                if not filepath:
                    continue
                if file_res.get("agent_collaboration"):
                    file_collaborations[filepath].append(file_res["agent_collaboration"])
                risk_score = float(file_res.get("risk_score", 0.0))
                file_scores[filepath].append(risk_score)

                bd = file_res.get("breakdown", {})
                for key in ("style", "structural", "semantic", "duplication", "security"):
                    file_breakdown_series[filepath][key].append(float(bd.get(key, 0.0)))
                file_confidences[filepath].append(float(file_res.get("confidence", 0.0)))

                for signal_name, signal in file_res.get("signal_results", {}).items():
                    for ev in signal.get("evidence", [])[:3]:
                        if ev and ev not in file_agent_evidence[filepath][signal_name]:
                            file_agent_evidence[filepath][signal_name].append(ev)

                file_churn_totals[filepath] += int(commit_churn_map.get(filepath, 0))
                file_authors[filepath][info.get("author", "unknown")] += 1

                src_now = pipeline._source_at_commit(commit, filepath)
                if src_now:
                    snap = _parser.parse(src_now)
                    cc = snap.get("cyclomatic_avg")
                    if isinstance(cc, (int, float)):
                        file_complexities[filepath].append(float(cc))

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

        file_data = {
            "file_scores": file_scores,
            "file_breakdown_series": file_breakdown_series,
            "file_churn_totals": file_churn_totals,
            "file_authors": file_authors,
            "file_complexities": file_complexities,
            "file_agent_evidence": file_agent_evidence,
            "file_confidences": file_confidences,
            "file_collaborations": file_collaborations,
        }
        return commit_entries, file_data, security_findings

    @staticmethod
    def _build_file_rows(file_data: dict) -> list[dict[str, Any]]:
        """Convert raw file data into ranked file rows."""
        file_rows: list[dict[str, Any]] = []

        for filepath, vals in file_data["file_scores"].items():
            owner_counter = file_data["file_authors"].get(filepath, Counter())
            owner = owner_counter.most_common(1)[0][0] if owner_counter else "unknown"
            owner_share = (
                owner_counter.most_common(1)[0][1] / max(sum(owner_counter.values()), 1)
                if owner_counter else 0.0
            )

            complexities = file_data["file_complexities"]
            complexity_avg = (
                statistics.mean(complexities[filepath])
                if complexities.get(filepath) else 0.0
            )

            breakdown_series = file_data["file_breakdown_series"]
            breakdown_avg = {
                key: round(statistics.mean(vals_by_key), 4) if vals_by_key else 0.0
                for key, vals_by_key in breakdown_series.get(filepath, {}).items()
            }
            for key in ("style", "structural", "semantic", "duplication", "security"):
                breakdown_avg.setdefault(key, 0.0)

            churn_lines = int(file_data["file_churn_totals"].get(filepath, 0))
            confidences = file_data["file_confidences"]
            confidence = (
                statistics.mean(confidences[filepath])
                if confidences.get(filepath) else 0.0
            )
            hotspot_impact = round(
                (min(churn_lines / 1000, 1.0) + min(complexity_avg / 10, 1.0)) / 2,
                4,
            )
            signal_contrib = file_contributions(breakdown_avg)
            collabs = file_data["file_collaborations"]
            agent_collaboration = aggregate_file_consensus(
                collabs.get(filepath, []),
                filepath=filepath,
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
                "signal_composition": signal_contrib,
                "dominant_signals": dominant_signals(signal_contrib),
                "confidence": round(confidence, 4),
                "explainability": build_explainability_block(
                    breakdown_avg,
                    file_data["file_agent_evidence"].get(filepath, {}),
                    confidence=confidence,
                ),
                "agent_collaboration": agent_collaboration,
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

        return file_rows

    @staticmethod
    def _build_risk_composition(
        commit_entries: list[dict],
        file_rows: list[dict],
    ) -> dict[str, Any]:
        """Build risk composition summary with contribution percentages."""
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

        weights_used = dict(DEFAULT_FILE_WEIGHTS)
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

        return {
            "formula": "R_c = 0.90*Agg_f(R_f) + 0.10*S_evo; R_pr = h({R_c}, {R_f})",
            "file_formula": "R_f = g(S_style, S_struct, S_sem, S_dup, S_sec)",
            "components_avg": composition_avg,
            "contributions_pct": contribution_pct,
            "percentile_basis": "within_pr_files",
            "scale_max": 1.0,
            "confidence_formula": "C_f = q(baseline_sufficiency, signal_agreement, history_depth)",
        }

    @staticmethod
    def _build_evidence_summary(commit_entries: list[dict]) -> list[dict[str, Any]]:
        """Derive evidence summary from evolution details across commits."""
        evidence_summary: list[dict[str, Any]] = []
        evolution_details = [
            c.get("evolution_details", {}) for c in commit_entries
            if isinstance(c.get("evolution_details", {}), dict)
        ]
        if not evolution_details:
            return evidence_summary

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

        return evidence_summary

    @staticmethod
    def _empty_retrieval() -> dict[str, Any]:
        return {
            "strategy": "hybrid_path_symbol_signal_callsite_ownership_local_similarity",
            "context_budget_tokens": _RETRIEVAL_CONTEXT_BUDGET_TOKENS,
            "packs": [],
            "summary": {
                "files_with_evidence": 0,
                "total_selected_evidence": 0,
                "average_selected_evidence_count": 0.0,
                "average_compression_ratio": 0.0,
            },
        }

    def _build_retrieval(
        self,
        deep_dive: list[dict[str, Any]],
        *,
        security_findings: list[dict[str, Any]],
        evidence_summary: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Build evidence packs without making report generation fragile."""
        try:
            return build_retrieval_section(
                deep_dive,
                security_findings=security_findings,
                evidence_summary=evidence_summary,
                context_budget_tokens=_RETRIEVAL_CONTEXT_BUDGET_TOKENS,
            )
        except Exception as exc:  # noqa: BLE001
            fallback = self._empty_retrieval()
            fallback["summary"]["error"] = f"retrieval_unavailable: {exc}"
            return fallback

    @staticmethod
    def _attach_retrieval_to_top_files(
        top_risky_files: list[dict[str, Any]],
        retrieval: dict[str, Any],
    ) -> None:
        packs_by_file = {
            pack.get("file"): pack
            for pack in retrieval.get("packs", [])
            if isinstance(pack, dict)
        }
        for item in top_risky_files:
            pack = packs_by_file.get(item.get("file"))
            if pack:
                item["evidence_pack"] = pack

    def _build_code_snippets(
        self,
        commits: list,
        top_risky_files: list[dict],
    ) -> list[dict[str, Any]]:
        """Extract LLM-ready code snippets for top risky files."""
        from src.llm_ready_snippets import prepare_code_for_llm

        code_snippets: list[dict[str, Any]] = []
        head_commit = commits[-1] if commits else None
        if not head_commit or not top_risky_files:
            return code_snippets

        for item in top_risky_files[: self._llm_review_top]:
            src = self._pipeline._source_at_commit(head_commit, item["file"])
            if src:
                code_snippets.append(prepare_code_for_llm(src, filepath=item["file"]))
        return code_snippets

    def _find_cross_file_callsites(
        self,
        head_commit: Any,
        filepath: str,
        symbols: list[str],
        *,
        max_files: int = 40,
        max_hints: int = 6,
    ) -> list[dict[str, Any]]:
        """Find lightweight cross-file references for changed symbols."""
        if not head_commit or not symbols:
            return []
        supported_suffixes = (".py", ".js", ".jsx", ".ts", ".tsx")
        hints: list[dict[str, Any]] = []
        seen: set[tuple[str, str, int]] = set()

        for blob in head_commit.tree.traverse():
            other_path = getattr(blob, "path", "")
            if (
                not other_path
                or other_path == filepath
                or not other_path.lower().endswith(supported_suffixes)
            ):
                continue
            if len(hints) >= max_hints:
                break
            if max_files <= 0:
                break
            max_files -= 1
            source = self._pipeline._source_at_commit(head_commit, other_path)
            if not source:
                continue
            lines = source.splitlines()
            for symbol in symbols:
                if len(symbol) < 3 or symbol not in source:
                    continue
                for line_no, line in enumerate(lines, start=1):
                    if symbol not in line:
                        continue
                    key = (other_path, symbol, line_no)
                    if key in seen:
                        continue
                    seen.add(key)
                    hints.append(
                        {
                            "file": other_path,
                            "line": line_no,
                            "symbol": symbol,
                            "content": (
                                f"`{symbol}` is referenced by `{other_path}` "
                                f"at line {line_no}: {line.strip()[:180]}"
                            ),
                        }
                    )
                    break
                if len(hints) >= max_hints:
                    break
        return hints

    @staticmethod
    def _ownership_hints(item: dict[str, Any]) -> list[str]:
        hints: list[str] = []
        owner = item.get("owner", "unknown")
        owner_share = float(item.get("owner_share", 0.0) or 0.0)
        churn = int(item.get("churn_lines", 0) or 0)
        hotspot = float(item.get("hotspot_impact", 0.0) or 0.0)
        if owner != "unknown":
            hints.append(f"Primary owner `{owner}` accounts for {owner_share:.0%} of recent touches.")
        if churn > 0:
            hints.append(f"Historical churn for this file is {churn} changed lines across the PR window.")
        if hotspot > 0:
            hints.append(f"Hotspot impact score is {hotspot:.2f}, combining churn and complexity.")
        return hints

    def _build_deep_dive(
        self,
        base_ref: str,
        head_ref: str,
        commits: list,
        top_risky_files: list[dict],
        file_data: dict,
        snippet_map: dict[str, dict],
        file_rows: list[dict],
    ) -> list[dict[str, Any]]:
        """Build deep-dive analysis for the top 3 riskiest files."""
        pipeline = self._pipeline
        head_commit = commits[-1] if commits else None
        deep_dive: list[dict[str, Any]] = []

        for item in top_risky_files[:3]:
            filepath = item["file"]
            source = pipeline._source_at_commit(head_commit, filepath) if head_commit else ""
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
                diff_text = pipeline.repo.git.diff(base_ref, head_ref, "--", filepath, unified=3)
                if diff_text:
                    diff_excerpt = "\n".join(diff_text.splitlines()[:80])
            except Exception:
                diff_excerpt = ""

            agent_evidence = file_data["file_agent_evidence"].get(filepath, {})
            structural_signals = list(agent_evidence.get("structural", []))
            semantic_signals = list(agent_evidence.get("semantic", []))

            imports = code_meta.get("imports", [])
            functions = code_meta.get("functions", [])
            classes = code_meta.get("classes", [])
            risky_snippets = code_meta.get("risky_snippets", [])
            symbol_names = [
                str(func.get("name", ""))
                for func in functions
                if func.get("name")
            ] + [
                str(cls.get("name", ""))
                for cls in classes
                if cls.get("name")
            ]

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
                "signal_contributions": item.get("signal_composition", {}),
                "dominant_signals": item.get("dominant_signals", []),
                "confidence": item.get("confidence", 0.0),
                "evidence_chain": item.get("explainability", {}).get("evidence_chain", []),
                "risky_lines": risky_lines,
                "primary_risk_region": primary_region,
                "estimated_review_effort": f"{effort_min}-{effort_max} minutes",
                "structural_signals": structural_signals[:5],
                "semantic_signals": semantic_signals[:5],
                "callsite_hints": self._find_cross_file_callsites(
                    head_commit,
                    filepath,
                    symbol_names[:8],
                ) if head_commit else [],
                "ownership_hints": self._ownership_hints(item),
                "code_excerpt": snippet_text,
                "diff_excerpt": diff_excerpt,
            })

        return deep_dive

    @staticmethod
    def _build_commit_trend(commit_entries: list[dict]) -> list[dict[str, Any]]:
        """Compute per-commit risk score deltas."""
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
        return commit_trend
