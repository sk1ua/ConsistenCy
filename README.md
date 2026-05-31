# ConsistenCy

[![CI](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml/badge.svg)](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml)

ConsistenCy is a multi-agent code review assistant for pull requests. It compares a change against project history, asks specialist agents to review different risk signals, and turns their evidence into an explainable reviewer handoff plan.

The project is designed as a portfolio-ready AI4SE system: small enough to run locally, but structured like a real review product with CLI commands, a Flask dashboard, GitHub App hooks, evaluation helpers, and reproducible tests.

![ConsistenCy agent review board](docs/assets/showcase.png)

## What It Does

- Builds project-specific baselines from Git history.
- Scores style, structure, semantics, duplication, security, and evolution drift.
- Coordinates specialist agent votes into a deterministic consensus decision.
- Produces explainable PR reports with evidence, confidence, top risky files, and review queues.
- Exposes the result through a CLI, Flask API, Markdown review comment renderer, and a dashboard showcase.

## Multi-Agent Review Board

| Agent | Focus |
| --- | --- |
| `StyleAgent` | Naming, docs, and local convention drift |
| `StructuralAgent` | Imports, coupling, inheritance, and module shape |
| `SemanticAgent` | Control flow, API usage, and behavior-level change |
| `DuplicationAgent` | Repeated implementation and clone risk |
| `SecurityAgent` | Secrets, unsafe calls, injection-like patterns, override evidence |
| `EvolutionAgent` | Churn, hotspots, and history-aware PR risk |

The collaboration layer emits quorum, votes, disagreement notes, merge decision, top findings, and a reviewer handoff queue.

## Demo Surface

The screenshot above is generated from the `/showcase` route. It demonstrates the data visualization layer: risk gauge, normalized signal chart, agent vote cards, evidence chain, and reviewer handoff queue.

## Quick Start

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-dev.txt
```

Run the deterministic demo:

```bash
python examples/multi_agent_demo.py
```

Analyze two file versions:

```bash
python backend/cli.py analyze-file examples/demo_new.py examples/demo_base.py --json-output
```

Launch the web showcase:

```bash
python frontend/app.py
```

Then open:

```text
http://127.0.0.1:8000/showcase
```

## CLI Examples

Generate a PR-style report for a local Git repository:

```bash
python backend/cli.py pr-report --repo /path/to/repo --base main --head HEAD --json-output > report.json
```

Render a Markdown review comment:

```bash
python backend/src/review_suggestions.py report.json --output consistency-review.md
```

Analyze a remote GitHub repository:

```bash
python backend/cli.py analyze-remote pallets/flask --max-commits 20
```

## Project Layout

```text
ConsistenCy/
+-- backend/
|   +-- cli.py                  # CLI entrypoint
|   +-- github_app_server.py    # GitHub App webhook server
|   +-- src/
|       +-- agents/             # specialist analyzers
|       +-- collaboration/      # vote and consensus coordinator
|       +-- evaluation/         # metric and ablation helpers
|       +-- github_app/         # installation and webhook support
|       +-- models/             # typed report contracts
|       +-- parsers/            # Python / JS / TS parsing helpers
|       +-- remote/             # GitHub API based analysis
|       +-- scoring/            # risk composition and explainability
|       +-- pipeline.py         # orchestration
|       +-- review_suggestions.py
+-- frontend/
|   +-- app.py                  # Flask dashboard API
|   +-- templates/
|   +-- static/
+-- docs/
|   +-- PROJECT_OVERVIEW.md
|   +-- output_schema.md
|   +-- EVALUATION.md
|   +-- REMOTE_ANALYSIS.md
|   +-- GITHUB_APP_SETUP.md
+-- evaluation/                 # optional evaluation workspace
+-- examples/                   # runnable demo inputs
+-- tests/
```

## Documentation

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [Output schema](docs/output_schema.md)
- [Evaluation workflow](docs/EVALUATION.md)
- [Remote repository analysis](docs/REMOTE_ANALYSIS.md)
- [GitHub App setup](docs/GITHUB_APP_SETUP.md)
- [Contributing](CONTRIBUTING.md)

## Testing

```bash
python -m pytest -q
node --check frontend/static/js/showcase.js
```

The current release-ready workspace passes the full Python test suite and browser-verifies the `/showcase` dashboard.

## GitHub Release Hygiene

Before publishing a branch or opening a PR:

```bash
python examples/multi_agent_demo.py
python -m pytest -q
node --check frontend/static/js/showcase.js
git status --short
```

Generated caches, local databases, evaluation result dumps, and cloned evaluation repos are ignored by default.

## Resume Pitch

Built a multi-agent PR review coordination system that compares code changes against project history, combines semantic, structural, security, style, duplication, and evolution signals, and produces explainable reviewer handoff plans with deterministic consensus and dashboard visualization.

## Status

ConsistenCy is a research prototype and portfolio project. Python analysis is the strongest path; JavaScript and TypeScript parsing are supported where tree-sitter dependencies are available. The scoring layer is deterministic by design so that behavior is reproducible and easy to evaluate.
