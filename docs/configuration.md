# ConsistenCy Runtime Configuration & Precedence

This document describes how runtime configuration, environment variables, LLM providers, and data persistence paths are resolved in ConsistenCy v3.

---

## 1. LLM Provider Configuration

ConsistenCy v3 is a **real-data, real-LLM runtime**. It requires a real, configured LLM provider to execute Review runs and Notebook reasoning. Local Git exploration and repository browsing remain fully functional when no LLM is configured.

### 1.1 Supported Runtime Providers

| Provider | Supported Models | Required Environment / Setting | Default Model |
|---|---|---|---|
| **DeepSeek** | `deepseek-chat`, `deepseek-v4-flash`, etc. | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| **OpenAI** | `gpt-4.1-mini`, `gpt-4o`, etc. | `OPENAI_API_KEY` | `gpt-4.1-mini` |

### 1.2 Unconfigured LLM State
If neither `DEEPSEEK_API_KEY` nor `OPENAI_API_KEY` is provided:
- The API sets `llmProviderConfigured: false` and reports `llmProvider: "none"` on `GET /health`.
- Repository browsing, Git status, diff views, and deterministic AST analysis function normally.
- Review execution requests (`POST /reviews/local`, `POST /reviews/public-pr`) are rejected with HTTP 400 (`LLM_NOT_CONFIGURED`).
- The Web UI displays an "LLM not configured" indicator linking to the Settings page.

> **Note on Test Doubles**: Isolated test suites (`*.test.ts`, `tests/`) may instantiate internal mock doubles (`MockLLMProvider`) to verify orchestration behavior deterministically without paid network calls. These test doubles are not accessible as a user-facing runtime mode.

---

## 2. Configuration Precedence

Settings are resolved in the following strict order of precedence:

```
1. Process Environment Variables (Highest Precedence)
        ↓
2. Local Encrypted Secrets (.consistency/secrets.enc.json or Desktop safeStorage)
        ↓
3. Local Configuration File (.consistency/config.json)
        ↓
4. Built-in Defaults (Lowest Precedence)
```

### 2.1 Restart-Required Semantics
When configuration changes are saved via the Web UI Settings page (`PUT /api/settings`):
- Non-secret settings are written to disk (`config.json`), and secrets are encrypted via AES-256-GCM (`secrets.enc.json`) or Desktop `safeStorage`.
- The API runtime loads configuration once at process startup.
- Saving new settings returns `restartRequired: true`.
- In Electron Desktop mode, users can click **[Restart ConsistenCy Runtime]** to have the Desktop host automatically restart its owned API child process and apply the new configuration.

---

## 3. Storage & Database Paths

| Runtime Mode | Default Database Path | Workspaces Directory | Settings Directory |
|---|---|---|---|
| **Browser Development** | `<ProjectRoot>/.consistency/consistency.db` | `<ProjectRoot>/.consistency/workspaces` | `<ProjectRoot>/.consistency/` |
| **Packaged Electron Desktop** | `<userData>/consistency.db` | `<userData>/workspaces` | `<userData>/settings/` |
| **Explicit Override** | `DATABASE_PATH` env var | `CONSISTENCY_WORKSPACE_ROOT` | `CONSISTENCY_SETTINGS_ROOT` |

### Path Resolution Rules
- If `DATABASE_PATH` is `:memory:`, in-memory SQLite storage is used.
- If `DATABASE_PATH` is an absolute path (e.g. `C:\Users\...\consistency.db`), it is used exactly as provided.
- If `DATABASE_PATH` is a relative path, it resolves strictly relative to the workspace project root.
- Packaged desktop installations always anchor persistent data under `app.getPath("userData")`, ensuring immutable installation directories (such as `Program Files` or `app.asar`) are never written to.

---

## 4. Key Environment Variables Reference

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `HOST` | `127.0.0.1` | Host address to bind the API server |
| `PORT` | `8787` | Port to bind the API server (dynamic in Desktop mode) |
| `DATABASE_PATH` | `.consistency/consistency.db` | Path to SQLite database |
| `CONSISTENCY_WORKSPACE_ROOT` | `.consistency/workspaces` | Root directory for ephemeral review checkouts |
| `CONSISTENCY_API_TOKEN` | *empty* | Bearer token required for API authentication in production |
| `DEEPSEEK_API_KEY` | *empty* | API key for DeepSeek provider |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | DeepSeek model identifier |
| `OPENAI_API_KEY` | *empty* | API key for OpenAI provider |
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI model identifier |
| `GITHUB_APP_ID` | *empty* | GitHub App ID for webhook-driven reviews |
| `GITHUB_PRIVATE_KEY` | *empty* | PEM private key string or path for GitHub App |
| `GITHUB_WEBHOOK_SECRET` | *empty* | HMAC secret for verifying incoming GitHub webhooks |
| `GITHUB_PUBLIC_READ_TOKEN` | *empty* | Optional fine-grained PAT for elevated public GitHub API rate limits |
| `CONSISTENCY_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Allowed CORS origins for browser clients |
