#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Explainable PR report renderer.

This module renders the dictionary returned by AnalysisPipeline.pr_risk_report()
into a Markdown report for human review. The report is organized as a research
prototype artifact: overall risk, signal composition, risky-file ranking,
evidence chain, file deep dive, review suggestions, and an optional AI narrative.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from src.llm_reviewer import is_llm_available, review_with_llm


from src.models import score_to_risk_label as _risk_label

def _dedupe_text(items: list[str]) -> list[str]:
    """Deduplicate rendered text while preserving order."""
    seen: set[str] = set()
    unique: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def _fmt_pct(value: Any) -> str:
    return f"{float(value):.0%}"


def _render_signal_composition(lines: list[str], report: dict[str, Any]) -> None:
    """Render the formal signal composition section."""
    composition = report.get("risk_composition", {})
    if not composition:
        return

    lines.append("## Signal Composition")
    lines.append("")
    if composition.get("formula"):
        lines.append(f"- **PR/commit model**: `{composition['formula']}`")
    if composition.get("file_formula"):
        lines.append(f"- **File model**: `{composition['file_formula']}`")
    if composition.get("confidence_formula"):
        lines.append(f"- **Confidence model**: `{composition['confidence_formula']}`")

    contributions = composition.get("contributions_pct", {})
    if contributions:
        ordered = sorted(contributions.items(), key=lambda kv: float(kv[1]), reverse=True)
        lines.append(
            "- **Normalized contribution**: "
            + ", ".join(f"{name} `{_fmt_pct(value)}`" for name, value in ordered)
        )

    components = composition.get("components_avg", {})
    if components:
        ordered_components = ("style", "structural", "semantic", "duplication", "security", "evolution")
        lines.append(
            "- **Average signal scores**: "
            + ", ".join(
                f"{name} `{float(components.get(name, 0.0)):.3f}`"
                for name in ordered_components
            )
        )
    lines.append(f"- **Risk percentile basis**: `{composition.get('percentile_basis', 'within_pr_files')}`")
    lines.append("")


def _render_agent_consensus(lines: list[str], report: dict[str, Any]) -> None:
    """Render the multi-agent collaboration board summary."""
    consensus = report.get("agent_collaboration", {})
    if not consensus:
        return

    lines.append("## Multi-Agent Consensus")
    lines.append("")
    decision = str(consensus.get("decision", "n/a")).replace("_", " ")
    lines.append(f"- **Board decision:** `{decision}`")
    lines.append(f"- **Consensus score:** `{float(consensus.get('consensus_score', 0.0)):.3f}`")
    lines.append(f"- **Confidence:** `{float(consensus.get('confidence', 0.0)):.2f}`")
    lines.append(f"- **Quorum:** `{consensus.get('quorum', 'n/a')}`")

    participants = consensus.get("participants", [])
    if participants:
        lines.append("- **Participants:** " + ", ".join(f"`{name}`" for name in participants))
    if consensus.get("protocol"):
        lines.append(f"- **Protocol:** `{consensus['protocol']}`")
    if consensus.get("collaboration_value"):
        lines.append(f"- **Why it matters:** {consensus['collaboration_value']}")

    findings = consensus.get("top_findings", [])
    if findings:
        lines.append("")
        lines.append("**Top agent findings**")
        for finding in findings[:5]:
            signal = finding.get("signal_name", "signal")
            agent = finding.get("agent_name", "agent")
            severity = finding.get("severity", "medium")
            evidence = "; ".join(str(ev) for ev in finding.get("evidence", [])[:2])
            lines.append(f"- `{severity}` [{signal}] {agent}: {evidence}")

    queue = consensus.get("review_queue", [])
    if queue:
        lines.append("")
        lines.append("**Suggested reviewer handoff**")
        for item in queue[:5]:
            lines.append(
                f"- `{item.get('owner', 'Agent')}` -> `{item.get('scope', 'PR')}`: "
                f"{item.get('focus', '')}"
            )

    disagreements = consensus.get("disagreements", [])
    if disagreements:
        lines.append("")
        lines.append("**Disagreements to resolve**")
        for note in disagreements[:4]:
            lines.append(f"- {note}")

    actions = consensus.get("next_actions", [])
    if actions:
        lines.append("")
        lines.append("**Next actions**")
        for action in actions[:5]:
            lines.append(f"- {action}")
    lines.append("")


def _render_highest_risk_files(lines: list[str], report: dict[str, Any]) -> None:
    top_files = report.get("top_risky_files", [])
    if not top_files:
        return

    lines.append("## Highest-Risk Files")
    lines.append("")
    lines.append("| File | Avg Risk | Max Risk | Dominant Signals | Confidence | Churn | Owner |")
    lines.append("|------|:--------:|:--------:|------------------|:----------:|------:|-------|")
    for item in top_files[:10]:
        dominant = ", ".join(item.get("dominant_signals", [])) or "n/a"
        lines.append(
            f"| `{item['file']}` | `{float(item.get('avg_risk', 0.0)):.3f}` | "
            f"`{float(item.get('max_risk', 0.0)):.3f}` | {dominant} | "
            f"`{float(item.get('confidence', 0.0)):.2f}` | "
            f"{int(item.get('churn_lines', 0))} | {item.get('owner', 'unknown')} |"
        )
    lines.append("")


def _render_security_override(lines: list[str], report: dict[str, Any]) -> None:
    security_findings = report.get("security_findings", [])
    if not security_findings:
        return

    lines.append("## Security Override")
    lines.append("")
    lines.append("Security findings are preserved as override evidence and should be reviewed before merge.")
    for item in security_findings[:10]:
        sha = item.get("commit_sha", "")
        sha_label = f" (`{sha}`)" if sha else ""
        lines.append(f"- `{item.get('filepath', '?')}`{sha_label}: {item.get('evidence', '')}")
    if len(security_findings) > 10:
        lines.append(f"- ...and {len(security_findings) - 10} more finding(s)")
    lines.append("")


def _render_evidence_chain(lines: list[str], report: dict[str, Any]) -> None:
    chain_items: list[str] = []
    for item in report.get("evidence_summary", []):
        text = str(item.get("text", "")).strip()
        if text:
            chain_items.append(text)

    for item in report.get("file_deep_dive", []):
        for evidence in item.get("evidence_chain", []):
            if isinstance(evidence, dict) and evidence.get("text"):
                chain_items.append(f"[{evidence.get('signal_name', 'signal')}] {evidence['text']}")

    chain_items = _dedupe_text(chain_items)
    if not chain_items:
        return

    lines.append("## Evidence Chain")
    lines.append("")
    for text in chain_items[:12]:
        lines.append(f"- {text}")
    lines.append("")


def _render_retrieval_summary(lines: list[str], report: dict[str, Any]) -> None:
    retrieval = report.get("retrieval", {})
    packs = retrieval.get("packs", [])
    summary = retrieval.get("summary", {})
    if not retrieval:
        return

    lines.append("## Evidence Retrieval")
    lines.append("")
    lines.append(
        "- **Strategy:** "
        f"`{retrieval.get('strategy', 'hybrid_path_symbol_signal_callsite_ownership_local_similarity')}`"
    )
    lines.append(f"- **Context budget:** `{int(retrieval.get('context_budget_tokens', 0))}` tokens")
    lines.append(f"- **Files with evidence:** `{int(summary.get('files_with_evidence', 0))}`")
    lines.append(
        "- **Average compression ratio:** "
        f"`{float(summary.get('average_compression_ratio', 0.0)):.3f}`"
    )
    if packs:
        first = packs[0]
        lines.append("")
        lines.append(f"**Why this file was retrieved:** `{first.get('file', '?')}`")
        query = first.get("query", {})
        if query.get("natural_query"):
            lines.append(f"- Query: {query['natural_query']}")
        selected = first.get("selected_evidence", [])
        for item in selected[:3]:
            candidate = item.get("candidate", {})
            reasons = "; ".join(item.get("why_selected", [])[:3])
            lines.append(
                f"- `{candidate.get('kind', 'evidence')}` from `{candidate.get('source', 'unknown')}`"
                f" selected because {reasons or 'it matched the retrieval query'}."
            )
    lines.append("")


def _render_top_file_deep_dive(lines: list[str], report: dict[str, Any]) -> None:
    deep_dive = report.get("file_deep_dive", [])
    if not deep_dive:
        return

    item = deep_dive[0]
    breakdown = item.get("risk_breakdown", {})
    contributions = item.get("signal_contributions", {})
    dominant = ", ".join(item.get("dominant_signals", [])) or "n/a"

    lines.append("## Top File Deep Dive")
    lines.append("")
    lines.append(f"**File:** `{item.get('file', '?')}`")
    lines.append(f"- **Risk:** `{float(item.get('risk', 0.0)):.3f}`")
    lines.append(f"- **Dominant signals:** {dominant}")
    lines.append(f"- **Confidence:** `{float(item.get('confidence', 0.0)):.2f}`")

    rank = item.get("rank_in_pr")
    total = item.get("total_pr_files")
    if rank is not None and total is not None:
        lines.append(f"- **Risk ranking among PR files:** `#{rank} / {total}`")
    if item.get("estimated_review_effort"):
        lines.append(f"- **Estimated review effort:** `{item['estimated_review_effort']}`")
    if item.get("primary_risk_region"):
        lines.append(f"- **Primary risk region:** `{item['primary_risk_region']}`")

    if contributions:
        ordered = sorted(contributions.items(), key=lambda kv: float(kv[1]), reverse=True)
        lines.append(
            "- **Contribution share:** "
            + ", ".join(f"{name} `{_fmt_pct(value)}`" for name, value in ordered)
        )
    if breakdown:
        lines.append(
            "- **Raw signal scores:** "
            + ", ".join(
                f"{name} `{float(breakdown.get(name, 0.0)):.3f}`"
                for name in ("style", "structural", "semantic", "duplication", "security")
            )
        )
    if item.get("structural_signals"):
        lines.append("- **Structural signals:** " + "; ".join(item["structural_signals"][:4]))
    if item.get("semantic_signals"):
        lines.append("- **Semantic signals:** " + "; ".join(item["semantic_signals"][:4]))
    if item.get("risky_lines"):
        lines.append("- **High-risk lines:** " + ", ".join(str(x) for x in item["risky_lines"][:10]))

    if item.get("diff_excerpt"):
        lines.append("")
        lines.append("<details>")
        lines.append("<summary>Diff snippet</summary>")
        lines.append("")
        lines.append("```diff")
        lines.append(item["diff_excerpt"])
        lines.append("```")
        lines.append("</details>")

    if item.get("code_excerpt"):
        lines.append("")
        lines.append("<details>")
        lines.append("<summary>Code excerpt around high-risk lines</summary>")
        lines.append("")
        lines.append("```python")
        lines.append(item["code_excerpt"])
        lines.append("```")
        lines.append("</details>")
    lines.append("")


def _build_suggestions(report: dict[str, Any]) -> list[str]:
    """Generate human review guidance from the explainability schema."""
    suggestions: list[str] = []
    avg_risk = float(report.get("avg_risk", 0.0))
    top_files = report.get("top_risky_files", [])
    security_findings = report.get("security_findings", [])

    critical_findings = [item for item in security_findings if "[CRITICAL]" in str(item.get("evidence", ""))]
    high_findings = [item for item in security_findings if "[HIGH]" in str(item.get("evidence", ""))]

    if critical_findings:
        suggestions.append(
            "**Block merge**: CRITICAL security evidence was detected. Remove secrets "
            "or code-injection risks before reviewing lower-priority drift signals."
        )
    elif high_findings:
        suggestions.append(
            "**Request changes**: HIGH severity security evidence was detected. "
            "Review the override evidence before accepting the PR."
        )
    elif avg_risk >= 0.75:
        suggestions.append(
            "**High drift**: inspect the highest-risk files for project-specific "
            "structural, semantic, and evolution deviations."
        )
    elif avg_risk >= 0.50:
        suggestions.append(
            "**Moderate drift**: review the top-ranked files and verify whether the "
            "dominant signals represent intended design change."
        )
    elif avg_risk >= 0.25:
        suggestions.append(
            "**Minor drift**: a focused pass over naming, dependencies, and changed "
            "control-flow regions should be sufficient."
        )
    else:
        suggestions.append("The PR appears close to the project-specific historical baseline.")

    if top_files:
        top_file = top_files[0].get("file", "?")
        dominant = ", ".join(top_files[0].get("dominant_signals", [])) or "dominant signal"
        suggestions.append(f"Start with `{top_file}` because it is ranked highest by {dominant}.")

        owner_share = float(top_files[0].get("owner_share", 0.0))
        if owner_share >= 0.8:
            suggestions.append(
                f"`{top_file}` is concentrated on one author ({owner_share:.0%} of PR touches). "
                "Ask for a second reviewer outside the primary author when possible."
            )

    deep_dive = report.get("file_deep_dive", [])
    if deep_dive:
        risky_lines = deep_dive[0].get("risky_lines", [])
        if risky_lines:
            suggestions.append(
                f"Begin the file review at `{deep_dive[0].get('file', '?')}` lines "
                + ", ".join(str(x) for x in risky_lines[:5])
                + "."
            )

        effort = deep_dive[0].get("estimated_review_effort")
        region = deep_dive[0].get("primary_risk_region")
        if effort:
            hint = f"Estimated review effort for `{deep_dive[0].get('file', '?')}`: {effort}"
            if region:
                hint += f" around {region}"
            suggestions.append(hint + ".")

    concentration_flag = False
    for commit in report.get("commits", []):
        for evidence in commit.get("evolution_evidence", []):
            lowered = str(evidence).lower()
            if "bus-factor" in lowered or "single author" in lowered:
                concentration_flag = True
                break
        if concentration_flag:
            break

    if concentration_flag:
        suggestions.append(
            "**Knowledge concentration risk**: most touched files appear tied to a "
            "single author; include an additional reviewer."
        )

    return _dedupe_text(suggestions)


def generate_review_comment(
    report: dict[str, Any],
    *,
    use_llm: bool = False,
) -> str:
    """Render an explainable, research-oriented PR risk report."""
    commit_count = int(report.get("commit_count", 0))
    avg_risk = float(report.get("avg_risk", 0.0))
    max_risk = float(report.get("max_risk", 0.0))
    high_risk = int(report.get("high_risk_commits", 0))
    label = _risk_label(avg_risk)

    lines: list[str] = []
    lines.append("# ConsistenCy Explainable PR Risk Report")
    lines.append("")
    lines.append("## Overall PR Risk")
    lines.append("")
    lines.append(f"- **Risk level:** {label}")
    lines.append(f"- **Average risk:** `{avg_risk:.3f}`")
    lines.append(f"- **Maximum risk:** `{max_risk:.3f}`")
    lines.append(f"- **Commit count:** `{commit_count}`")
    lines.append(f"- **High-risk commits:** `{high_risk}`")
    lines.append("")

    _render_signal_composition(lines, report)
    _render_agent_consensus(lines, report)
    _render_highest_risk_files(lines, report)
    _render_security_override(lines, report)
    _render_evidence_chain(lines, report)
    _render_retrieval_summary(lines, report)
    _render_top_file_deep_dive(lines, report)

    suggestions = _build_suggestions(report)
    if suggestions:
        lines.append("## Human Review Suggestions")
        lines.append("")
        for suggestion in suggestions:
            lines.append(f"- {suggestion}")
        lines.append("")

    if use_llm:
        lines.append("## Optional AI Narrative")
        lines.append("")
        if is_llm_available():
            lines.append(
                review_with_llm(
                    top_files=report.get("top_risky_files", []),
                    security_findings=report.get("security_findings", []),
                    agent_summaries=report.get("agent_summaries", {}),
                    avg_risk=avg_risk,
                    code_snippets=report.get("code_snippets", []),
                )
            )
        else:
            lines.append("Set `DEEPSEEK_API_KEY` to enable the optional AI narrative.")
        lines.append("")

    lines.append("---")
    lines.append(
        "*Generated by ConsistenCy: project-specific code drift modeling for PR review.*"
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python review_suggestions.py <report.json> [--output <file.md>]",
              file=sys.stderr)
        sys.exit(1)

    report_path = sys.argv[1]
    try:
        with open(report_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, FileNotFoundError):
        data = {}

    comment = generate_review_comment(data)

    output_path: str | None = None
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        if idx + 1 < len(sys.argv):
            output_path = sys.argv[idx + 1]

    if output_path:
        Path(output_path).write_text(comment, encoding="utf-8")
        print(f"Review comment written to {output_path}", file=sys.stderr)
    else:
        print(comment)
