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

## Public Demo

The `/showcase` route is the recommended GitHub demo surface. It uses deterministic example files from `examples/` and renders a dashboard with:

- board decision and risk gauge
- normalized signal contribution chart
- specialist vote cards
- consensus flow
- evidence chain
- reviewer handoff queue

Run it locally with:

```bash
python frontend/app.py
```

Open `http://127.0.0.1:8000/showcase`.

## Web And Data Visualization Surface

The dashboard is built as a real product screen rather than a static mockup:

- `GET /showcase` renders the portfolio-ready agent board.
- `GET /api/demo/collaboration` returns deterministic demo data for the board.
- `frontend/static/js/showcase.js` draws the risk gauge and signal contribution chart on canvas.
- `frontend/static/css/showcase.css` owns responsive dashboard layout and visual tokens.

The visualization intentionally focuses on reviewer operations: risk decision, normalized signal weight, agent vote confidence, evidence trace, and handoff queue.

## Figma Handoff Notes

When a Figma workspace is available, recreate the showcase screen with these constraints:

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
- The backend is organized around stable product surfaces: CLI, Flask API, GitHub App server, report rendering, and evaluation helpers.
- The dashboard is intentionally operational rather than marketing-heavy: it is meant to look like a real review board, not a landing page.
