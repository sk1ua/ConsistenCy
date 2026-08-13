# ConsistenCy Desktop (Electron)

Windows-first desktop shell. The Web UI (apps/web) is the renderer; the API
(apps/api) runs as a child process on Electron's Node runtime
(ELECTRON_RUN_AS_NODE + tsx), with SQLite data and review workspaces under
Electron's userData directory. The deterministic engine still requires a
system Python 3.12 (v1; a doctor check runs at startup).

## Development

1. Rebuild the native SQLite binding for Electron's ABI once after installs:
   `npm run rebuild -w @consistency/desktop`
2. Build the web UI with a relative base so file:// loading works:
   `npm run build -w @consistency/web -- --base=./`
3. `npm run desktop:dev` (or: `npx electron apps/desktop`) - loads the built
   web assets via file://, spawns the API on 127.0.0.1:3001, and opens the shell.

**ABI note**: better-sqlite3 is compiled for exactly one ABI. Running desktop
requires the Electron ABI (step 1); running the Node 22 test suites afterwards
requires restoring the Node 22 ABI:
`npx -y node@22 node_modules/node-gyp/bin/node-gyp.js rebuild` (run from
node_modules/better-sqlite3). Switch back with step 1 before desktop runs.

## Packaging (Windows)

`npm run desktop:pack` stages web/api/engine/packages/node_modules into
apps/desktop/staged (copied with dereferenced symlinks - see
scripts/desktop-pack.mjs) and runs electron-builder for the NSIS installer and
a portable build. Size optimization (bundling a real Node runtime instead of
the repo node_modules, embedding Python) is a follow-up.

## Smoke test

`npm run test:desktop` (Playwright _electron).
