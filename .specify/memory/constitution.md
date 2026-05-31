# ConsistenCy Constitution

## Core Principles

### I. Deterministic Scoring First

All risk signals MUST be produced by deterministic specialist analyzers. The scoring layer MUST be reproducible without an LLM key. LLM review is an optional augmentation, never a required scoring path. Every score change MUST be traceable to a specific rule, metric, or pattern in the agent that produced it.

### II. Specialist Agent Architecture

Each review perspective (style, structure, semantics, duplication, security, evolution) MUST live in an independent agent module. Agents MUST NOT share mutable state. Each agent MUST emit typed `AgentResult` objects with score, evidence, confidence, and metadata. New signals MUST be added as new agents rather than expanding existing ones.

### III. Test-First for Scoring Changes

Any change to agent scoring, the consensus protocol, or report schema MUST include tests before implementation. Tests MUST verify: (a) deterministic output for fixed inputs, (b) edge cases produce sensible scores, and (c) the collaboration coordinator produces the expected decision for known vote patterns.

### IV. CLI + API Product Surfaces

Every analysis capability MUST be exposed through both a CLI command and a Flask API endpoint. CLI output MUST support `--json-output` for machine consumption and Rich-formatted terminal output for humans. API responses MUST match the stable report schema. New commands or endpoints MUST be documented in README.md.

### V. Explainable Output

Every risk score above 0.5 MUST be accompanied by at least one evidence statement. The collaboration coordinator MUST produce: votes, quorum, decision, top findings, disagreement notes, and a reviewer handoff queue. The output schema MUST remain stable enough that evaluation scripts from previous versions can still read current reports.

## Security Requirements

- Security agent evidence categorized as CRITICAL/HIGH/MEDIUM MUST override lower-priority signals in the consensus protocol.
- No secrets (API keys, tokens, credentials) MUST ever appear in reports, logs, or cached files. Token redaction MUST be applied before writing any captured command output to disk.
- GitHub App mode MUST require an encryption key in production; development mode falls back to obfuscation with a clear warning.

## Development Workflow

- All changes MUST pass `python -m pytest -q` before merging.
- Frontend JavaScript changes MUST pass `node --check`.
- The deterministic demo (`python examples/multi_agent_demo.py`) MUST not regress.
- Generated files (caches, databases, evaluation outputs, cloned repos) MUST be git-ignored.
- Commits SHOULD follow conventional commit format: `type: description`.

## Governance

This constitution supersedes all other project practices. Amendments require a documented rationale and approval. Any PR that weakens determinism, removes explainability, or degrades test coverage below current levels MUST explicitly justify the trade-off in its description.

**Version**: 1.0.0 | **Ratified**: 2026-05-31 | **Last Amended**: 2026-05-31
