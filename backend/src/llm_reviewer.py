# -*- coding: utf-8 -*-
"""
LLM Reviewer — DeepSeek Code Analysis
======================================
Calls the DeepSeek API (OpenAI-compatible) to produce natural-language
code review comments from ConsistenCy's structured analysis output.

Setup:
    export DEEPSEEK_API_KEY=<your-key>

The key is read ONLY from the environment.  It is never hard-coded and
must not appear in source, commits, or logs.
"""
from __future__ import annotations

import os
import textwrap
from pathlib import Path
from typing import Any

# Load .env file if present (local development convenience)
try:
    from dotenv import load_dotenv, find_dotenv
    _env_path = find_dotenv(usecwd=True)
    if _env_path:
        load_dotenv(_env_path, override=True)
except ImportError:
    pass  # python-dotenv not installed — rely on shell environment


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def is_llm_available() -> bool:
    """Return True when DEEPSEEK_API_KEY is set in the environment."""
    return bool(os.environ.get("DEEPSEEK_API_KEY", "").strip())


def review_with_llm(
    top_files: list[dict[str, Any]],
    security_findings: list[dict[str, Any]],
    agent_summaries: dict[str, Any],
    avg_risk: float,
    *,
    code_snippets: list[dict[str, Any]] | None = None,
    model: str = "deepseek-chat",
    max_tokens: int = 1024,
    timeout: float = 30.0,
) -> str:
    """Call DeepSeek and return a Markdown review block.

    Parameters
    ----------
    top_files : list[dict]
        ``top_risky_files`` list from ``pr_risk_report()``.
    security_findings : list[dict]
        ``security_findings`` list from ``pr_risk_report()``.
    agent_summaries : dict
        Arbitrary per-agent evidence included in the report.
    avg_risk : float
        Overall average risk score (0-1).
    code_snippets : list[dict] | None
        Extracted code snippets from ``llm_ready_snippets.prepare_code_for_llm()``.
        When provided, the LLM sees actual source code, not just metadata.
    model : str
        DeepSeek model name.
    max_tokens : int
        Maximum tokens in the completion.
    timeout : float
        HTTP request timeout in seconds.

    Returns
    -------
    str
        Markdown-formatted AI review section, or an error/unavailable note.
    """
    # Enforce loading from project .env to override stale system env vars
    _project_root = Path(__file__).parent.parent.parent
    _dotenv_path = _project_root / ".env"
    if _dotenv_path.exists():
        try:
            from dotenv import load_dotenv
            load_dotenv(str(_dotenv_path), override=True)
        except ImportError:
            pass
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return "_AI review unavailable: `DEEPSEEK_API_KEY` not set._"

    try:
        import openai  # lazy import — only required when actually called
    except ImportError:
        return "_AI review unavailable: `openai` package not installed._"

    prompt = _build_prompt(top_files, security_findings, agent_summaries, avg_risk, code_snippets)

    try:
        client = openai.OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com",
            timeout=timeout,
        )
        response = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert code-reviewer embedded in a CI pipeline. "
                        "You receive structured static-analysis data about a pull request "
                        "and produce a concise, actionable Markdown review. "
                        "Use bullet points. Be direct. Prioritise security and correctness. "
                        "Do not pad with generic advice. Maximum 400 words."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            max_tokens=max_tokens,
            temperature=0.2,
        )
        content = response.choices[0].message.content or ""
        return content.strip()
    except Exception as exc:  # pylint: disable=broad-except
        # Log full error to server console for debugging; return sanitized message to PR
        import sys, traceback
        print(f"[LLM] ERROR calling DeepSeek: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        kind = type(exc).__name__
        detail = str(exc)[:200] if str(exc) else "no detail"
        return f"_AI review failed ({kind}: {detail})_"


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def _build_prompt(
    top_files: list[dict[str, Any]],
    security_findings: list[dict[str, Any]],
    agent_summaries: dict[str, Any],
    avg_risk: float,
    code_snippets: list[dict[str, Any]] | None = None,
) -> str:
    """Construct a token-efficient prompt from structured analysis data."""
    parts: list[str] = []

    parts.append(f"**Overall risk score:** {avg_risk:.3f} / 1.0")

    # Security block (most important — always first)
    if security_findings:
        parts.append("\n**Security findings:**")
        for f in security_findings[:8]:
            fp = f.get("filepath", "?")
            ev = f.get("evidence", "")
            parts.append(f"- `{fp}`: {ev}")
        if len(security_findings) > 8:
            parts.append(f"- …and {len(security_findings) - 8} more")

    # High-risk files
    if top_files:
        parts.append("\n**Highest-risk files:**")
        for item in top_files[:6]:
            parts.append(
                f"- `{item['file']}` — avg {item['avg_risk']:.3f}, "
                f"max {item['max_risk']:.3f}, appears in {item['hits']} commit(s)"
            )

    # Actual code snippets — the most valuable signal for the LLM
    if code_snippets:
        parts.append("\n**Code excerpts from highest-risk files:**")
        budget = 2400  # rough token budget for code
        used = 0
        for snip in code_snippets:
            fp = snip.get("filepath", "?")
            for rs in snip.get("risky_snippets", [])[:3]:
                desc = (
                    f"`{fp}` L{rs.get('location', '?')}: "
                    f"{rs.get('reason', '')} [{rs.get('severity', '')}]"
                )
                parts.append(f"- {desc}")
            # Include top functions (sorted by complexity hint)
            for fn in snip.get("functions", [])[:4]:
                sig = fn.get("signature", "")[:300]
                if not sig:
                    continue
                # Only include body up to ~40 lines to stay within budget
                body = sig[:1600]
                chunk = f"\n```python\n# {fp} L{fn.get('lineno', '?')} ({fn.get('complexity', '?')})\n{body}\n```"
                if used + len(chunk) > budget:
                    break
                parts.append(chunk)
                used += len(chunk)
            if used > budget:
                break

    # Agent evidence (compact)
    interesting_agents = {
        "StyleAgent", "SemanticAgent", "ComplexityAgent", "EvolutionAgent"
    }
    if agent_summaries:
        evidence_lines: list[str] = []
        for agent, data in agent_summaries.items():
            if agent not in interesting_agents:
                continue
            if isinstance(data, dict):
                ev = data.get("evidence") or data.get("summary")
                if isinstance(ev, list):
                    ev = ev[:2]
                if ev:
                    evidence_lines.append(f"  {agent}: {ev}")
        if evidence_lines:
            parts.append("\n**Agent evidence (sample):**")
            parts.extend(evidence_lines)

    parts.append(
        "\nBased on the above analysis data AND the actual code excerpts, "
        "write a concise reviewer comment covering: "
        "① what to fix immediately (security/critical), "
        "② specific code-quality issues you spotted in the excerpts, "
        "③ what looks acceptable. Use Markdown bullet lists."
    )

    return "\n".join(parts)
