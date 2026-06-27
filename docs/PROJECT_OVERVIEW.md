# Project Overview

ConsistenCy is an evidence-grounded multi-agent PR review assistant. It helps reviewers prioritize files by combining deterministic specialist analyzers, local evidence retrieval, compact Evidence Packs, and weighted consensus.

## Review Flow

```text
git diff -> project-history baseline -> evidence retrieval -> Evidence Pack -> deterministic analyzers -> weighted consensus -> reviewer handoff
```

Evidence Retrieval is not an agent. It supplies context for specialist analyzers and the reviewer handoff.

## Specialist Signals

| Signal | Purpose |
| --- | --- |
| `style` | naming, docs, convention drift |
| `structural` | imports, coupling, module boundaries |
| `semantic` | AST/API/control-flow proxy changes |
| `duplication` | clone and repeated implementation risk |
| `security` | unsafe patterns and security override hints |
| `evolution` | churn, hotspots, ownership, history risk |

## Evidence Retrieval

The retrieval layer is deterministic and local. It uses changed hunks, file snippets, baseline/history hints, agent findings, security findings, cross-file call-site hints, ownership hints, and local similarity scoring. It does not require a vector database or external API.

## Product Surfaces

- `apps/api`: GitHub App webhook API, worker, SQLite persistence.
- `apps/web`: React/Vite dashboard.
- `packages/schema`: shared TypeScript zod contracts.
- `backend`: Python analyzers, CLI, retrieval, evaluation support.
