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
        lines.append("| File | Avg Risk | Max Risk | Appearances |")
        lines.append("|------|:--------:|:--------:|:-----------:|")
        for item in top_files[:10]:
            e = _risk_emoji(item["avg_risk"])
            lines.append(
                f"| `{item['file']}` | {e} `{item['avg_risk']:.3f}` | "
                f"`{item['max_risk']:.3f}` | {item['hits']} |"
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

        # Collapse evidence chain
        all_evidence: list[str] = []
        for c in commits:
            for ev in c.get("evolution_evidence", [])[:2]:
                if ev not in all_evidence:
                    all_evidence.append(ev)

        if all_evidence:
            lines.append("<details>")
            lines.append("<summary>📋 Evidence Chain (expand)</summary>")
            lines.append("")
            lines.append("```")
            for ev in all_evidence[:20]:
                lines.append(f"· {ev}")
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

    # Bus factor check from evolution evidence
    for c in report.get("commits", []):
        for ev in c.get("evolution_evidence", []):
            if "bus-factor" in ev.lower() or "single author" in ev.lower():
                suggestions.append(
                    "👥 **Knowledge concentration risk**: Most files in this PR are "
                    "owned by a single author. Request review from additional contributors."
                )
                break

    return suggestions


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
