# Contributing

Thanks for taking a look at ConsistenCy. The project is intentionally small enough to run locally, so every change should keep the demo, tests, and dashboard easy to verify.

## Setup

Use the same major runtime versions as CI:

- Node.js 22 (`.nvmrc` and `.node-version`)
- Python 3.12 (`.python-version`)

These are the canonical development and CI versions. The repository-level `.npmrc` also rejects unsupported Node.js versions.

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-lock.txt
npm ci
```

## Local Checks

Run these before opening a pull request:

```bash
python examples/multi_agent_demo.py
python -m pytest -q
npm run verify
```

For WebApp work, run the TypeScript services:

```bash
npm run dev:api
npm run dev:web
```

Then open `http://127.0.0.1:5173`.

## Configuration

The guided CLI is the quickest first-run path:

```bash
npm run setup
npm run config -- doctor
```

Inspect or update individual values without opening `.env`:

```bash
npm run config -- show
npm run config -- set llm.provider deepseek
npm run config -- set llm.deepseek-api-key
```

Non-secret values are stored in `.consistency/config.json`. Secrets are encrypted at rest in `.consistency/secrets.enc.json` with a local key; they are never returned by the API. Process environment variables have final precedence over saved settings.

After starting the API and WebApp, the Settings page can edit the same configuration in development. Restart the API after saving. Settings writes are disabled when `NODE_ENV=production`; configure production deployments through environment variables or the CLI. Configure the optional API bearer token from the CLI and keep `VITE_API_TOKEN` synchronized for the WebApp.

## Development Guidelines

- Keep generated files out of Git. Local databases, evaluation outputs, cloned repos, pytest caches, and experiment caches are ignored.
- `npm run build` refreshes ignored frontend output under `apps/web/dist`; do not commit it.
- Update `requirements-dev.txt` first when changing Python dependencies, then refresh `requirements-lock.txt`.
- Prefer deterministic behavior. The core scoring layer should be reproducible without an LLM key.
- Add or update tests when changing agent scoring, report schema, CLI output, or dashboard API payloads.
- Keep documentation focused. Prefer updating `README.md`, `docs/PROJECT_OVERVIEW.md`, or `docs/output_schema.md` instead of adding one-off notes.
- For frontend changes, check desktop and mobile widths and avoid text clipping in cards, buttons, charts, and sidebars.

## Pull Request Checklist

- The change has a clear user-facing reason.
- Tests cover the changed behavior.
- `python -m pytest -q` passes.
- `npm run verify` passes when TypeScript or WebApp files changed.
- README or docs are updated when commands, schemas, routes, or setup steps change.
