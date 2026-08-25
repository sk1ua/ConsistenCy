# ConsistenCy Desktop (Electron Host)

ConsistenCy Desktop v1 is a native Windows host for the ConsistenCy review workbench. It integrates the existing `apps/web` React renderer and `apps/api` TypeScript backend into an operating-system desktop shell without duplicating kernel or harness logic.

---

## 1. Desktop Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Electron Main Process                             │
│       (BrowserWindow, API Process Lifecycle, Native Dialogs, IPC Bridge)    │
└───────────────────────┬─────────────────────────────┬───────────────────────┘
                        │                             │
                        ▼                             ▼
┌─────────────────────────────────┐   ┌───────────────────────────────────────┐
│        Renderer Window          │   │           API Child Process           │
│   (Sandboxed apps/web build,    │   │      (Precompiled apps/api bundle,     │
│    custom consistency://app)    │   │       Node.js 22 + Python 3.12)       │
└─────────────────────────────────┘   └───────────────────────────────────────┘
```

### 1.1 Responsibilities
- **Electron Main**: Owns the OS lifecycle, native folder selection dialogs, credential encryption via `safeStorage`, dynamic loopback port allocation, and child API process supervision.
- **Sandboxed Renderer**: Executes the compiled `apps/web` Vite bundle. Has no Node integration, no direct filesystem access, and interacts exclusively through the custom `consistency://app` protocol and narrow context-bridge IPC methods.
- **API Child Process**: Runs the compiled `apps/api/dist/server.cjs` under a verified Node.js 22 runtime, communicating over an ephemeral loopback interface.

> **Security Note**: The Electron Desktop host is an operating system boundary and container host, **not** the internal Kernel security boundary. Kernel capabilities and syscall authorization remain the authoritative enforcement mechanism for review agents and workloads.

---

## 2. Development Workflow

### Prerequisites
- Node.js 22.x
- Python 3.12.x with locked engine dependencies

### Running in Development
```powershell
$env:CONSISTENCY_NODE_HELPER = (Get-Command node).Source
$env:CONSISTENCY_PYTHON_PATH = (Resolve-Path .\.venv\Scripts\python.exe).Path
npm run desktop:dev
```

This compiles the web assets, bundles the API, and launches the Electron shell.

### Running Desktop Verification Tests
```powershell
npm run test:desktop
```

This executes the Playwright Electron test suite (`tests/e2e-electron/`), covering sandbox isolation, custom protocol routing, route filtering, and update coordinator policies.

---

## 3. Packaging & Distribution

### Building Windows Packages
Packaging uses `electron-builder` and packages the built web renderer, compiled API bundle, native SQLite bindings, and Python runtime into an `asar:true` application:

```powershell
$env:CONSISTENCY_PYTHON_BUNDLE_ROOT = 'C:\path\to\Python312'
$env:DESKTOP_TARGETS = 'nsis dir'
npm run desktop:pack
```

Output is written to `apps/desktop/release/`:
- `release/win-unpacked/ConsistenCy.exe`: Runnable unpacked application.
- `release/ConsistenCy-Setup-0.1.0-x64.exe`: Full Windows NSIS installer.

### Packaged Data Location
The packaged application persists all mutable data strictly under the user data directory (`app.getPath("userData")`):
- Database: `<userData>/consistency.db`
- Settings: `<userData>/settings/`
- Workspaces: `<userData>/workspaces/`
- Logs: `<userData>/consistency.log` (Main) and `<userData>/api.log` (API)
- Credentials: `<userData>/credentials.safe.json` (OS-encrypted)

The application has zero write dependencies on its installation directory or the source tree.

---

## 4. Key Desktop Features

### 4.1 Native Repository Picker
When connecting a local Git repository, Electron opens the operating system's native folder dialog. The main process registers the repository directly with the local API using an internal control token and returns only the public `Repository` metadata to the renderer. Local filesystem paths are never exposed to renderer JavaScript.

### 4.2 Ephemeral Loopback Port & Security
The API binds to `127.0.0.1` on a dynamically assigned port. Each launch generates two random 256-bit tokens:
- An API session bearer token injected transparently by the `consistency://` protocol proxy.
- A desktop control token required for internal administrative routes (e.g. `POST /internal/repositories/local`).

### 4.3 Runtime Restart from Settings
When LLM provider keys or review worker settings are updated in the Settings page or the in-app Settings Dialog (Runtime section), the Desktop host provides a **[Restart ConsistenCy Runtime]** button. Clicking this instructs Electron to gracefully terminate the API child process, spawn a fresh instance with the updated settings, and re-establish connectivity seamlessly.

### 4.4 Open Logs Folder (Semantic Action)
The About section of Settings exposes an **[Open logs folder]** button (desktop only; browsers show a not-available note). This is a semantic privileged action, not a filesystem capability: the `logs:open` IPC method takes **no arguments**, the main process resolves the `userData` folder itself — the documented home of `consistency.log` and `api.log` — opens it in the OS file manager via `shell.openPath`, and returns only `{ ok: boolean }` to the renderer. The renderer never receives arbitrary path-opening authority, never learns the resolved folder path, and never sees `shell.openPath`'s error description (which may embed local paths). There is no generic `openPath(pathFromRenderer)` API.

---

## 5. Limitations & Boundaries

- **Supported Platform**: Desktop v1 targets Windows x64.
- **Real LLM Required**: Review execution requires real API credentials (DeepSeek or OpenAI). Mock runtime is absent.
- **OS Containment**: Electron sandboxes the renderer, but the API child process runs with standard user OS permissions.
