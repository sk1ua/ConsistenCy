# Architecture

## Components

- `apps/api`: HTTP API, GitHub App webhook handling, worker, SQLite.
- `apps/web`: React dashboard.
- `packages/schema`: shared zod schemas.
- `backend`: Python deterministic analyzers, retrieval, CLI, evaluation.

## Data Flow

```text
GitHub webhook -> job queue -> PR context -> review workflow -> report -> dashboard/comment
Python CLI -> PR report -> retrieval packs -> consensus -> markdown/schema output
```

Reports are persisted before GitHub comment publication. Comment failure does not fail a completed review job.
