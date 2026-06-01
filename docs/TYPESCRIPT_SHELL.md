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

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev:api
npm run dev:web
```

## Migration Policy

- Python remains the authoritative analysis engine.
- TypeScript consumers must validate Python output through
  `packages/schema`.
- Additive report fields are allowed.
- Removing or changing the type of a required report field requires a
  schema-versioned migration.
- Flask dashboard routes remain supported until the TS dashboard reaches
  feature parity.
