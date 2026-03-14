#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Review Suggestion Generator
============================
Converts a ConsistenCy PR analysis report (JSON) into a formatted
GitHub PR review comment in Markdown.

Used by the CI workflow to automatically post review comments.

Usage (CLI):
    python review_suggestions.py <report.json>
    python review_suggestions.py <report.json> --output comment.md

Usage (Python):
    from src.review_suggestions import generate_review_comment
    md = generate_review_comment(pr_report_dict)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from src.llm_reviewer import is_llm_available, review_with_llm


# ---------------------------------------------------------------------------
# Risk helpers
# ---------------------------------------------------------------------------

def _risk_emoji(score: float) -> str:
    if score >= 0.75:
        return "🔴"
    if score >= 0.50:
        return "🟠"
    if score >= 0.25:
        return "🟡"
    return "🟢"


def _risk_label(score: float) -> str:
    if score >= 0.75:
        return "High Risk"
    if score >= 0.50:
        return "Significant Drift"
    if score >= 0.25:
        return "Minor Drift"
    return "Consistent"


# ---------------------------------------------------------------------------
# Main generator
# ---------------------------------------------------------------------------

def generate_review_comment(
    report: dict[str, Any],
    *,
    use_llm: bool = False,
) -> str:
    """Generate a GitHub PR review comment in Markdown.

    Parameters
    ----------
    report : dict
        Output of AnalysisPipeline.pr_risk_report() serialized as JSON/dict.
    use_llm : bool
        When True (and DEEPSEEK_API_KEY is set), append an AI-generated
        review section from the DeepSeek API.

    Returns
    -------
    str
        Markdown-formatted review comment ready to post as a PR comment.
    """
    commit_count = report.get("commit_count", 0)
    avg_risk     = float(report.get("avg_risk", 0.0))
    max_risk     = float(report.get("max_risk", 0.0))
    high_risk    = int(report.get("high_risk_commits", 0))

    emoji = _risk_emoji(avg_risk)
    label = _risk_label(avg_risk)

    lines: list[str] = []
    lines.append("## ⬡ ConsistenCy — Automated PR Risk Analysis")
    lines.append("")
    lines.append(
        f"{emoji} **{label}** &nbsp;·&nbsp; "
        f"avg `{avg_risk:.3f}` · max `{max_risk:.3f}` · "
        f"{commit_count} commit(s) · {high_risk} high-risk"
    )
    lines.append("")

    composition = report.get("risk_composition", {})
    if composition:
        formula = composition.get("formula")
        file_formula = composition.get("file_formula")
        comps = composition.get("components_avg", {})
        if formula:
            lines.append(f"> **Risk Formula**: `{formula}`")
        if file_formula:
            lines.append(f"> **File Formula**: `{file_formula}`")
        if comps:
            lines.append(
                "> **Avg Composition**: "
                f"style `{float(comps.get('style', 0.0)):.3f}`, "
                f"structural `{float(comps.get('structural', 0.0)):.3f}`, "
                f"semantic `{float(comps.get('semantic', 0.0)):.3f}`, "
                f"duplication `{float(comps.get('duplication', 0.0)):.3f}`, "
                f"security `{float(comps.get('security', 0.0)):.3f}`, "
                f"evolution `{float(comps.get('evolution', 0.0)):.3f}`"
            )
        lines.append("")

    # ── Security findings ──────────────────────────────────────────────────
    security_findings = report.get("security_findings", [])
    if security_findings:
        lines.append("### 🔐 Security Findings")
        lines.append("")
        lines.append("> ⚠️ Security issues were detected. These must be resolved before merging.")
        lines.append("")
        for item in security_findings[:10]:
            fp  = item.get("filepath", "?")
            sha = item.get("commit_sha", "")
            ev  = item.get("evidence", "")
            sha_label = f" (`{sha}`)" if sha else ""
            lines.append(f"- `{fp}`{sha_label}: {ev}")
        if len(security_findings) > 10:
            lines.append(f"- *…and {len(security_findings) - 10} more findings*")
        lines.append("")

    # ── Top risky files ────────────────────────────────────────────────────
    top_files = report.get("top_risky_files", [])
    if top_files:
        lines.append("### 📁 Highest Risk Files")
        lines.append("")
        lines.append("| File | Avg Risk | Max Risk | Risk %ile | Churn | Complexity | Owner | Appearances |")
        lines.append("|------|:--------:|:--------:|:---------:|------:|-----------:|-------|:-----------:|")
        for item in top_files[:10]:
            e = _risk_emoji(item["avg_risk"])
            lines.append(
                f"| `{item['file']}` | {e} `{item['avg_risk']:.3f}` | "
                f"`{item['max_risk']:.3f}` | "
                f"`{float(item.get('risk_percentile', 0.0)):.2f}` | "
                f"{int(item.get('churn_lines', 0))} | "
                f"`{float(item.get('complexity', 0.0)):.2f}` | "
                f"{item.get('owner', 'unknown')} | {item['hits']} |"
            )
        lines.append("")

    # ── Commit breakdown ───────────────────────────────────────────────────
    commits = report.get("commits", [])
    if commits:
        lines.append("### 📝 Commit Risk Breakdown")
        lines.append("")
        lines.append("| Commit | Author | Risk | Level |")
        lines.append("|--------|--------|:----:|-------|")
        for c in sorted(commits, key=lambda x: x.get("risk_score", 0), reverse=True)[:10]:
            score  = float(c.get("risk_score", 0.0))
            e      = _risk_emoji(score)
            sha    = c.get("sha", "?")
            author = c.get("author", "unknown")
            level  = c.get("risk_level", _risk_label(score))
            msg    = (c.get("message", "") or "")[:60]
            lines.append(f"| `{sha}` | {author} | {e} `{score:.3f}` | {level} |")
        lines.append("")

    trend = report.get("commit_trend", [])
    if trend:
        lines.append("### 📈 Commit Risk Trend")
        lines.append("")
        lines.append("| Commit | Risk | Δ | Δ% |")
        lines.append("|--------|:----:|:--:|:--:|")
        for t in trend[:20]:
            score = float(t.get("risk_score", 0.0))
            delta = t.get("delta")
            delta_pct = t.get("delta_pct")
            delta_txt = "—" if delta is None else f"{float(delta):+.3f}"
            delta_pct_txt = "—" if delta_pct is None else f"{float(delta_pct):+.1%}"
            lines.append(f"| `{t.get('sha', '?')}` | `{score:.3f}` | `{delta_txt}` | `{delta_pct_txt}` |")
        lines.append("")

    evidence_summary = report.get("evidence_summary", [])
    if evidence_summary:
        lines.append("<details>")
        lines.append("<summary>📋 Evidence Chain (deduplicated)</summary>")
        lines.append("")
        for item in evidence_summary:
            txt = item.get("text", "")
            baseline = item.get("baseline")
            current = item.get("current")
            delta = item.get("delta")
            delta_pct = item.get("delta_pct")
            details = []
            if baseline is not None:
                details.append(f"baseline={baseline}")
            if current is not None:
                details.append(f"current={current}")
            if delta is not None:
                details.append(f"Δ={delta:+}")
            if delta_pct is not None:
                details.append(f"Δ%={float(delta_pct):+.1%}")
            suffix = f" ({', '.join(details)})" if details else ""
            lines.append(f"- {txt}{suffix}")
        lines.append("")
        lines.append("</details>")
        lines.append("")

    deep_dive = report.get("file_deep_dive", [])
    if deep_dive:
        item = deep_dive[0]
        breakdown = item.get("risk_breakdown", {})
        lines.append("### 🔎 Top File Deep Dive")
        lines.append("")
        lines.append(f"**File:** `{item.get('file', '?')}` · **Risk:** `{float(item.get('risk', 0.0)):.3f}`")
        lines.append(
            "- **Risk breakdown**: "
            f"style `{float(breakdown.get('style', 0.0)):.3f}`, "
            f"structural `{float(breakdown.get('structural', 0.0)):.3f}`, "
            f"semantic `{float(breakdown.get('semantic', 0.0)):.3f}`, "
            f"duplication `{float(breakdown.get('duplication', 0.0)):.3f}`, "
            f"security `{float(breakdown.get('security', 0.0)):.3f}`"
        )

        risky_lines = item.get("risky_lines", [])
        if risky_lines:
            lines.append(f"- **High-risk lines**: {', '.join(str(x) for x in risky_lines[:10])}")

        diff_excerpt = item.get("diff_excerpt", "")
        if diff_excerpt:
            lines.append("")
            lines.append("<details>")
            lines.append("<summary>Diff snippet</summary>")
            lines.append("")
            lines.append("```diff")
            lines.append(diff_excerpt)
            lines.append("```")
            lines.append("")
            lines.append("</details>")

        code_excerpt = item.get("code_excerpt", "")
        if code_excerpt:
            lines.append("")
            lines.append("<details>")
            lines.append("<summary>Code excerpt around high-risk lines</summary>")
            lines.append("")
            lines.append("```python")
            lines.append(code_excerpt)
            lines.append("```")
            lines.append("")
            lines.append("</details>")
        lines.append("")

    # ── Actionable suggestions ─────────────────────────────────────────────
    suggestions = _build_suggestions(report)
    if suggestions:
        lines.append("### 💡 Review Suggestions")
        lines.append("")
        for s in suggestions:
            lines.append(f"- {s}")
        lines.append("")

    # ── AI review (optional) ──────────────────────────────────────────────
    if use_llm and is_llm_available():
        lines.append("### 🤖 AI Code Review")
        lines.append("")
        # Extract code snippets for LLM from file sources in report
        code_snippets = report.get("code_snippets", [])
        ai_text = review_with_llm(
            top_files=top_files,
            security_findings=security_findings,
            agent_summaries=report.get("agent_summaries", {}),
            avg_risk=avg_risk,
            code_snippets=code_snippets,
        )
        lines.append(ai_text)
        lines.append("")
    elif use_llm and not is_llm_available():
        lines.append("> ℹ️ Set `DEEPSEEK_API_KEY` to enable AI-powered review comments.")
        lines.append("")

    # ── Footer ─────────────────────────────────────────────────────────────
    lines.append("---")
    lines.append(
        "*Generated by [ConsistenCy](https://github.com) — "
        "Multi-Agent Code Consistency & Security Analysis*"
    )

    return "\n".join(lines)


def _build_suggestions(report: dict[str, Any]) -> list[str]:
    """Generate actionable review suggestions from the report data."""
    suggestions: list[str] = []
    avg_risk = float(report.get("avg_risk", 0.0))
    top_files = report.get("top_risky_files", [])
    security_findings = report.get("security_findings", [])

    # Security-first: always highest priority
    critical_findings = [f for f in security_findings if "[CRITICAL]" in f.get("evidence", "")]
    high_findings     = [f for f in security_findings if "[HIGH]" in f.get("evidence", "")]

    if critical_findings:
        suggestions.append(
            "🚫 **Block merge**: CRITICAL security vulnerabilities detected "
            "(hardcoded credentials or code-injection risk). "
            "Remove all secrets and replace dangerous calls before merging."
        )
    elif high_findings:
        suggestions.append(
            "⛔ **Request changes**: HIGH severity security issues found "
            "(dangerous function calls or deserialization risks). "
            "Address all HIGH findings before merging."
        )

    # Drift-level suggestions
    if not critical_findings and not high_findings:
        if avg_risk >= 0.75:
            suggestions.append(
                "🔴 **Significant code drift** detected across this PR. "
                "Review the high-risk files listed above for consistency violations — "
                "naming style, import structure, and semantic patterns all diverge from the project baseline."
            )
        elif avg_risk >= 0.50:
            suggestions.append(
                "🟠 **Moderate drift** detected. "
                "Review top-risk files for unintended style or structural changes."
            )
        elif avg_risk >= 0.25:
            suggestions.append(
                "🟡 **Minor drift** detected. A quick look at naming conventions "
                "and import additions should be sufficient."
            )
        else:
            suggestions.append(
                "🟢 **Code appears consistent** with the project baseline. "
                "Standard review is sufficient."
            )

    # File-specific suggestions
    if top_files:
        top_file = top_files[0]["file"]
        top_score = top_files[0]["avg_risk"]
        if top_score >= 0.50:
            suggestions.append(
                f"Focus review effort on `{top_file}` — "
                f"it has the highest repeated risk score (`{top_score:.3f}`) across commits in this PR."
            )

        top_breakdown = top_files[0].get("risk_breakdown", {})
        if isinstance(top_breakdown, dict) and top_breakdown:
            dominant_metric, dominant_score = max(
                top_breakdown.items(), key=lambda kv: float(kv[1])
            )
            if float(dominant_score) > 0:
                suggestions.append(
                    f"For `{top_file}`, prioritize **{dominant_metric}** review first "
                    f"(component `{float(dominant_score):.3f}`), then verify adjacent side effects."
                )

        owner_share = float(top_files[0].get("owner_share", 0.0))
        if owner_share >= 0.8:
            suggestions.append(
                f"`{top_file}` is heavily concentrated on one author ({owner_share:.0%} of PR touches). "
                "Request at least one additional reviewer outside the primary author."
            )

    deep_dive = report.get("file_deep_dive", [])
    if deep_dive:
        lines = deep_dive[0].get("risky_lines", [])
        if lines:
            suggestions.append(
                f"Start review from high-risk lines in `{deep_dive[0].get('file', '?')}`: "
                + ", ".join(str(x) for x in lines[:5])
                + "."
            )

    # Bus factor check from evolution evidence
    concentration_flag = False
    for c in report.get("commits", []):
        for ev in c.get("evolution_evidence", []):
            if "bus-factor" in ev.lower() or "single author" in ev.lower():
                concentration_flag = True
                break
        if concentration_flag:
            break

    if concentration_flag:
        suggestions.append(
            "👥 **Knowledge concentration risk**: Most files in this PR are "
            "owned by a single author. Request review from additional contributors."
        )

    # Keep suggestions concise and deduplicated while preserving order.
    seen: set[str] = set()
    unique: list[str] = []
    for item in suggestions:
        if item not in seen:
            seen.add(item)
            unique.append(item)

    return unique


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
