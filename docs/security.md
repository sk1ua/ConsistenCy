# Security

## Controls

- API and Vite dev servers bind to loopback by default.
- Production requires explicit CORS origins and API token.
- GitHub webhook bodies are verified with HMAC SHA-256.
- Delivery IDs are persisted for replay protection.
- Repository files are untrusted input.
- Secret-like paths and token patterns are redacted or skipped.
- LLM output is parsed through strict zod schemas.

## Production Checklist

- Set `NODE_ENV=production`.
- Use HTTPS.
- Store secrets in a secret manager.
- Do not expose SQLite or workspace directories.
- Rotate API token and webhook secret after suspected disclosure.
