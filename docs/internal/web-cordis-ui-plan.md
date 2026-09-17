# Web Cordis + UI package plan

Status: implemented on `feat/web-cordis-agent-desktop` (Cordis boot path + thin `@consistency/ui` extraction).

## Goals

- Cordis owns composition and lifecycle for the web renderer host.
- React remains the renderer (HashRouter unchanged).
- Shared design-system primitives live in `@consistency/ui`.
- Dense agent-desktop language from `web-reengineering-design.md`.

## Package map

| Package | Role |
| --- | --- |
| `@consistency/ui` | Design-system components + tokens CSS. Apps re-export via `apps/web/src/design-system/*` shims. |
| `@consistency/web-host` | Cordis `Context` boot, `ui.*` extension registries, React `Slot` / `Outlet` / `WebHostProvider`. |

## Cordis services (`ui.*`)

Provided on the root context by `createWebHost()`:

- `ui.nav` — primary navigation contributions
- `ui.commands` — command palette contributions
- `ui.routes` — route contribution registry (extension seam; HashRouter still authoritative)
- `ui.inspector` — selection inspector contributions
- `ui.status` — status-bar contributions
- `ui.slots` — named React slots (`shell`, `sidebar`, `workspace`, `inspector`, `status`, `legacy`)

## Plugin map (apps/web)

Boot order in `apps/web/src/main.tsx`:

1. `uiServicesPlugin` — asserts `ui.*` registries are present
2. `createLegacyAppPlugin` — seeds default nav + marks the legacy App surface
3. `createShellPlugin` — agent-desktop shell status metadata

The React tree mounts `<App />` inside `WebHostProvider` + existing Theme/I18n/Query/HashRouter providers.

## Visual targets (this pass)

- Icon-forward sidebar (Inbox / Repositories / Runs / Findings / Workflows)
- Workflows route meta title is **Workflows** (not “builder”)
- Runtime Studio desktop layout: **Library | Canvas | Copilot**
- Studio nodes use Lucide icons; graph layout uses `dagre` for readable DAGs

## Deferred

- Full extraction of AppShell into a Cordis-owned shell plugin with Slot-rendered chrome
- Moving all page routes into `ui.routes` contributions
- Dark/light screenshot matrix for every repository sub-route
