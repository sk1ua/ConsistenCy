# ConsistenCy

**ConsistenCy is a repository-native Agent Harness for evidence-grounded code review.**

Instead of submitting raw diffs to an LLM and hoping for useful prose, ConsistenCy combines deterministic AST and security analyzers, capability-gated agent scheduling, structured Context VM paging, and real LLM reasoning into reproducible, evidence-backed Review Reports.

[![CI](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml/badge.svg)](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml)

---

## What Problem Does ConsistenCy Solve?

Traditional LLM-based code review suffers from three structural flaws:
1. **Hallucination & Lack of Evidence**: Models produce freeform text with no verifiable grounding in AST structure, symbol definitions, or security invariants.
2. **Uncontrolled Agent Execution**: Multi-agent review systems often run arbitrary tools and shell commands without capability authorization or execution domain isolation.
3. **Context Pollution**: Monolithic prompts concatenate entire diffs and files, blowing token budgets and degrading model reasoning.

ConsistenCy solves this by dividing review into three collaborating subsystems:

$$\text{ConsistenCy v3} = \text{Kernel} + \text{Cordis Harness} + \text{Evidence Engine}$$

- **Repository-Aware Execution**: The Repository is the root object, linking local Git checkouts, branches, and diffs with remote GitHub Pull Request context.
- **Capability-Secured Runtime**: The Kernel defaults to deny. Every agent operation (file read, AST query, LLM call, GitHub publish) requires an unrevoked capability handle mediated by the `SyscallGateway`.
- **Semantic Context VM**: Immutable `ContextPage`s (SHA-256 hashed), Copy-On-Write (COW) page tables for subagents, and token-budgeted `WorkingSet` projections.
- **Deterministic Evidence**: Grounding facts are extracted by Tree-sitter AST queries, secret detectors, and deterministic analyzers before LLM synthesis occurs.

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            React / Vite Web UI                              │
│         (Repository Workspace, Overview, Diff, Evidence, Runtime)          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP / SSE / Same-Origin /api
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           apps/api (Host Process)                           │
│        (HTTP Router, SQLite Store, Workload Runtime, Electron Host)         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
     ┌─────────────────────────────────┼─────────────────────────────────┐
     │ Kernel Tier (@consistency/kernel)                                 │
     ▼                                 ▼                                 ▼
┌──────────────┐             ┌──────────────────┐             ┌─────────────────────┐
│ Run &        │             │ SyscallGateway & │             │ Context VM &        │
│ Scheduler    │             │ CapabilityBroker │             │ Evidence Store      │
└──────┬───────┘             └────────┬─────────┘             └─────────────────────┘
       │                              │
       ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 Harness Tier (@consistency/harness-core)                     │
│         (Cordis Fiber Lifecycle, CapabilityLifecycleAdapter, Bridges)       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Workload Tier (@consistency/workload-review)                   │
│        (ReviewWorkload: Supervisor Planner + Specialized Review Agents)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 ▼                                           ▼
      In-Process Built-ins                         Child-Process Sandbox
  (Supervisor / Review Agents)                  (Untrusted Plugins via RPC)
```

---

## Quick Start (Web & API)

### Prerequisites
- Node.js 22.x
- Python 3.12.x

### 1. Install Dependencies
```bash
npm ci
python -m pip install -r requirements-lock.txt
```

### 2. Configure Environment
```bash
cp .env.example .env
```

### 3. Start Development Services
```bash
# Terminal 1 — Start the API (http://127.0.0.1:8787)
npm run dev:api

# Terminal 2 — Start the Web UI (http://127.0.0.1:5173)
npm run dev:web
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) in your browser.

---

## Electron Desktop Mode

ConsistenCy provides a native Windows desktop host that packages the Web UI and API into a single local application with native folder selection:

```powershell
# Run desktop in development
npm run desktop:dev

# Package Windows desktop binaries (unpacked & NSIS installer)
$env:CONSISTENCY_PYTHON_BUNDLE_ROOT = "C:\path\to\Python312"
npm run desktop:pack
```

Packaged desktop builds store persistent SQLite databases and configuration under `app.getPath("userData")`, requiring zero writes to installation directories.

---

## Configuring an LLM Provider

ConsistenCy v3 is a **real-LLM-only runtime** (no demo/mock runtime modes). Review execution and Notebook reasoning require configuring a supported model provider:

- **DeepSeek**: Set `DEEPSEEK_API_KEY` (and optional `DEEPSEEK_MODEL`, default: `deepseek-v4-flash`).
- **OpenAI**: Set `OPENAI_API_KEY` (and optional `OPENAI_MODEL`, default: `gpt-4.1-mini`).

You can configure keys directly in the Web/Desktop **Settings** page, via CLI (`npm run config -- set llm.deepseek-api-key`), or through `.env`. When running without an LLM configured, local repository and Git browsing remain fully accessible; review runs are disabled until credentials are provided.

---

## Connecting a Repository

1. **Local Git Checkout**: In Desktop mode, click **Connect Repository** and use the native folder picker to select any local Git worktree. In Web mode, configure `CONSISTENCY_LOCAL_REVIEW_ROOTS`.
2. **Public GitHub Pull Request**: Paste any public PR URL (e.g. `https://github.com/owner/repo/pull/123`) into the Public PR input. The review runs in read-only mode without requiring GitHub App installation.
3. **GitHub App Webhook Review**: Configure `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` to receive webhooks and post review comments automatically.

---

## Documentation Directory

- **[System Architecture](docs/architecture.md)** — Kernel capabilities, Cordis harness, Context VM, and invariant matrix.
- **[Security Model & Isolation Boundaries](docs/security.md)** — Capability broker, logical rings vs. execution domains, and child-process sandbox limits.
- **[Repository Workspace Model](docs/repository-workspace.md)** — Repository-first product model and authoritative source rules.
- **[Review Runtime & Context VM](docs/review-runtime.md)** — Detailed review execution pipeline and Context VM paging.
- **[Configuration Reference](docs/configuration.md)** — LLM providers, precedence rules, and persistence paths.
- **[Electron Desktop Host](docs/desktop.md)** — Desktop host architecture, IPC boundary, and packaging.
- **[HTTP API Reference](docs/api.md)** — Endpoints, authentication, and payload schemas.
- **[Output Schema](docs/output_schema.md)** — Structure of ReviewReport and evidence models.
- **[GitHub App Setup](docs/GITHUB_APP_SETUP.md)** — Setting up webhooks and App credentials.
- **[Evaluation Guidelines](docs/EVALUATION.md)** — Dataset schemas and benchmark reproduction.

---

## Verification & Testing

```bash
# Verify TypeScript types across all workspaces
npm run typecheck

# Run all TypeScript unit and integration tests (700+ tests)
npm test

# Run deterministic Python analyzer test suite (280 tests)
python -m pytest -q

# Run Playwright Electron desktop tests
npm run test:desktop

# Run full baseline verification suite
npm run verify
```
