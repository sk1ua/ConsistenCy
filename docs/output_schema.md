# Output Schema

This document describes the stable report fields used by the CLI, Flask API, Markdown review comments, and dashboard showcase.

## Signal Result

```json
{
  "signal_name": "semantic",
  "score": 0.47,
  "evidence": ["AST structure diverged significantly"],
  "confidence": 0.82,
  "metadata": {"agent_name": "SemanticAgent"}
}
```

## File Result

```json
{
  "file": "src/example.py",
  "risk_score": 0.651,
  "risk_level": "Significant Drift",
  "breakdown": {
    "style": 0.08,
    "structural": 0.19,
    "semantic": 0.47,
    "duplication": 0.03,
    "security": 0.0
  },
  "signal_composition": {
    "style": 0.10,
    "structural": 0.20,
    "semantic": 0.65,
    "duplication": 0.05,
    "security": 0.0
  },
  "dominant_signals": ["semantic", "structural"],
  "confidence": 0.82,
  "agent_collaboration": {
    "scope": "src/example.py",
    "decision": "review_required",
    "consensus_score": 0.44,
    "confidence": 0.81,
    "quorum": "5/5",
    "participants": ["StyleAgent", "StructuralAgent", "SemanticAgent", "DuplicationAgent", "SecurityAgent"],
    "top_findings": [],
    "review_queue": [],
    "protocol": "parallel_agents -> evidence_normalization -> weighted_consensus -> reviewer_handoff"
  },
  "explainability": {
    "dominant_signals": ["semantic", "structural"],
    "contributions": {},
    "evidence_chain": [],
    "confidence": 0.82,
    "uncertainty_note": "Confidence is lower when historical baseline coverage is sparse or signals disagree."
  }
}
```

## PR Report

Important top-level keys:

- `base_ref`
- `head_ref`
- `commit_count`
- `avg_risk`
- `max_risk`
- `high_risk_commits`
- `commits`
- `commit_trend`
- `risk_composition`
- `evidence_summary`
- `top_risky_files`
- `file_deep_dive`
- `security_findings`
- `agent_collaboration`
- `code_snippets`
- `cache`

## Multi-Agent Collaboration

`agent_collaboration` appears on file results and PR reports.

```json
{
  "scope": "pull_request",
  "decision": "review_required",
  "consensus_score": 0.44,
  "confidence": 0.81,
  "quorum": "5/5",
  "participants": [
    "StyleAgent",
    "StructuralAgent",
    "SemanticAgent",
    "DuplicationAgent",
    "SecurityAgent"
  ],
  "votes": [],
  "top_findings": [
    {
      "signal_name": "semantic",
      "agent_name": "SemanticAgent",
      "severity": "medium",
      "title": "SemanticAgent voted needs_attention",
      "evidence": ["src/example.py: API usage changed"],
      "recommendation": "Trace changed behavior and API usage against the intended PR design."
    }
  ],
  "disagreements": [],
  "next_actions": [],
  "review_queue": [],
  "protocol": "parallel_agents -> evidence_normalization -> weighted_consensus -> reviewer_handoff"
}
```

## Deep Dive

The first deep-dive item should contain:

- `file`
- `risk`
- `rank_in_pr`
- `total_pr_files`
- `risk_breakdown`
- `signal_contributions`
- `dominant_signals`
- `confidence`
- `evidence_chain`
- `risky_lines`
- `primary_risk_region`
- `estimated_review_effort`
- `structural_signals`
- `semantic_signals`
- `code_excerpt`
- `diff_excerpt`
