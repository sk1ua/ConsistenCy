# ConsistenCy Runtime Configuration & Precedence

This document describes how runtime configuration, environment variables, LLM providers, and data persistence paths are resolved in ConsistenCy v3.

---

## 1. LLM Provider Configuration

ConsistenCy v3 is a **real-data, real-LLM runtime**. It requires a real, configured LLM provider to execute Review runs and Notebook reasoning. Local Git exploration and repository browsing remain fully functional when no LLM is configured.

### 1.1 Supported Runtime Providers

| Provider | Supported Models | Required Environment / Setting | Default Model |
|---|---|---|---|
| **DeepSeek** | `deepseek-v4-flash`, `deepseek-v4-pro`, etc. | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| **OpenAI** | `gpt-4.1-mini`, `gpt-5`, etc. | `OPENAI_API_KEY` | `gpt-4.1-mini` |
| **Anthropic** | `claude-sonnet-4-5`, `claude-opus-4-5`, etc. | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |

### 1.3 Bundled Pi runtime engine

All providers are executed by the bundled official Pi runtime (`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`). ConsistenCy delegates model catalogs, request formatting, and streaming to Pi instead of reimplementing them, and `models.json`/`auth.json` parsing stays inside Pi.

ConsistenCy does not read a user-level `~/.pi` directory and does not require a local Pi installation:

- Pi's built-in model catalog is the single model source; the runtime is created with `modelsPath: null` so any user-level Pi `models.json` is ignored.
- Provider API keys configured through Settings (or `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` server-side) are injected in-memory via Pi's `setRuntimeApiKey` and are never written to Pi config files.
- `CONSISTENCY_PI_CONFIG_DIR` only relocates the runtime's isolated auth-storage path inside the ConsistenCy data directory. It is server-side process configuration: never editable through Web Settings and never included in settings snapshots, health payloads, logs, renderer state, or Desktop preload capabilities.
- Model catalog network refresh stays disabled; requests go only to the selected provider's API endpoint.

ConsistenCy only receives the final model response and normalized usage; provider headers, API keys, OAuth tokens, and raw provider errors remain inside the API process and fail closed to sanitized fixed errors.
If no supported provider is configured (DeepSeek, OpenAI, or Anthropic):
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
| `ANTHROPIC_API_KEY` | *empty* | API key for the Anthropic provider |
| `ANTHROPIC_MODEL` | *empty* | Optional Anthropic model id; empty uses the catalog default (`claude-sonnet-4-5`) |
| `CONSISTENCY_PI_CONFIG_DIR` | `<database-dir>/pi` | Server-side isolation directory for the bundled Pi runtime's auth storage; never returned to the renderer |
| `GITHUB_APP_ID` | *empty* | GitHub App ID for webhook-driven reviews |
| `GITHUB_OAUTH_CLIENT_ID` | *empty* | Public OAuth App client id for the browser Device Flow compatibility path only |
| `CONSISTENCY_DESKTOP_OAUTH_BROKER_URL` | *empty* | HTTPS origin of the product-operated Desktop OAuth broker; configure on the API/broker service, not in user Settings |
| `CONSISTENCY_DESKTOP_OAUTH_CLIENT_ID` | *empty* | Product-owned GitHub OAuth App client id used by the Desktop broker |
| `CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET` | *empty* | Product-owned GitHub OAuth App secret used only server-side by the Desktop broker; never ship to Desktop |
| `GITHUB_PRIVATE_KEY` | *empty* | PEM private key string or path for GitHub App |
| `GITHUB_WEBHOOK_SECRET` | *empty* | HMAC secret for verifying incoming GitHub webhooks |
| `GITHUB_PUBLIC_READ_TOKEN` | *empty* | Optional fine-grained PAT for elevated public GitHub API rate limits (fallback; OAuth sign-in is the recommended source of this credential) |
| `CONSISTENCY_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Allowed CORS origins for browser clients |
| `CONSISTENCY_WORKFLOW_TRIGGERS_ENABLED` | `true` | CKPT5 kill-switch for automatic execution of `on_change` workflow bindings from repository change events (planning continues while off; pending plans drain when re-enabled) |
| `CONSISTENCY_WORKFLOW_TRIGGER_POLL_INTERVAL_MS` | `5000` | Poll interval of the workflow trigger executor loop |

### 4.1 GitHub Sign-In (Desktop browser OAuth)

The packaged Electron Desktop uses the standard GitHub Authorization Code flow
with PKCE through the product-operated OAuth broker. The Settings button opens
the system browser; after authorization, GitHub redirects to a one-time local
callback on `127.0.0.1` with a dynamic port. The user never copies a user code,
authorization code, or access token.

Product deployment (one time):

1. Register one GitHub OAuth App for ConsistenCy and configure its callback as
   `https://<broker-host>/oauth/github/callback`.
2. Configure `CONSISTENCY_DESKTOP_OAUTH_BROKER_URL`,
   `CONSISTENCY_DESKTOP_OAUTH_CLIENT_ID`, and
   `CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET` together on the broker/API service.
3. Build the Desktop with only `CONSISTENCY_DESKTOP_OAUTH_BROKER_URL`; the packer
   rejects non-HTTPS origins and never stages either client credential.

End users only click **Sign in with GitHub** and **Authorize**. They do not
register an OAuth App or enter any OAuth credential.

- The main process owns state validation, S256 PKCE, callback handling, token
  exchange, and the `/user` identity lookup. Only the sanitized GitHub login
  and a fixed status cross into the renderer.
- The access token is written to the existing `GITHUB_PUBLIC_READ_TOKEN` entry
  in Electron `safeStorage` only after identity lookup succeeds. It is never
  placed in the callback URL, API settings snapshot, renderer state, logs, or
  documentation examples. Restarting the runtime makes the new credential
  available to the API child process.
- The callback listener accepts one local GET request at the exact callback
  path and is closed on success, denial, failure, cancellation, timeout, or
  application shutdown. The requested scope is `read:user`; repository
  permissions are not granted.

### 4.2 GitHub Sign-In (Browser Device Flow compatibility)

A normal browser deployment does not expose a public OAuth callback and does
not use the Desktop client secret. It retains the existing GitHub Device Flow
compatibility path: enable **Enable Device Flow** on the OAuth App, configure the
public Client ID, then the browser shows GitHub's verification URL and a
one-time user code. The API keeps the device code server-side and the token is
stored through the Web encrypted settings path. Desktop renderers are blocked
from these Device Flow routes and use the main-process browser flow instead.

`GITHUB_PUBLIC_READ_TOKEN` remains a fallback for self-hosted deployments that
have not configured OAuth sign-in. It is optional and is not required for the
Desktop broker flow.
