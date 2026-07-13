# Environment Variables

## Shared (both apps/api and apps/worker)

| Variable | Required | Description | Where to Find |
|----------|----------|-------------|---------------|
| `GITHUB_APP_ID` | Yes | Numeric GitHub App ID | GitHub App settings page → App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | RSA private key for JWT signing | GitHub App settings → Generate a private key. Replace newlines with literal `\n` for Railway env vars. |
| `GITHUB_WEBHOOK_SECRET` | Yes | Secret for HMAC webhook verification | Set when creating the GitHub App → Webhook secret field |
| `DATABASE_URL` | Yes | PostgreSQL connection string | Railway PostgreSQL service → Connect tab |
| `REDIS_URL` | Yes | Redis connection string | Railway Redis service → Connect tab |
| `LOG_LEVEL` | No | Pino log level (default: `info`) | One of: trace, debug, info, warn, error |

## apps/api only

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP server port (default: `3000`) | Set automatically by Railway |
| `HOST` | No | Bind address (default: `0.0.0.0`) | Use `0.0.0.0` in Railway |

## Private Key Formatting for Railway

Railway stores environment variables as single-line strings. The GitHub App private key contains newlines that must be escaped.

When setting `GITHUB_APP_PRIVATE_KEY` in Railway, replace actual newlines with literal `\n`:

```bash
# Convert PEM file to Railway-safe single line
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-app.private-key.pem
```

The `apps/github/src/app.ts` `getApp()` function automatically converts `\n` back to real newlines on startup.

## Redis Server Configuration (WHK-05)

The following are **infrastructure settings** configured in Railway's Redis service config panel — NOT application environment variables.

| Setting | Required Value | Why |
|---------|---------------|-----|
| `maxmemory-policy` | `noeviction` | BullMQ requires jobs to never be silently evicted. The default `allkeys-lru` will cause Railway Redis to silently drop jobs under memory pressure. |
| `appendonly` | `yes` | Enables AOF persistence so jobs survive Redis restarts. Without this, a Redis restart drops all queued jobs. |

**How to configure in Railway:**
1. Open your Railway project → Redis service → Settings → Config
2. Set `maxmemory-policy noeviction`
3. Set `appendonly yes`

The worker process (`apps/worker/src/index.ts`) logs a WARNING on startup if `maxmemory-policy` is not `noeviction`. Watch startup logs after first deploy to confirm this check passes.

## Database Connection Pooling (TEN-05)

Railway managed PostgreSQL includes a built-in connection pooler (PgBouncer in transaction mode) on port **6543**.

**`DATABASE_URL` must use port 6543 in production, not 5432.**

```
# Development (direct connection)
DATABASE_URL=postgresql://user:pass@host:5432/db

# Production on Railway (PgBouncer)
DATABASE_URL=postgresql://user:pass@host:6543/db?pgbouncer=true&connection_limit=1
```

The `connection_limit=1` parameter is **required** when using PgBouncer with Prisma. Without it, Prisma opens multiple connections from a single process, which conflicts with PgBouncer's connection management.

**Why transaction mode is required:** The RLS `set_config('app.current_installation_id', ..., TRUE)` call uses the TRUE flag (transaction-local), which is compatible with PgBouncer transaction mode. Session-mode PgBouncer would allow the setting to leak across connections.

Railway's Connect tab shows two connection strings — use the one labeled "Prisma" or the one on port 6543.

## GitHub App Permissions Required (APP-04)

When creating the GitHub App, grant these permissions:
- **Checks:** Read & write
- **Contents:** Read & write
- **Pull requests:** Read & write
- **Issues:** Read & write
- **Actions:** Read & write
- **Metadata:** Read (required by GitHub)

## GitHub App Webhook Events to Subscribe

Subscribe to these events in the GitHub App settings:
- `check_run`
- `check_suite`
- `workflow_run`
- `installation`
- `installation_repositories`
- `push`
- `pull_request`
