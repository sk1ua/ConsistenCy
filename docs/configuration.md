# ConsistenCy Runtime Configuration & Precedence

This document describes how runtime configuration, environment variables, LLM providers, and data persistence paths are resolved in ConsistenCy v4 (terminal-only).

> **Version note**: this document describes the current **v4 (terminal-only)** checkout. The product lineage name is still v3 (see the frozen [CONSISTENCY_V3_MASTER_SPEC.md](CONSISTENCY_V3_MASTER_SPEC.md)); v4 deleted the Web UI and the Electron desktop host, keeping the CLI and the headless HTTP daemon. Differences: [delivery-readiness.md](delivery-readiness.md).

---

## 1. LLM Provider Configuration

ConsistenCy v4 is a **real-data, real-LLM runtime**. It requires a real, configured LLM provider to execute Review runs and Notebook reasoning. Local Git exploration and repository browsing remain fully functional when no LLM is configured.

### 1.1 Supported Runtime Providers

| Provider | Supported Models | Required Environment / Setting | Default Model |
|---|---|---|---|
| **DeepSeek** | `deepseek-flash`, `deepseek-v4-pro`, etc. | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| **OpenAI** | `gpt-4.1-mini`, `gpt-5`, etc. | `OPENAI_API_KEY` | `gpt-4.1-mini` |
| **Anthropic** | `claude-sonnet-4-5`, `claude-opus-4-5`, etc. | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| **Pi catalog (any listed id)** | Catalog from `GET /llm/catalog` | `LLM_PROVIDER` + `LLM_API_KEY` (optional `LLM_MODEL`) | Provider default |

`LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` are first-class. When `LLM_PROVIDER` is unset, the process infers deepseek → openai → anthropic from which vendor key is present. The headless `GET /llm/catalog` endpoint lists the full Pi catalog, not only the three rows above.

### 1.3 Bundled Pi runtime engine

All providers are executed by the bundled official Pi runtime (`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`). ConsistenCy delegates model catalogs, request formatting, and streaming to Pi instead of reimplementing them, and `models.json`/`auth.json` parsing stays inside Pi.

The six specialists use the same system prompt and repository-context prefix, with each role appended at the end of its user message. The agent execution log and CLI report record cached input tokens for every call. Pi exposes cache reads as a number; `0 (未报告或未命中)` means the provider either reported no hit or did not supply cache usage, which Pi cannot distinguish.

ConsistenCy does not read a user-level `~/.pi` directory and does not require a local Pi installation:

- Pi's built-in model catalog is the default model source. Set `CONSISTENCY_PI_MODELS_PATH` to an explicit `models.json` to add custom endpoints; user-level Pi config is never read implicitly.
- `CONSISTENCY_LLM_TEMPERATURE` optionally pins the temperature for both structured review requests and streaming requests. With it unset, Pi and the provider use their defaults.
- Provider API keys configured through Settings (or `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` server-side) are injected in-memory via Pi's `setRuntimeApiKey` and are never written to Pi config files.
- `CONSISTENCY_PI_CONFIG_DIR` only relocates the runtime's isolated auth-storage path inside the ConsistenCy data directory. It is server-side process configuration and is not included in settings snapshots or health payloads.
- Model catalog network refresh stays disabled; requests go only to the selected provider's API endpoint.

ConsistenCy only receives the final model response and normalized usage; provider headers, API keys, OAuth tokens, and raw provider errors remain inside the API process and fail closed to sanitized fixed errors.
If no supported provider is configured (DeepSeek, OpenAI, or Anthropic):
- The API sets `llmProviderConfigured: false` and reports `llmProvider: "none"` on `GET /health`.
- Repository browsing, Git status, diff views, and deterministic AST analysis function normally.
- Review execution requests (`POST /reviews/local`, `POST /reviews/public-pr`) are rejected with HTTP 503 (`LLM_NOT_CONFIGURED`).
- Workflow Copilot (`POST /workflow-runtime/copilot/proposal`, `/chat`) is rejected with HTTP 503 (`LLM_NOT_CONFIGURED`).
- The CLI stops before the run with a setup error that names `npm run setup` and `npm run config -- set llm.provider`.

> **Note on Test Doubles**: Isolated test suites (`*.test.ts`, `tests/`) may instantiate internal mock doubles (`MockLLMProvider`) to verify orchestration behavior deterministically without paid network calls. These test doubles are not accessible as a user-facing runtime mode.

---

## 2. Configuration Precedence

Settings are resolved in the following strict order of precedence:

```
1. Process Environment Variables (Highest Precedence)
        ↓
2. Local Encrypted Secrets (.consistency/secrets.enc.json)
        ↓
3. Local Configuration File (.consistency/config.json)
        ↓
4. Built-in Defaults (Lowest Precedence)
```

### 2.1 Restart-Required Semantics
When configuration changes are saved (`npm run config -- set <key> <value>`, or `PUT /api/settings` for the API layer):
- Non-secret settings are written to disk (`config.json`), and secrets are encrypted via AES-256-GCM (`secrets.enc.json`).
- The API runtime loads configuration once at process startup.
- Saving new settings returns `restartRequired: true`; restart the process to apply them.

---

## 3. Storage & Database Paths

| Runtime Mode | Default Database Path | Workspaces Directory | Settings Directory |
|---|---|---|---|
| **CLI (`consistency review`)** | job store 是 `InMemoryJobQueue`；知识记忆默认写入 `.consistency/cli/knowledge/<repo>.sqlite` | `<ProjectRoot>/.consistency/cli/workspaces` | `<ProjectRoot>/.consistency/` |
| **HTTP daemon (`npm run dev:api`)** | `<ProjectRoot>/.consistency/consistency.db` | `<ProjectRoot>/.consistency/workspaces` | `<ProjectRoot>/.consistency/` |
| **Explicit Override** | `DATABASE_PATH` env var | `CONSISTENCY_WORKSPACE_ROOT` | `CONSISTENCY_SETTINGS_ROOT` |

只有 daemon 会持久化 job、报告与快照；CLI 的这些数据只在内存中（详见 [capability-matrix.md](capability-matrix.md) 的 cli 列）。CLI 的项目知识记忆默认另存于 `<ProjectRoot>/.consistency/cli/knowledge/<repo>.sqlite`，用于下一次审查的历史上下文。`--no-memory` 或 `CONSISTENCY_NO_MEMORY=1` 在 CLI/runtime 边界关闭知识路径、`relevant_context` 和 `record_review`：既不打开既有知识库，也不创建或更新知识库。该 opt-out 不删除历史数据，也不禁用审查本身或其它工作区产物；HTTP daemon 的默认记忆行为不变。

### Path Resolution Rules
- If `DATABASE_PATH` is `:memory:`, in-memory SQLite storage is used.
- If `DATABASE_PATH` is an absolute path (e.g. `C:\Users\...\consistency.db`), it is used exactly as provided.
- If `DATABASE_PATH` is a relative path, it resolves strictly relative to the workspace project root.
- `CONSISTENCY_SETTINGS_ROOT` relocates the settings store (`apps/api/src/config/runtime.ts:25`); tests use it to avoid touching the real `.consistency` directory.

---

## 4. Key Environment Variables Reference

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `HOST` | `127.0.0.1` | Host address to bind the API server |
| `PORT` | `8787` | Port to bind the API server |
| `DATABASE_PATH` | `.consistency/consistency.db` | Path to SQLite database (HTTP daemon only) |
| `CONSISTENCY_WORKSPACE_ROOT` | `.consistency/workspaces` | Root directory for ephemeral review checkouts |
| `CONSISTENCY_API_TOKEN` | *empty* | Bearer token required for API authentication in production (`apps/api/src/http.ts:613` writes the CORS/auth headers) |
| `DEEPSEEK_API_KEY` | *empty* | API key for DeepSeek provider |
| `DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek model identifier (Pi catalog id; `deepseek-flash` is DeepSeek V4.1 Flash) |
| `OPENAI_API_KEY` | *empty* | API key for OpenAI provider |
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI model identifier |
| `ANTHROPIC_API_KEY` | *empty* | API key for the Anthropic provider |
| `ANTHROPIC_MODEL` | *empty* | Optional Anthropic model id; empty uses the catalog default (`claude-sonnet-4-5`) |
| `CONSISTENCY_PI_CONFIG_DIR` | `<database-dir>/pi` | Server-side isolation directory for the bundled Pi runtime's auth storage |
| `CONSISTENCY_PI_MODELS_PATH` | *empty* | Explicit Pi `models.json` path for custom model endpoints; restart after changing the file |
| `CONSISTENCY_LLM_TEMPERATURE` | *empty* | Request temperature from 0 to 2; empty uses the provider default |
| `CONSISTENCY_LLM_BASE_URL` | *empty* | Endpoint override for the selected provider (proxy, gateway, or any OpenAI-compatible base URL). Applied to the real completion path through Pi's provider registration; `DEEPSEEK_BASE_URL` retargets DeepSeek specifically and takes effect only when the generic override is empty. Neither is ever hardcoded |
| `CONSISTENCY_MAX_FINDINGS_PER_SPECIALIST` | `3` | Maximum grounded main-list findings kept from each specialist (1–20); findings more than three lines from changed code go to `preExistingIssues` instead |
| `CONSISTENCY_MIN_FINDING_SCORE` | `5` | Minimum synthesizer score (0–10) for a finding to reach the main list. The score and its one-line reason ride the synthesizer's existing summary call, so scoring adds no extra request. A finding the provider leaves unscored is never dropped on score |
| `CONSISTENCY_MAX_REPORTED_FINDINGS` | `8` | Maximum findings in the main list after scoring (1–50) |
| `CONSISTENCY_MAX_FINDINGS_PER_FILE` | `3` | Maximum main-list findings from any single file after scoring (1–20) |
| `CONSISTENCY_DETERMINISTIC_SCOPE` | `diff` | Scoping of Python-engine (deterministic) findings: `diff` keeps only findings anchored within 5 lines of a changed hunk, `all` keeps the engine's unscoped output. Findings the engine reports without a line reference are kept only for files that are part of the change |
| `CONSISTENCY_NO_MEMORY` | `0` / unset | CLI only: exact value `1` disables persisted knowledge reads, indexing and review write-back. Equivalent to `--no-memory`; the flag always disables memory even when the environment is `0`. Other values retain default memory |
| `CONSISTENCY_LEAN` | unset | Exact value `1` runs only Correctness and Consistency and does not call the Planner. Every other value keeps the full six-agent review. Consistency findings must cite an existing repository precedent and pass deterministic code verification |
| `CONSISTENCY_SCORE_RUBRIC` | unset | Exact value `1` shows the synthesizer numbered changed lines, scores verified convention deviations highly, suppresses generic test suggestions, and raises the per-file cap from 3 to 4. Every other value keeps the v1 rubric and cap |
| `GITHUB_APP_ID` | *empty* | GitHub App ID for webhook-driven reviews |
| `GITHUB_OAUTH_CLIENT_ID` | *empty* | Public OAuth App client id for the Device Flow routes (API layer; the repo ships no login UI) |
| `CONSISTENCY_DESKTOP_OAUTH_BROKER_URL` | *empty* | HTTPS origin of the OAuth broker used by the API's `/oauth/desktop/*` routes (`apps/api/src/server.ts:160`) |
| `CONSISTENCY_DESKTOP_OAUTH_CLIENT_ID` | *empty* | Product-owned GitHub OAuth App client id used by the Desktop broker |
| `CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET` | *empty* | Product-owned GitHub OAuth App secret used only server-side by the Desktop broker; never ship to Desktop |
| `GITHUB_PRIVATE_KEY` | *empty* | PEM private key string or path for GitHub App |
| `GITHUB_WEBHOOK_SECRET` | *empty* | HMAC secret for verifying incoming GitHub webhooks |
| `GITHUB_PUBLIC_READ_TOKEN` | *empty* | Optional fine-grained PAT for elevated public GitHub API rate limits (fallback; OAuth sign-in is the recommended source of this credential) |
| `CONSISTENCY_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Allowed CORS origins; **残留默认值**——它是已删除的 Vite 开发端口，只在浏览器客户端存在时才有意义（`apps/api/src/config/env.ts:123`） |
| `CONSISTENCY_WEB_URL` | `http://127.0.0.1:5173` | 同上（`apps/api/src/config/env.ts:124`；兜底见 `apps/api/src/config/settings.ts:357`） |
| `CONSISTENCY_WORKFLOW_TRIGGERS_ENABLED` | `true` | CKPT5 kill-switch for automatic execution of `on_change` workflow bindings from repository change events (planning continues while off; pending plans drain when re-enabled) |
| `CONSISTENCY_WORKFLOW_TRIGGER_POLL_INTERVAL_MS` | `5000` | Poll interval of the workflow trigger executor loop |

### 4.0 GitHub sign-in 路由（API 层，仓库不含界面）

v4 仓库里没有登录界面：Web UI 与 Electron 宿主都已删除。为桌面构建保留的 broker 路由在 API 层仍然注册并可测试：

- `POST /oauth/desktop/start`、`/oauth/desktop/complete`、`/oauth/desktop/cancel`（`apps/api/src/http.ts:3492-3559`），受 `CONSISTENCY_DESKTOP_OAUTH_BROKER_URL` 门控；未配置 broker 时这些路由不可用。
- 产品侧凭据 `CONSISTENCY_DESKTOP_OAUTH_CLIENT_ID` / `CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET` 只在服务端使用，绝不进入任何 DTO。
- Device Flow 的兼容路径同样只剩 API 语义：API 在服务端持有 device code，token 经加密设置落盘。**当前没有任何 UI 消费这两条路径**，`GITHUB_PUBLIC_READ_TOKEN` 仍是自托管部署的凭据回退方案。

## Local WORKING_TREE path excludes

Local working-tree reviews (`buildLocalContext`, job diff for `WORKING_TREE`, and review-preparation changed-file counts) honor:

1. A repo-root **`.consistencyignore`** file (gitignore-style: one pattern per line, `#` comments).
2. Optional env **`CONSISTENCY_LOCAL_REVIEW_EXCLUDE`**: comma- or newline-separated extra patterns.

The ConsistenCy repository ships a sample `.consistencyignore` that ignores `artifacts/` so review scratch files do not enter reviews.

