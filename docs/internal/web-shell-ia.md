# Locked desktop Shell IA

Status: implemented on `feat/web-cordis-agent-desktop` (user-confirmed skeleton; maturity polish in progress).

## Decision

ConsistenCy desktop chrome is a **three-column rounded shell** (warm off-white, large radii), inspired by calm ZCode / Claude Desktop product chrome — **not** a dark shadowed AI sidebar and **not** a VS Code activity-bar IDE.

Product purpose stays **evidence-grounded review harness**. Chat-thread-as-primary UI is rejected.

## Layout

| Column | Role |
| --- | --- |
| **Left** | Project search; **自动化** entry; **插件市场** entry; connected repositories list — each row has **仓库情况** + **仓库目录**; bottom **Settings** + **User** |
| **Center** | Review workbench for the selected repo: readiness, recent reviews/findings, diff/evidence hooks, primary CTA **开始审查** (header only — no bottom composer). Repo surfaces and `/runs/:id/*` render inside the same chrome. |
| **Right** | Related cards: current repo status, recent review, workflow binding, evidence summary (real query data when available; empty states OK). Stays visible on repo + run routes. |

## Interaction map (final)

| Control | Behavior |
| --- | --- |
| Left repo row click | Select repo → `/repositories/:id/overview`; remember selection |
| 情况 | Focus right **仓库情况** card + open overview |
| 目录 | Dialog of working-tree **已变更 / 未跟踪** sections; file click → `/repositories/:id/changes` with `{ highlightPath }` (row selected + scrolled + flash) |
| 自动化 / 插件 | Mature surfaces: manage real triggers (+ minimal create for manual/repo events); builtin analyzer registry from `@consistency/plugins-builtin` — no fake marketplace; cron / third-party store deferred |
| Header **开始审查** | Opens ReviewComposer when `canStartReview`; otherwise disabled with `blockingReasons[0]` as `title` |
| Workbench surface chips | Navigate to repo overview / changes / history / PRs / reviews / workflows |
| Recent review rows | `/runs/:id/overview` (three-column shell retained; related cards update for that run/repo) |
| Change preview rows | `/repositories/:id/changes` + `highlightPath` |
| Related card jumps | Overview / reviews list / workflows / evidence — real routes |
| Run **返回工作台** | Back to matched repo overview or `/inbox` |
| Top provenance chip | Opens Settings (LLM / API source of truth) |
| Settings / theme / locale | Left Settings + topbar theme/locale; shell chrome unchanged |
| Cmd/Ctrl+K | Command palette (Review, Automation, Plugins, Repos, Studio, Runs, Findings, Settings) |

## Explicitly rejected

- 「对话 \| 工作」 peer tabs
- Chat-thread-as-primary home
- Bottom status bar / bottom review-goal composer
- Left accent stripe on selected repo rows
- Inbox / Runs / Findings / Studio as peer primary nav spam (still reachable via Cmd+K, deep links, or Automation → Studio)

## Maturity notes (v3 shell polish)

- `/automation` → manage real saved automations (pause/resume), deep-link Studio → Triggers, minimal create for **manual** / **repository_event** when policy + workflow/runtime revisions exist; **cron scheduling documented as upcoming** (no fake running schedules)
- `/plugins` → builtin / installed analyzers from `@consistency/plugins-builtin` registry (+ engine allowlist kinds when catalog API is up); **third-party marketplace deferred** (no fake install store)
- Repo **目录** → lazy HEAD tree via `/repositories/:id/git/tree`; dirty overlay; **file content preview** via `/repositories/:id/git/file` (sandboxed local_git read, size cap, binary message, utf-8 / utf-8-lossy). Dirty files can open Changes + `highlightPath`
- Repo **情况** → focuses the right-rail status card and opens repo overview

## Cordis / boot

Cordis web-host boot remains. Shell chrome lives in `apps/web/src/shell/AppShell.tsx`; HashRouter unchanged. Kernel/API not rewritten.

## Screenshots

Overwrite under `artifacts/web-redesign/`:

- `01-inbox.png` — home / review workbench (filled demo)
- `02-repository-overview.png` — changes (or overview) with demo data
- `03-workflow-studio.png` — run overview inside shell when possible; else Studio

## Screenshots (maturity-3)

Overwrite under `artifacts/web-redesign/`:

- `01-inbox.png` — review workbench
- `06-directory-tree.png` — directory dialog
- `07-file-preview.png` — clean file content in directory preview pane
- `08-automation.png` — automation page with real trigger management
- `09-plugins.png` — builtin analyzers registry
