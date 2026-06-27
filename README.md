# ConsistenCy

[![CI](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml/badge.svg)](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml)

ConsistenCy is an evidence-grounded multi-agent PR review assistant. It combines deterministic specialist analyzers, local evidence retrieval, compact Evidence Packs, and weighted consensus so reviewers can see which files deserve attention first and why.

Multi-agent means deterministic specialist analyzers plus evidence coordination. LLM review is optional and tests do not require external model keys.

![ConsistenCy dashboard](docs/design/dashboard-implementation.png)

## Local Start

```powershell
npm install
python -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
npm run dev:api
npm run dev:web
```

Open `http://127.0.0.1:5173`.

Seed demo data:

```powershell
$headers = @{ Authorization = "Bearer $env:CONSISTENCY_API_TOKEN" }
Invoke-RestMethod -Method Post http://127.0.0.1:8787/demo/seed -Headers $headers
```

## Verification

```powershell
npm run typecheck
npm test
npm run build
python -m ruff check .
python -m pytest -q
```

## Key Paths

- `apps/api` - TypeScript API, GitHub App webhook receiver, worker, persistence.
- `apps/web` - React/Vite dashboard.
- `packages/schema` - shared zod contracts.
- `backend/src/retrieval` - deterministic evidence retrieval and Evidence Packs.
- `backend/src/pr_report_builder.py` - Python PR report generation.
- `evaluation/scripts/run_metrics.py` - ranking and retrieval metrics.

## Docs

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [Architecture](docs/architecture.md)
- [Web API](docs/api.md)
- [Output schema](docs/output_schema.md)
- [Evaluation](docs/EVALUATION.md)
- [GitHub App setup](docs/GITHUB_APP_SETUP.md)
- [Demo](docs/demo.md)
- [Security](docs/security.md)
- [Remote analysis](docs/REMOTE_ANALYSIS.md)
- [TypeScript shell](docs/TYPESCRIPT_SHELL.md)
