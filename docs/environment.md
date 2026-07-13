# Environment Variables

This file is the canonical environment variable reference for CyclOps.

See [env-vars.md](./env-vars.md) for the full reference including infrastructure settings (Redis, PgBouncer) and GitHub App permissions.

## Quick Reference

### Shared — both apps/api and apps/worker

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | RSA private key (replace newlines with `\n` for Railway) |
| `GITHUB_WEBHOOK_SECRET` | Yes | HMAC webhook verification secret |
| `DATABASE_URL` | Yes | PostgreSQL connection string (port 6543 for Railway PgBouncer) |
| `REDIS_URL` | Yes | Redis connection string |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |
| `CYCLOPS_ENCRYPTION_KEY` | Yes | 64-hex-char AES-256-GCM key for BYOK Anthropic key encryption — generate: `openssl rand -hex 32`. Must match across both services. |

### apps/api only

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP server port (default: `3000`) |
| `HOST` | No | Bind address (default: `0.0.0.0`) |
| `CYCLOPS_SETUP_SECRET` | Yes | Shared secret for `x-setup-token` header on `POST /setup/:installationId` — generate: `openssl rand -hex 32` |

### apps/worker only

| Variable | Required | Description |
|----------|----------|-------------|
| `CYCLOPS_MONTHLY_TOKEN_BUDGET` | No | Per-installation monthly token cap (default: `1000000` = 1M tokens ≈ $2–10/mo at `claude-sonnet-5` pricing). Set low to test budget enforcement. |

> **Anthropic API keys are BYOK** — registered per installation via `POST /setup/:installationId`. There is no global `ANTHROPIC_API_KEY`. Model: `claude-sonnet-5`.
