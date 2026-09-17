# Locked desktop Shell IA

Status: implemented on `feat/web-cordis-agent-desktop` (user-confirmed skeleton).

## Decision

ConsistenCy desktop chrome is a **three-column rounded shell** (warm off-white, large radii), inspired by calm ZCode / Claude Desktop product chrome — **not** a dark shadowed AI sidebar and **not** a VS Code activity-bar IDE.

Product purpose stays **evidence-grounded review harness**. Chat-thread-as-primary UI is rejected.

## Layout

| Column | Role |
| --- | --- |
| **Left** | Project search; **自动化** entry; **插件市场** entry; connected repositories list — each row has **仓库情况** + **仓库目录**; bottom **Settings** + **User** |
| **Center** | Review workbench for the selected repo: readiness, recent reviews/findings, diff/evidence hooks, primary CTA **开始审查**. Optional bottom composer is **only** “describe review goal / start review” orchestration (ReviewWizard / ReviewComposer APIs) — **not** a conversational agent chat log |
| **Right** | Related cards: current repo status, recent review, workflow binding, evidence summary (real query data when available; empty states OK) |

## Explicitly rejected

- 「对话 \| 工作」 peer tabs
- Chat-thread-as-primary home
- Inbox / Runs / Findings / Studio as peer primary nav spam (still reachable via Cmd+K, deep links, or Automation → Studio)

## Stubs (honest)

- `/automation` and `/plugins` → EmptyState “即将接入” (no fake marketplace data)
- Repo **目录** → panel listing working-tree changed/untracked paths until a full tree API exists
- Repo **情况** → focuses the right-rail status card and opens repo overview

## Cordis / boot

Cordis web-host boot remains. Shell chrome lives in `apps/web/src/shell/AppShell.tsx`; HashRouter unchanged. Kernel/API not rewritten.

## Screenshots

Overwrite under `artifacts/web-redesign/`:

- `01-inbox.png` — home / review workbench
- `02-repository-overview.png` — selected repo
- `03-workflow-studio.png` — Studio still reachable (Automation stub link or Cmd+K), not peer nav
