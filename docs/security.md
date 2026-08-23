# ConsistenCy Security Model & Isolation Boundaries

This document defines the truthful security model, authorization mechanisms, and isolation boundaries of ConsistenCy v3.

---

## 1. Core Security Guarantees & Verification Matrix

The v3 runtime enforces capability-based security at the Kernel tier and isolates untrusted plugin execution into dedicated child processes. The six core security dimensions are:

| Security Dimension | Enforcement Mechanism | Current Status |
|---|---|---|
| **Syscall Authorization** | `CapabilityBroker` & `SyscallGateway` default-deny, per-call evaluation | **ENFORCED** |
| **External Commit Gating** | `CommitCoordinator` intercepts and gates `github.publish` & `repo.write` | **ENFORCED** |
| **Process Memory Isolation** | Node `child-process` execution domain with independent PID and V8 heap | **ENFORCED** |
| **Parent Environment Secret Isolation** | Explicit environment allowlist; parent `process.env` never inherited | **ENFORCED** |
| **Filesystem OS Containment** | OS-level filesystem chroot, sandbox, or driver container | **NOT ENFORCED** |
| **Network OS Containment** | OS-level network socket filtering or namespace restriction | **NOT ENFORCED** |
| **Subprocess OS Containment** | OS-level process spawning restrictions inside plugin processes | **NOT ENFORCED** |

> **Security Truth**: Current child-process plugin execution provides memory isolation, secret isolation, and Kernel RPC authorization. It does **not** provide full OS-level containment (no filesystem jail, no kernel network namespace). Plugins must be treated as partially isolated code, not a complete hostile-code sandbox. Node `vm` is never used or claimed as hostile-code isolation.

---

## 2. Logical Rings vs. Physical Execution Domains

### 2.1 Logical Privilege Rings
Logical Rings define permission domains for capability issuance and service authority:
- **Ring 0 (Kernel Authority)**: Kernel internals, `CapabilityBroker`, `SyscallGateway`, `CommitCoordinator`, and append-only `AuditJournal`.
- **Ring 1 (Mediated Services)**: Trusted drivers (LLM provider adapters, repository snapshot services, supervisor planner agents). Agents in lower rings never hold direct handles to Ring 1 drivers.
- **Ring 3 (Review Agents & Plugins)**: Specialized analysis agents and third-party plugins. All cross-boundary actions must be explicitly requested via capability handles and mediated by the `SyscallGateway`.

### 2.2 Physical Execution Domains
Execution domains describe the operating-system boundary in which code executes:
- **`in-process`**: Runs in the same Node.js process as the harness supervisor. Reserved for verified built-in agents (Supervisor, Deterministic Analyzers).
- **`child-process`**: Spawned as an isolated child Node.js process via `spawnSandboxChild` (`worker-bootstrap.mjs`). Communicates strictly over a bounded RPC v1 protocol over IPC (max message size 256KB, max 64 pending requests).
- **`worker-thread`**: Declared for future lightweight thread-level parallel workers.

---

## 3. Capability Model & Syscall Mediation

1. **Opaque Handles**: Agents only ever hold opaque 256-bit handles (`cap_<64hex>`).
2. **Default-Deny**: Operations without an active, non-expired, non-revoked capability issued for the caller's `PrincipalId` and target `Resource` are rejected.
3. **Audit Fingerprinting**: Audit journals, runtime observability DTOs, and log files record only the 12-hex-character audit fingerprint (`cap_f0123456789a`), preventing credential or token leakage.
4. **Effect Classes & Dispatch Policies**:
   - `pure` / `read` (e.g. `repo.read`, `evidence.read`): Directly authorized and executed.
   - `commit` / `direct` (e.g. `llm.invoke`): Executed through trusted Ring 1 provider driver with authoritative token tracking.
   - `commit` / `intent` (e.g. `github.publish`, `repo.write`): Intercepted by `SyscallGateway` and routed to the `CommitCoordinator` durable outbox.

---

## 4. Repository Workspace & PR Access Modes

| Mode | GitHub App Required | Access Credentials | Comments Published |
|---|---|---|---|
| **Public Read: Anonymous** | No | Anonymous GitHub REST API / Git clone | No (read-only) |
| **Public Read: PAT** | No | Server-side read-only Personal Access Token | No (read-only) |
| **Webhook Review** | Yes | GitHub App Private Key + Webhook HMAC Secret | Yes (per publication policy) |

### Access Mode Security Invariants
- **Public PR Analysis**: Analysis of public GitHub pull requests is strictly read-only (`accessMode=public_read`, `publicationPolicy=disabled`). It will never create GitHub comments, apply patches, or execute repository commands.
- **Credential Storage**: Secret keys (DeepSeek API key, OpenAI API key, GitHub PAT, App private keys) remain server-side. In Electron desktop mode, credentials are encrypted via OS `safeStorage` and passed only to the API child process at startup. They are never returned to the Web UI or included in logs.
- **Rate Limits**: Anonymous and authenticated requests strictly respect GitHub REST API rate limits and never attempt bypass via parallel rotation.

### Repository and Remote Data Boundaries
- Renderer repository selection uses only the opaque registered `Repository.id`. The audit store must contain an exact matching registration. Display names, remote names, `local:` aliases, heartbeat roots, project-root shortcuts, relative paths, and absolute paths are not repository selectors.
- Local filesystem locators remain server-only and are resolved only for exact registered records with source `local_git`.
- Renderer remote DTOs contain exactly `name` plus optional `githubFullName`. Raw fetch URLs, raw push URLs, and embedded credentials are omitted.

### Workspace Pull Request Credentials
Workspace Pull Request listing tries candidates in this order: GitHub App installation token when available, configured server-side public-read token, then anonymous access. Candidates are deduplicated and attempted once each. A malformed provider payload is an invalid provider response, not a credential failure, so it is not retried with another candidate. This precedence applies to repository workspace listing, not standalone public PR URL ingestion. Public URL ingestion remains read-only and does not gain GitHub App access just because an App is configured.

---

## 5. Electron Desktop Security Boundary

Electron acts as a native desktop host and OS boundary:
- **Renderer Sandboxing**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- **Preload Isolation**: Exposes only narrow, explicit methods (`appVersion`, `selectRepository`, `credentialStatus`, `setCredential`, `restartRuntime`, `updates.*`). No raw Node modules, `require`, `fs`, `child_process`, or `ipcRenderer` objects cross into the renderer.
- **Native Repository Picker**: Folder selection occurs in the main process via `dialog.showOpenDialog`. The main process registers the repository through `POST /internal/repositories/local` using an internal `CONSISTENCY_DESKTOP_CONTROL_TOKEN` and returns only the sanitized public `Repository` DTO. Absolute filesystem paths are never leaked to the renderer.
- **Custom Protocol**: `consistency://app` serves static web assets and proxies `/api/*` to the loopback API with bearer token injection. Renderer requests to `/api/internal/*` are rejected with HTTP 404.
- **Navigation & Windows**: `setWindowOpenHandler` denies all popups; `will-navigate` blocks navigation away from trusted local origins.

---

## 6. Production Security Checklist

1. Set `NODE_ENV=production` with explicit `CONSISTENCY_ALLOWED_ORIGINS` (never wildcard `*`).
2. Require `CONSISTENCY_API_TOKEN` for all HTTP endpoints.
3. Configure GitHub App secrets (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) securely via environment variables.
4. Rotate any leaked API tokens, PATs, or model keys immediately.

## 7. Git Read Hardening

All centralized Git reads strip ambient environment variables whose names match `GIT_*` case-insensitively before restoring only the controlled `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` values. Each invocation also sets `core.fsmonitor=false`. Diff reads explicitly use `--no-ext-diff` and `--no-textconv`.

These controls prevent interactive prompts, optional index locking, fsmonitor effects, external diff execution, and text conversion during Git reads. They are not OS-level filesystem, network, or subprocess containment. Child processes are not a complete hostile-code sandbox.
