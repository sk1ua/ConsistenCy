# TypeScript Product Shell

ConsistenCy is moving toward a hybrid architecture:

```text
TypeScript product shell
- Web/API
- GitHub App
- dashboard
- report UI
- config/schema
- job orchestration

Python analysis engine
- parser
- agents
- scoring
- evaluation
- ML/model bits
```

## Workspace Layout

The TypeScript workspace uses npm workspaces so it can run on a stock
Node/npm installation:

```text
apps/
  api/        # Node/TypeScript API shell
  web/        # React/Vite dashboard shell
packages/
  schema/     # shared Zod schemas and JSON Schema exports
schemas/      # source JSON Schema contracts generated/maintained from Python output
```

`packages/schema` is the bridge between the Python engine and TypeScript
surfaces. It exports the machine-readable JSON Schema contracts plus Zod
schemas for runtime validation in API, web, and future GitHub App code.

## API Shell

`apps/api` starts with a small Node/TypeScript HTTP service:

- `GET /health` returns service metadata for smoke tests.
- `POST /analyze-file` accepts `{ "currentFile": "...", "baselineFile": "..." }`,
  invokes `python backend/cli.py analyze-file ... --json-output`, parses
  stdout as JSON, and validates the payload through `packages/schema`
  before returning it.
- `POST /github/webhook` receives GitHub App webhooks, verifies
  `X-Hub-Signature-256` when `GITHUB_WEBHOOK_SECRET` is configured,
  normalizes supported events, and enqueues review jobs.
- `GET /jobs` and `GET /jobs/:id` expose the current in-memory job queue
  for dashboard and orchestration smoke tests.
- `POST /jobs/run-next` and `POST /jobs/:id/run` run queued PR jobs by
  invoking Python `pr-report`.
- `GET /jobs/:id/report` returns the schema-validated PR report for
  completed jobs.

The subprocess bridge uses `spawn(..., { shell: false })`, explicit
arguments, a fixed repository working directory, and a timeout. This keeps
the Python engine authoritative while giving TS clients a stable product
API boundary.

## GitHub App Shell

The TypeScript GitHub App surface is intentionally thin:

- TypeScript owns webhook authentication, event routing, and job lifecycle
  state.
- Pull request events enqueue `pull_request` jobs for `opened`,
  `reopened`, `synchronize`, and `ready_for_review`.
- Push events enqueue `push` jobs for `main` and `master` refs.
- Unsupported events and non-actionable refs return `ignored` responses
  without side effects.
- The compatibility runner can still turn `pull_request` jobs into PR reports
  by calling `python backend/cli.py pr-report --json-output` and validating
  the result through `packages/schema`.
- The current production worker primarily uses the TypeScript LangGraph review
  workflow. Python remains responsible for repository parsing, deterministic
  analysis, evaluation, and compatibility report generation.

The current queue is in-memory so local development and tests stay simple.
Production persistence can replace `InMemoryJobQueue` without changing the
webhook contract.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev:api
npm run dev:web
```

Webhook smoke example:

```bash
GITHUB_WEBHOOK_SECRET=dev-secret npm run dev:api
```

## Migration Policy

- Python remains the authoritative analysis engine.
- TypeScript consumers must validate Python output through
  `packages/schema`.
- Additive report fields are allowed.
- Removing or changing the type of a required report field requires a
  schema-versioned migration.
- The old Flask dashboard and Python/Flask GitHub App server have been removed.
  The supported product surfaces are `apps/api`, `apps/web`, `packages/schema`,
  and the retained Python analysis CLI used by the compatibility bridge.
