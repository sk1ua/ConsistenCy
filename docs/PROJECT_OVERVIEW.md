# Project Overview

ConsistenCy frames pull request review as a multi-signal coordination problem. Each specialist deterministic analyzer owns one review perspective, emits evidence, and lets a deterministic coordinator convert those findings into a shared decision. An optional LLM review pass can augment the analyzers when configured.

## Review Flow

```text
git diff -> specialist agents -> normalized evidence -> weighted consensus -> reviewer handoff
```

1. The pipeline loads changed files and a project-specific baseline from history.
2. Specialist agents score drift from their perspective.
3. The scoring layer normalizes signal contributions and confidence.
4. The collaboration coordinator asks each agent to vote.
5. The final report ranks risky files and assigns human review focus.

## Core Signals

| Signal | What it catches |
| --- | --- |
| `style` | naming, docstring, and convention drift |
| `structural` | import surface, coupling, inheritance, module shape |
| `semantic/behavioral` | behavior-level and API usage changes (proxy signals) |
| `duplication` | repeated implementation and clone risk |
| `security` | hardcoded secrets, unsafe calls, injection-like patterns |
| `evolution` | churn, hotspots, ownership, and history anomalies |

## Consensus Protocol

The coordinator produces:

- `votes`: one vote per specialist agent
- `quorum`: participating agents over expected agents
- `decision`: `approve`, `monitor`, `request_changes`, or `block_merge`
- `top_findings`: highest-priority evidence snippets
- `review_queue`: suggested human review ownership
- `disagreements`: signals that conflict or need manual attention

Security evidence can override lower-priority signals. Structural and semantic drift receive more weight than style-only drift. This keeps the output closer to how real code reviews are triaged.

## Product Surfaces

The supported user-facing surfaces are:

- `apps/web`: React/Vite WebApp for dashboard, job history, report detail, and runtime settings.
- `apps/api`: TypeScript API and GitHub App webhook receiver.
- `POST /github/webhook`: signed GitHub App webhook entrypoint for PR review jobs.
- `backend/cli.py`: retained Python CLI for deterministic analysis, evaluation, and the TypeScript compatibility bridge.

Run the product UI locally with:

```bash
npm run dev:api
npm run dev:web
```

Open `http://127.0.0.1:5173`.

The retired Flask dashboard and Python/Flask GitHub App server were removed so
the project has one WebApp and one webhook implementation.

## Figma Handoff Notes

When a Figma workspace is available, recreate the WebApp review dashboard with these constraints:

| Token | Value | Usage |
| --- | --- | --- |
| `surface/background` | `#f5f7f4` | page background |
| `surface/panel` | `#ffffff` | dashboard panels |
| `text/primary` | `#17201b` | headings and high-emphasis text |
| `text/muted` | `#627069` | secondary labels |
| `border/default` | `#dbe2dd` | panel borders and chart grid |
| `signal/style` | `#2f78ba` | style signal |
| `signal/structural` | `#16878a` | structural signal |
| `signal/semantic` | `#1f9d73` | semantic signal |
| `signal/duplication` | `#c98719` | duplication signal |
| `signal/security` | `#cf4a3a` | security signal |

Recommended frames:

- Desktop: `1440 x 1024`, left sidebar `260px`
- Tablet: `1024 x 900`
- Mobile: `390 x 1200`

Use component instances for sidebar, topbar, decision panel, signal chart, agent vote card, finding card, and handoff card. Keep all panel and control radii at `8px`.

## Design Notes

- The project favors deterministic scoring over opaque ranking models so reports are reproducible.
- The backend is organized around stable product surfaces: TypeScript API, GitHub App webhook handling, retained Python analysis CLI, report rendering, and evaluation helpers.
- The WebApp is intentionally operational rather than marketing-heavy: it is meant to look like a real review board, not a landing page.
