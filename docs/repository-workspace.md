# ConsistenCy Repository Workspace Model

ConsistenCy v4 is built around a **repository-first product model**. In this model, the **Repository** is the root organizational entity:

> **Version note**: this document describes the current **v4 (terminal-only)** checkout. The product lineage name is still v3 (see the frozen [CONSISTENCY_V3_MASTER_SPEC.md](CONSISTENCY_V3_MASTER_SPEC.md)); v4 deleted the Web UI and the Electron desktop host, keeping the CLI and the headless HTTP daemon. Differences: [delivery-readiness.md](delivery-readiness.md).

$$\text{Repository} \longrightarrow \text{Git / PR Context} \longrightarrow \text{Review Run} \longrightarrow \text{Agent Execution} \longrightarrow \text{Evidence / Findings} \longrightarrow \text{Human Decision}$$

---

## 1. Authoritative Source Composition

A Repository Workspace unifies multiple sources of truth for a single canonical software repository:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Repository Workspace                            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌───────────────────────────┐                         ┌───────────────────────┐
│     Local Git Checkout    │                         │  Remote GitHub Metadata│
│ (Authoritative for Branch,│                         │ (Authoritative for PR │
│   HEAD, Working Tree,     │                         │  Metadata, Reviews,   │
│   Diffs, Local Commits)   │                         │  Discussions, Status) │
└───────────────────────────┘                         └───────────────────────┘
```

### 1.1 Source Authority Boundaries
- **Local Git Repository**: The local directory checkout is the sole authority for current Git branches, working tree dirty status, local commit history, base/head SHAs, and file contents.
- **GitHub REST API / Webhooks**: Remote GitHub services are the sole authority for Pull Request lifecycle states, review comments, issue associations, and remote collaboration metadata.

### 1.2 Truthful PR Association
ConsistenCy adheres to strict data-provenance rules:
- **Never Infer PR History**: Pull Request associations are obtained **only** from authoritative GitHub API data or authenticated Webhook payloads.
- **Forbidden Inferences**: PR numbers and boundaries are **never** guessed or inferred from commit message titles (e.g. `Merge pull request #123`), branch names (e.g. `feat/pr-45`), or merge commit topologies.
- **Unavailable States**: When GitHub metadata is unavailable (such as offline local-only repositories, unauthenticated public PRs, or API rate limits), the workspace presents the local Git state faithfully and marks remote PR metadata as explicitly unlinked or unavailable, rather than fabricating synthetic connections.

### 1.3 Repository Authority and Selectors
- The API uses the opaque registered `Repository.id` as the repository authority.
- A repository lookup requires an exact registration in the audit store. Display names, remote names, `local:` aliases, heartbeat roots, project-root shortcuts, relative paths, and absolute paths are not selectors.
- Local filesystem locators remain server-only. They are resolved only for an exact registered record whose source is `local_git`, and are never returned in API responses.
- Repository-scoped API requests therefore carry the registered ID, not a path or a display label.

### 1.4 Safe Remote Projection
Git remote data crossing into API responses has exactly this shape:

```json
{"name": "origin", "githubFullName": "owner/repository"}
```

`githubFullName` is optional. Raw fetch URLs, raw push URLs, and embedded credentials never cross into API responses.

---

## 2. Shipped Surfaces

ConsistenCy is terminal-first, and the repository ships no web interface and no desktop host. The CLI is the only product entry point:

- `npm run consistency` runs `apps/cli/src/main.ts`. It has exactly two commands, `review` and `help`; an unknown command exits with code 2.
- `npm run review` runs the same entry point with the `review` command.
- `review --repo <路径>` names the checkout to review (default: the current directory) and renders the ReviewReport to the terminal, or prints the full machine-readable report with `--json`.

Exit codes are the CI contract: `0` — the review ran and nothing met the threshold; `1` — the review ran and the threshold was met (usable as a gate); `2` — the review did not run, or its coverage was incomplete (not trustworthy as a gate).

Rendering keeps one rule: what could not be checked is more prominent than what was. Constraint blocks always appear — `[!]` means that section was not checked this run (which is not the same as checked and clean), and `[~]` means it was checked with an incomplete evidence chain. Two independent risk measures are shown side by side and are never merged: `score`/`riskLevel` come from the deterministic static analysis, while `riskBand` is the severity band of the final findings. When coverage is missing, no green check is printed; the report states only that this run recorded no coverage.

The HTTP API in `apps/api` remains a headless HTTP, queue, and persistence layer with no interface of its own, and the Notebook surface (`apps/api/src/notebook/`) is API-only: this repository provides no UI for it.

---

## 3. Connecting a Local Checkout

A local review connects a checkout through the CLI, not through a native folder picker:

1. `--repo <路径>` names the local checkout; the default is the current directory.
2. The path is resolved to an absolute path and must exist and be a directory. Otherwise the run fails during preflight, before any model call, and exits 2.
3. A checkout without a `.git` marker still reviews, but only as opaque text: the run warns that range diff and Git evidence are unavailable, rather than producing a report that looks like a normal review.
4. The CLI constructs the shared review runtime in-process (`createReviewRuntime`, the same implementation the API daemon uses) with an in-memory job store, so a local review needs neither a repository registration nor a running daemon.
5. The job it enqueues carries `accessMode: "local_git"`, the review scope (a `--base`/`--head` commit range, or the working tree when no range is given), and the checkout directory basename as the repository label.

Separately, the HTTP layer still exposes a privileged server-side registration route for local checkouts (`POST /internal/repositories/local`) that accepts a path and returns the sanitized `Repository` DTO; the ordinary repository route refuses `local_git` input, so a local path can never be registered through the public API surface. With the desktop host removed, no part of this repository drives that route automatically.

A `--repo` path is a direct CLI input, not a repository selector: it never resolves a registered record and does not relax the selector rules in §1.3.

## 4. Pull Request Lifecycle Authority

- GitHub remains authoritative for Pull Request lifecycle state. Provider `state` is `open` or `closed`.
- `closedAt` and `mergedAt` are required nullable metadata. Open rows have neither timestamp; closed rows require `closedAt`; merged rows are closed rows with non-null `mergedAt`. Lifecycle timestamps cannot predate creation, and merge cannot follow closure. The merged display state is derived only when `state` is `closed` and `mergedAt` is non-null.
- ConsistenCy never infers a Pull Request's merged state from local Git history, merge commits, branch topology, or commit messages.

For workspace Pull Request listing, credential candidates are attempted in this exact order:

1. GitHub App installation token, when available.
2. Configured server-side public-read token.
3. Anonymous access.

Candidates are deduplicated and each candidate is attempted at most once. A malformed provider payload is reported as invalid provider data and is not retried as a credential failure. Public repository connection follows the same fail-closed rule: only typed GitHub API/access failures advance to another credential candidate. Rate limiting is classified consistently for HTTP 429, exhausted 403 responses, and 403 responses carrying a valid `Retry-After`. `Retry-After` accepts only non-negative decimal delta-seconds or strict IMF-fixdate values; locale dates, ISO dates, obsolete HTTP-date forms, and date-like strings are rejected. This workspace listing behavior is separate from standalone public PR URL ingestion, which remains read-only and does not use GitHub App credentials merely because an App is configured.

A workspace Pull Request listing performs one provider-authoritative GitHub request and asks for the newest Pull Requests first, returning at most 100 summaries. Available responses carry the server-resolved canonical `repositoryFullName`; an external link is created only when the PR URL equals the exact raw canonical reconstruction and matches that identity and PR number, and the value is plain text otherwise. Dot segments, parent-segment normalization, backslashes, percent encoding, and other WHATWG normalization differences fail closed through the shared schema/provider parser. A `page.truncated` flag states whether GitHub advertised an older page; when true, the response says only that the most recent 100 are shown and never claims a total. `latestReview` is resolved by an exact bounded store lookup over only those returned PR numbers, matching the canonical opaque `repositoryId` and PR-review kind. The memory and SQLite adapters return one latest job per number; SQLite performs one bounded query, so an older requested PR remains associated even after more than 200 newer jobs for another PR. Legacy unassociated jobs, other repositories, and non-PR jobs are ignored. This phase has no background polling, synchronization, automatic loading of older records, or infinite scrolling. The summaries remain public read-only metadata: no comments, labels, status, merge state, or other provider data can be published or mutated.

## 5. Repository Workflows (CKPT3 Phase 3)

Workflow bindings are an API-level surface of the repository workspace; no UI for them ships in this repository.

- Bindings: each registered repository can enable/disable any persisted
  workflow definition (builtin seed or user drafts). Enabling is an explicit
  user action; registration never auto-enables.
- Manual trigger: resolves the definition's latest VALIDATED revision at
  trigger time, pins the repository's current HEAD as a SHA-fixed snapshot,
  and executes through the canonical Kernel/Harness chain. Disabled or
  missing bindings, deleted definitions, or draft-only definitions fail
  closed with sanitized errors before any run is created.
- Run history: filtered by the canonical opaque repository id; run details
  carry the pinned revision, snapshot identity, evidence summaries, and
  findings. There is exactly one workflow product object (Master Spec §17).
- Bindings are data, not authorization: every protected operation is still
  authorized per-syscall by the Kernel at execution time.

## 6. Repository Reviews (CKPT3 Phase 4)

Repository review history is served by the API (`GET /repositories/:id/reviews`); no UI for it ships in this repository.

- Association truth: a ReviewJob belongs to a repository only through the
  canonical opaque `repositoryId` persisted at job creation (the local
  review path carries it end-to-end). This closes the §27.6 debt pattern for
  NEW jobs: no display-name / remote-name / basename inference anywhere.
- Legacy jobs without a canonical association simply never appear in
  per-repository lists (honest missing-association, per owner decision D1).
- Every consumer of repository review history uses the same canonical
  repository-reviews query and filters only exact opaque `repositoryId`
  equality. Display name, remote full name, repository name, and legacy-name
  fallbacks are not association mechanisms, including when two registered
  repositories share the same display or remote text.
- The shared `{ repositoryId, reviews }` response is strict and bounded to 200
  rows. The API validates it on egress: response identity must match the
  requested opaque ID and every row must carry that same ID. A malformed
  response fails closed with a fixed non-leaking error.
- The list exposes only fields that truly exist on the job/report DTO —
  status (existing vocabulary), created/finished timestamps, model
  provenance (llmProvider/llmModel as persisted), source (PR number /
  working tree), and the report's score/riskLevel when a report exists.
  Absent fields are absent; risk scores are triage signals.
- Empty (no associated reviews yet) and unavailable (load failure) are
  distinct states.
