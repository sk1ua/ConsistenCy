# ConsistenCy v3 Web Re-engineering Design

Status: Checkpoint 1 specification; implementation remains limited to the global shell and Repository Overview.

## Product Boundary

ConsistenCy is a repository-first, evidence-grounded review harness. The web application should make the repository, its reviewable sources, and the resulting evidence legible without turning the primary surface into a chat client or a marketing dashboard.

The renderer is a read-and-orchestrate client. Repository identity, Git state, review preparation, model availability, and blocking reasons are server-owned facts. The UI may compose those facts into navigation and actions, but it must not infer review eligibility from a local approximation.

## Checkpoint 1 Scope

Checkpoint 1 covers:

- one persistent application shell with a repository anchor;
- location breadcrumbs and global actions;
- a selection-driven inspector that is absent when no item is selected;
- compact runtime/status provenance;
- Repository Overview with repository identity, source/trust badges, branch/HEAD state, review readiness, recent reviews, and recent commits;
- light/dark theme and English/Chinese labels already supported by the application;
- focused tests, type diagnostics, production build, and visual screenshots.

The checkpoint explicitly does not implement or redesign Changes, History, Pull Requests, Review Composer/Workspace, Diff, Evidence, Runtime, Notebook, Workflow, or Settings. Those routes may remain reachable, but they are not acceptance targets for this pass.

## Information Architecture

### Global Shell

The shell has one left sidebar, one top location bar, one scrollable workspace, and one compact bottom status bar:

1. The sidebar is 230px wide and contains the ConsistenCy/v3 brand, current repository anchor, primary navigation, and daemon heartbeat.
2. The top bar contains the breadcrumb, command palette entry (`Ctrl+K` / `Cmd+K`), locale toggle, theme toggle, and refresh action.
3. The workspace owns route content. It must remain the dominant surface and must not be squeezed by a permanent empty inspector.
4. The bottom bar exposes branch, real LLM provider/model provenance, API connectivity, and desktop build identity.

Primary navigation is `Inbox`, `Repositories`, `Runs`, `Findings`, `Workflows`, and `Settings`. Repository-local navigation is a tab row owned by the repository route, not a duplicate sidebar tree.

`Inbox` is the cross-repository triage surface for incoming review work and alerts. `Repositories` is the source-of-truth workspace for connected repository identity, Git state, and repository-local review actions; it is not an alias for Inbox.

### Repository Overview

The overview hierarchy is intentionally flat and dense:

1. Repository header: display name, source kind, trust level, branch, short HEAD SHA, dirty-file state, and `Start Review`.
2. Local repository tabs: `Overview`, `Changes`, `History`, `Pull Requests`, `Reviews`, and `Workflows`.
3. Review readiness strip: the authoritative `canStartReview` state, working-tree/branch source summary, and an action that opens the review confirmation dialog.
4. Two adjacent sections: recent reviews and recent commits. Rows use dividers and compact metadata rather than nested card stacks.

## Action Grammar

- Navigation uses `SidebarRow`, `Tabs`, `Breadcrumb`, and route links. Internal actions are not underlined text links.
- Commands use `Button` variants with explicit labels and icons. Primary execution is visually distinct but remains compact.
- Small global actions use `IconButton` with accessible labels and tooltips.
- Selectable review, finding, agent, or commit rows open the inspector; the inspector is 0px/hidden until selection exists and can be closed with its close button.
- External documentation, when added in later checkpoints, must use an explicit external-link treatment.

## Visual Language

The visual target is a dense developer workbench rather than a dashboard:

- light background `#f6f8f5`, dark background `#0b0d10`;
- neutral surfaces with restrained borders and a single blue primary accent;
- success, warning, danger, and neutral status colors used consistently for readiness and job states;
- 11px monospace metadata, 12px secondary text, 13px navigation/body text, 14px section labels, and 17-18px repository titles;
- 28-32px icon controls, 32-36px buttons, 30-32px navigation rows, and 5-6px radius;
- no large hero banner, chat-first canvas, card-in-card stacks, or permanent right-side placeholder.

The reference audit in [`web-reference-audit.md`](./web-reference-audit.md) records the adopted and rejected patterns from DeepSeek Harness, cdesktop/Claude Code Desktop, and OpenCode Desktop.

## Data Contract

The shared schemas are authoritative:

- `reviewPreparationResponseSchema` (`packages/schema/src/api.ts`) supplies repository identity, source kinds, trust, working-tree/branch/PR availability, default model, provider configuration, `canStartReview`, and `blockingReasons`.
- `repositoryGitStatus` supplies the current branch, HEAD SHA, dirty-file count, and read-only Git status.
- `repositoryCommits` supplies typed `VcsCommitSummary` rows with full SHA, author, authored time, and message. The UI may render a seven-character SHA badge, but must not replace the server response with fabricated commit data.
- `ReviewJob` and embedded/report data supply recent review status and score. Missing data renders an empty state, not a demo or mock badge.

The review confirmation action is disabled when `canStartReview` is false. The UI should expose the blocking state through the readiness strip/dialog rather than silently attempting a request.

## Acceptance Criteria

Checkpoint 1 is ready for human visual approval when:

1. The shell has one repository-first sidebar, correct breadcrumbs, global command palette shortcut handling, theme/locale controls, and no obsolete duplicate chrome.
2. The repository overview renders real repository, Git, preparation, review, and commit data, including clean/dirty and configured/unconfigured model states.
3. No renderer payload exposes provider keys, GitHub credentials, bearer tokens, authorization headers, or local absolute paths.
4. Changed TypeScript files have clean diagnostics; focused tests and the web production build pass.
5. Desktop and web screenshots show the intended light and dark shell/overview at desktop width without clipping or accidental placeholder surfaces.

Human visual approval remains `pending` after automated verification. Later route work must not begin until that approval is recorded.
