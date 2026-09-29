# Repository Review Notebook

> **This is an API-layer capability.** The Notebook is implemented in `apps/api/src/notebook/`, and the repository ships **no interface** for it: the Web UI and the desktop host were removed, and nothing in this repository replaces them. The only supported way to use the Notebook today is the authenticated HTTP endpoints of the API daemon (`npm run dev:api`). Everything below describes API-layer semantics, not a screen.

The Repository Review Notebook is an evidence-grounded research workspace designed to help developers inspect and explore the architectural impact and risk boundaries of pull requests.

---

## 1. Operating Modes

These are API-layer source-authority modes: they decide which authority reads the review source and whether a run has a publication side effect. They do not describe a repository-provided interface.

| Mode | Source Authority | LLM Provider | Side Effects |
|---|---|---|---|
| **Public Read — Anonymous** | Public GitHub REST API & anonymous Git clone | DeepSeek, OpenAI, or Anthropic | Creates read-only analysis Job; never publishes comments |
| **Public Read — PAT** | Server-side read-only PAT | DeepSeek, OpenAI, or Anthropic | Creates read-only analysis Job; never publishes comments |
| **Webhook Review** | GitHub App installation token | DeepSeek, OpenAI, or Anthropic | Evaluates pull request and follows configured publication policy |

---

## 2. Source Boundaries & Provenance

The Notebook binds strictly to an immutable repository snapshot:

$$\text{Source Key} = \text{repository} + \text{pullRequestNumber} + \text{jobId} + \text{baseSha} + \text{headSha}$$

- **Strict Citation**: Citations explicitly record file path, line numbers, head SHA, and verified code excerpts.
- **SHA-Isolated Indices**: Repository snapshot indices are keyed by `repository + headSha`. Local `repoPath` reviews add the job to the key (`headSha:job:<jobId>`), so two local reviews of the same Git SHA never share one mutable checkout index. Working tree modifications or alternate PR branches never collide.

---

## 3. Read-Only Tool Primitives

The Notebook gathers evidence through the read primitives exported by `apps/api/src/notebook/tools.ts`. Every one of them reads against the pinned snapshot and none of them modifies the workspace:

| Primitive | What it does |
|---|---|
| `searchRepository(selection, query, maxResults = 6)` | Path, symbol, and import scoring plus text search over the indexed snapshot manifest, returning matches with citations. |
| `readRepositoryFile(selection, file, startLine = 1, endLine = 80)` | Line-budgeted file inspection. A line range outside the pinned content is reported as a labeled boundary (`LINES_NOT_AVAILABLE`) instead of being padded or summarized. |
| `getDiff(selection)` | The PR change set, resolved as `git diff --no-ext-diff --unified=3 <base>...<head>` (merge-base semantics) inside the snapshot root and capped at 512 KiB. Working-tree reviews replay the persisted review-time snapshot diff instead. |
| `getBaseFile(selection, file)` | The reviewed base revision, read from the pinned git object (`<baseSha>:<path>`, capped at 256 KiB). Requires a repository-relative path and refuses secret paths and binary content. |
| `getEvidencePack(selection)` / `getReviewFindings(selection)` | The persisted deterministic Evidence Pack and the findings of the review job. |
| `generatePatchRequest(selection, file, instruction)` | Builds a patch *request* for a file present in the selected SHA and returns it with `writesWorkspace: false`. No diff is applied, and no workspace file is written. |
| `dedupeCitations(...)` / `validateNotebookAnswer(...)` | Citation de-duplication and boundary validation: an answer whose citations leave the selected job and head-SHA boundary is rejected rather than shown. |

`apps/api/src/notebook/graph.ts` invokes these primitives itself before a run reaches the model; only `search_repository` and `generate_patch` are surfaced to SSE clients as `tool.started` / `tool.result` events.

> **Execution Boundary**: The Notebook model has no shell access, no arbitrary code execution capability, no filesystem write privileges, and cannot post comments to GitHub. The only subprocesses the Notebook's own server-side code runs are the non-interpreted `git diff` and `git show` reads listed above, with the working directory fixed to the pinned snapshot root.

---

## 4. Analysis Cards

Cards are requested by kind: `change_map`, `architecture_impact`, `risk_brief`, and `fix_plan`.

1. **Change Map**: File and module alteration boundaries.
2. **Architecture Impact**: Evidence-backed explanation of module and dependency shifts.
3. **Risk Brief**: Summary of deterministic risk signals and findings.
4. **Fix Plan**: Prioritized recommendations, testing suggestions, and unapplied diff previews.

When evidence is insufficient, the Notebook explicitly states that the context cannot be verified rather than extrapolating speculative conclusions.

---

## 5. HTTP Surface

All Notebook endpoints are authenticated. When the Notebook is disabled through `CONSISTENCY_NOTEBOOK_ENABLED`, the `/notebooks/*` routes answer `404 NOTEBOOK_DISABLED`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/notebooks/:id` | Read one notebook record. |
| `GET` | `/notebooks/:id/sources` | Read the pinned repository, PR, and base/head SHA sources of a notebook. |
| `POST` | `/notebooks/:id/messages` | Ask a question; the run streams over SSE. |
| `POST` | `/notebooks/:id/cards` | Generate an analysis card; the run streams over SSE. |
| `GET` | `/jobs/:id/notebook` | Resolve the notebook id bound to a review job (`notebookId: null` when there is none). |

Message and card runs require a configured real LLM provider (DeepSeek, OpenAI, or Anthropic); without one the run fails with `LLM_NOT_CONFIGURED`.
