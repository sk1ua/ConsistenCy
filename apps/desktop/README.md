# ConsistenCy Desktop (Electron)

Windows-first, local-first audit workbench. Electron is an OS boundary, not
the audit runtime: the renderer is sandboxed, the API runs as a precompiled
bundle under Node.js 22, and the deterministic engine remains a separate
Python 3.12 JSON-over-stdio helper.

## Security model

- The renderer loads from `consistency://app`, has no Node integration, and is
  constrained by CSP, navigation, window-open and permission guards.
- The API binds an ephemeral loopback port. The main process generates separate
  256-bit API-bearer and desktop-control tokens and passes them directly to the
  helper; no port or token reaches renderer state.
- `preload.cjs` exposes only narrow repository-picker, credential-status,
  runtime-restart, and tray capabilities. The repository picker accepts no
  renderer arguments: main selects the directory, registers it through
  `POST /internal/repositories/local`, and returns only the shared public
  `Repository` DTO (or a sanitized error message). Absolute paths remain in
  main/helper memory and persistence.
- The `consistency://` protocol returns 404 for `/api/internal/*` and removes
  any renderer-supplied desktop-control header before forwarding other API
  requests. The control token is therefore usable only by main-process code.
- Provider/GitHub credentials stored through the desktop bridge use Electron
  `safeStorage`; plaintext is supplied only to the API helper at startup.
- Closing the last window hides the app in the tray so opted-in monitoring can
  continue. Startup-at-login remains off until a user explicitly enables it.
- Update metadata, feed configuration, downloaded installer paths and release
  credentials remain main-process-only. Preload exposes only sanitized status,
  stable/beta selection, and explicit check/download/install commands.

## Update policy

Automatic update checks are enabled only when all of these conditions hold:

- Electron reports a packaged Windows application;
- the executable was installed by the NSIS installer (the installer writes a
  marker that unpacked `dir` builds do not have);
- the build was produced with `CONSISTENCY_DESKTOP_RELEASE=true` and
  electron-builder successfully enforced code signing;
- the process is not running from the portable wrapper.

Development, unpacked, unsigned and portable builds report `manual-only` and
never load or call `electron-updater`. The application checks once after an
eligible installed release starts, but it does not silently download or
install. Download and installation use narrow IPC operations; installation
also requires confirmation in a native main-process dialog.

The user-facing channels are `stable` (default) and `beta`. They map to the
electron-builder `latest` and `beta` channels respectively. Channel changes
are allowlisted and stored in the desktop preferences file; downgrades remain
disabled after a channel switch, and NSIS web-installer updates are rejected.
No updater URL, authorization header, token,
local cache path or raw updater error is returned to the renderer.

## Development

Use Node.js 22.x and Python 3.12:

```powershell
$env:CONSISTENCY_NODE_HELPER=(Get-Command node).Source
$env:CONSISTENCY_PYTHON_PATH=(Resolve-Path .\.venv\Scripts\python.exe).Path
npm run desktop:dev
```

`desktop:dev` builds the renderer and the API bundle before launching Electron.
The Node helper is checked at startup and must report 22.x. No Electron ABI
rebuild is needed: `better-sqlite3` belongs to the external Node helper, not to
Electron's embedded runtime.

Useful verification:

```powershell
npm run test:api-bundle
npm run test:desktop
```

## Packaging (Windows)

Packaging requires a redistributable Python 3.12 runtime, including the locked
engine dependencies:

```powershell
$env:CONSISTENCY_PYTHON_BUNDLE_ROOT='C:\path\to\python-3.12-runtime'
npm run desktop:pack
```

The packer refuses non-Node-22 execution, bundles the API, copies the active
Node 22 executable as the helper, verifies the Python runtime, stages only the
native SQLite dependency, and builds an `asar:true` application. Helper,
engine and API files are unpacked because external runtimes cannot read ASAR.

The default target is `dir`. It is intentionally unsigned and manual-update
only. A signed stable NSIS release job uses:

```powershell
$env:DESKTOP_TARGETS='nsis'
$env:CONSISTENCY_DESKTOP_RELEASE='true'
$env:CONSISTENCY_DESKTOP_UPDATE_CHANNEL='stable'
$env:CONSISTENCY_DESKTOP_PUBLISH='onTagOrDraft'
$env:CSC_LINK='<CI secret or certificate path>'
$env:CSC_KEY_PASSWORD='<CI secret when required>'
$env:GH_TOKEN='<CI release token>'
npm run desktop:pack
```

The packer rejects release mode without `WIN_CSC_LINK` or `CSC_LINK`, enables
electron-builder's `forceCodeSigning`, and rejects publishing outside signed
release mode. This repository does not contain a signing certificate and local
artifacts must not be described as signed. The release job should additionally
verify the final Authenticode signature before publishing.

For beta, set the channel to `beta` and use an application version containing
`-beta`. GitHub publication produces the corresponding channel metadata; the
runtime never receives `GH_TOKEN`. `DESKTOP_TARGETS='portable'` produces a
separately named portable artifact and remains manual-update only even when it
is signed. Building `nsis portable` together is supported without artifact-name
collisions.

`asar:true` is retained, helper/runtime files alone are unpacked, and the
after-pack hook flips the hardened Electron fuses before signing. Automatic
updates use the installed `electron-updater` runtime dependency and the GitHub
publish metadata generated by electron-builder.
