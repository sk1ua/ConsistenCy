# Security Model

## Controls

- API and Vite dev servers bind to `127.0.0.1` by default.
- Production requires explicit CORS origins; `*` and an empty list are rejected.
- Production requires API token, GitHub App ID, private key, and webhook secret.
- GitHub webhook bodies are verified with HMAC SHA-256 before JSON parsing.
- Delivery IDs are persisted for replay protection.
- Management routes require `Authorization: Bearer <CONSISTENCY_API_TOKEN>` when configured.
- Request bodies are limited to 1 MB.
- `/analyze-file` is development-only and resolves regular files inside `CONSISTENCY_WORKSPACE_ROOT`.
- PR workspaces are isolated under `.consistency/workspaces/{jobId}`.
- Symlink escapes, absolute paths, traversal, binary files, oversized files, and known secret files are rejected or skipped.
- Common tokens, bearer credentials, private keys, and secret assignments are redacted before LLM context or logs.
- Public error messages remove credential fragments and local absolute paths.
- LLM and API payloads are validated by strict zod schemas.

## Secret Handling

Never commit `.env`, GitHub private keys, installation tokens, API tokens, or provider keys. Installation tokens are short-lived and generated dynamically. Logs use pino redaction and should receive structured fields rather than raw environment objects.

Do not place `VITE_API_TOKEN` in a publicly distributed production bundle. Use an authenticated reverse proxy or a server-side session layer for production browser access.

## LLM Boundary

Repository content is untrusted. ConsistenCy limits file and total context size, skips secret-like paths, redacts high-confidence credential patterns, and rejects invalid structured model output. Agents cannot create confirmed findings without file, line, and evidence fields.

## External Failures

GitHub comment publication is best-effort. A report is persisted first; publication failure is stored separately and does not change a succeeded job to failed.

## Production Checklist

- Set `NODE_ENV=production`.
- Use explicit HTTPS origins.
- Store secrets in the deployment secret manager.
- Put the loopback API behind TLS and authenticated ingress.
- Do not expose SQLite or workspace directories through a static server.
- Rotate the API token and webhook secret after suspected disclosure.
- Run `npm audit --omit=dev`, `npm run verify`, and CI before release.

## Remaining Boundaries

ConsistenCy does not execute checked-out repository code during TypeScript context construction. The retained Python analyzer must continue to treat repository input as untrusted. Production multi-user identity and tenant isolation remain future work; the current API token represents a single operator boundary.
