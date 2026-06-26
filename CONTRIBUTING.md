# Contributing

Thanks for taking a look at ConsistenCy. The project is intentionally small enough to run locally, so every change should keep the demo, tests, and dashboard easy to verify.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-dev.txt
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

## Development Guidelines

- Keep generated files out of Git. Local databases, evaluation outputs, cloned repos, pytest caches, and experiment caches are ignored.
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
