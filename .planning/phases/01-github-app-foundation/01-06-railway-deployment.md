---
phase: 01-github-app-foundation
plan: 06
type: execute
wave: 4
depends_on: ["01-04", "01-05"]
files_modified:
  - apps/api/railway.toml
  - apps/worker/railway.toml
  - docs/env-vars.md
  - scripts/test-webhook.sh
  - apps/worker/src/index.ts
autonomous: true

must_haves:
  truths:
    - "apps/api/railway.toml defines a deploy config that runs migrations before starting the API"
    - "apps/worker/railway.toml defines a deploy config that starts the worker without running migrations"
    - "Both railway.toml files use RAILPACK builder"
    - "Health check endpoint is configured in apps/api/railway.toml"
    - "Environment variable documentation covers all required env vars for both services"
    - "docs/env-vars.md includes a Redis server configuration section (WHK-05) documenting noeviction maxmemory-policy and appendonly requirements"
    - "docs/env-vars.md includes a Database Connection Pooling section (TEN-05) documenting PgBouncer port 6543 and Prisma connection_limit=1"
    - "apps/worker/src/index.ts logs a WARNING on startup if Redis maxmemory-policy is not noeviction"
    - "Test script sends a valid HMAC-signed webhook and verifies 202 response"
  artifacts:
    - path: "apps/api/railway.toml"
      provides: "API service deploy config with pre-deploy migration step"
    - path: "apps/worker/railway.toml"
      provides: "Worker service deploy config"
    - path: "docs/env-vars.md"
      provides: "Complete env var reference including Redis server config and PgBouncer pooling notes"
    - path: "scripts/test-webhook.sh"
      provides: "End-to-end webhook delivery test script"
    - path: "apps/worker/src/index.ts"
      provides: "Worker bootstrap with Redis config assertion"
  key_links:
    - from: "apps/api/railway.toml"
      to: "packages/db migration scripts"
      via: "deployCommand runs prisma migrate deploy before api start"
      pattern: "migrate deploy"
    - from: "scripts/test-webhook.sh"
      to: "POST /webhooks"
      via: "curl with HMAC signature"
      pattern: "X-Hub-Signature-256"
    - from: "apps/worker/src/index.ts"
      to: "Redis server config"
      via: "redis.config('GET', 'maxmemory-policy') assertion on startup"
      pattern: "maxmemory-policy"
---

<objective>
Create Railway deployment configs for both services, document all required environment variables (including Redis server config and PgBouncer pooling requirements), add a startup Redis config assertion to the worker, and write an end-to-end test script that verifies webhook delivery works correctly against a running API.

Purpose: Deployment config is required before any developer can test the system end-to-end. The test script provides observable proof that the full path (webhook → HMAC → Redis dedup → BullMQ enqueue) works correctly, satisfying the Phase 1 success criteria.

Output: Two railway.toml files ready for Railway deployment, a complete env var reference with infrastructure config notes, a startup assertion in the worker, and a bash script that sends a test webhook and verifies 202 response.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/tsouza/Projects/ciintel/.planning/PROJECT.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-04-SUMMARY.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-05-SUMMARY.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Railway deployment configs for api and worker services</name>
  <files>
    apps/api/railway.toml
    apps/worker/railway.toml
  </files>
  <action>
Create railway.toml for each service. Key requirements:
- RAILPACK builder (Railway's recommended builder for Node.js monorepos)
- API service runs `prisma migrate deploy` as a pre-deploy command (not the worker — only one service should run migrations)
- Worker service does NOT run migrations
- API health check configured so Railway knows when the service is up

**apps/api/railway.toml:**

```toml
[build]
builder = "RAILPACK"
buildCommand = "pnpm --filter @ciintel/db run db:generate && pnpm --filter @ciintel/api run build"

[deploy]
startCommand = "node apps/api/dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3

[deploy.preDeployCommand]
# Run migrations before deploying. Only the API service runs migrations.
# This ensures the schema is up-to-date before the new code starts serving traffic.
command = "pnpm --filter @ciintel/db run db:migrate"
```

**apps/worker/railway.toml:**

```toml
[build]
builder = "RAILPACK"
buildCommand = "pnpm --filter @ciintel/db run db:generate && pnpm --filter @ciintel/worker run build"

[deploy]
startCommand = "node apps/worker/dist/index.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
# No healthcheckPath — worker is a background process with no HTTP server
# No preDeployCommand — only apps/api runs migrations
```

Note: Both services are deployed as separate Railway services within the same project. They share:
- `DATABASE_URL` (Railway PostgreSQL shared variable)
- `REDIS_URL` (Railway Redis shared variable)
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` (shared variables)
  </action>
  <verify>
1. `cat apps/api/railway.toml | grep "RAILPACK"` — builder set
2. `cat apps/api/railway.toml | grep "db:migrate"` — migration pre-deploy step
3. `cat apps/api/railway.toml | grep "healthcheckPath"` — health check configured
4. `cat apps/worker/railway.toml | grep "RAILPACK"` — builder set
5. `grep "db:migrate" apps/worker/railway.toml` — returns empty (worker does NOT run migrations)
  </verify>
  <done>API railway.toml runs db:generate + build, runs prisma migrate deploy before start, health check on /health. Worker railway.toml runs db:generate + build, no migrations, no health check.</done>
</task>

<task type="auto">
  <name>Task 2: Environment variable documentation and end-to-end webhook test script</name>
  <files>
    docs/env-vars.md
    scripts/test-webhook.sh
  </files>
  <action>
Create a complete env var reference (including Redis server config and PgBouncer pooling sections) and a bash script that sends a valid HMAC-signed webhook to verify end-to-end delivery.

**docs/env-vars.md:**

```markdown
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
```

**scripts/test-webhook.sh:**

This script generates a valid HMAC-SHA256 signature and sends a test installation webhook to verify the full path works. Requires: `curl`, `openssl`, and `jq`.

```bash
#!/usr/bin/env bash
# test-webhook.sh — End-to-end webhook delivery test
# Usage: WEBHOOK_SECRET=your-secret API_URL=http://localhost:3000 ./scripts/test-webhook.sh

set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-test-secret}"
DELIVERY_ID="${DELIVERY_ID:-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)}"

# Test payload: installation.created event
PAYLOAD=$(cat <<'EOF'
{
  "action": "created",
  "installation": {
    "id": 12345678,
    "account": {
      "login": "test-org",
      "type": "Organization"
    },
    "app_id": 999,
    "target_id": 12345678,
    "target_type": "Organization"
  }
}
EOF
)

# Generate HMAC-SHA256 signature
SIGNATURE="sha256=$(echo -n "${PAYLOAD}" | openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" | awk '{print $2}')"

echo "Sending test webhook delivery..."
echo "  URL:         ${API_URL}/webhooks"
echo "  Delivery ID: ${DELIVERY_ID}"
echo "  Event:       installation"
echo "  Action:      created"
echo "  Signature:   ${SIGNATURE:0:20}..."

HTTP_STATUS=$(curl -s -o /tmp/webhook-response.json -w "%{http_code}" \
  -X POST "${API_URL}/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: installation" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIGNATURE}" \
  -d "${PAYLOAD}")

echo ""
echo "Response status: ${HTTP_STATUS}"
echo "Response body:   $(cat /tmp/webhook-response.json)"

if [ "${HTTP_STATUS}" = "202" ]; then
  echo ""
  echo "SUCCESS: Webhook delivery accepted (202)"
  echo ""
  echo "To verify the job was enqueued, check Redis:"
  echo "  redis-cli -u \${REDIS_URL:-redis://localhost:6379} llen 'bull:webhook-ingestion:wait'"
else
  echo ""
  echo "FAILURE: Expected 202, got ${HTTP_STATUS}"
  exit 1
fi

# Test duplicate detection
echo "Testing duplicate detection (same delivery ID)..."
DUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${API_URL}/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: installation" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIGNATURE}" \
  -d "${PAYLOAD}")

if [ "${DUP_STATUS}" = "202" ]; then
  echo "SUCCESS: Duplicate delivery returned 202 (deduped, not rejected)"
else
  echo "FAILURE: Duplicate delivery returned ${DUP_STATUS}, expected 202"
  exit 1
fi

echo ""
echo "All tests passed."
```

Make the script executable:
```bash
chmod +x scripts/test-webhook.sh
```

Also create the `scripts/` directory and add a `.gitkeep` if needed:
```bash
mkdir -p scripts
```
  </action>
  <verify>
1. `cat docs/env-vars.md | grep "GITHUB_APP_PRIVATE_KEY"` — documented with Railway formatting note
2. `cat docs/env-vars.md | grep "\\\\n"` — shows the newline escaping instruction
3. `cat docs/env-vars.md | grep "noeviction"` — Redis maxmemory-policy requirement documented
4. `cat docs/env-vars.md | grep "appendonly"` — Redis AOF persistence requirement documented
5. `cat docs/env-vars.md | grep "6543"` — PgBouncer port documented
6. `cat docs/env-vars.md | grep "connection_limit=1"` — Prisma connection_limit documented
7. `cat scripts/test-webhook.sh | grep "X-Hub-Signature-256"` — HMAC header sent
8. `cat scripts/test-webhook.sh | grep "202"` — checks for 202 response
9. `cat scripts/test-webhook.sh | grep "duplicate"` — tests dedup behavior
10. `ls -la scripts/test-webhook.sh` — file is executable
  </verify>
  <done>Both railway.toml files created with RAILPACK builder. docs/env-vars.md covers all required vars with Railway private key formatting, Redis server config section (noeviction + appendonly), and PgBouncer pooling section (port 6543, connection_limit=1). test-webhook.sh sends HMAC-signed webhook and verifies 202 + dedup behavior.</done>
</task>

<task type="auto">
  <name>Task 3: Redis server config assertion in worker startup (WHK-05)</name>
  <files>
    apps/worker/src/index.ts
  </files>
  <action>
Add a startup assertion to apps/worker/src/index.ts that checks the Redis `maxmemory-policy` configuration and logs a WARNING if it is not set to `noeviction`. This is a non-blocking check — the worker starts regardless, but the warning flags a misconfigured Redis server before it causes silent job loss.

Update apps/worker/src/index.ts to add the check after workers start:

```typescript
import pino from "pino";
import { getRedis } from "@ciintel/queue";
import { createWebhookIngestionWorker } from "./workers/webhook-ingestion.js";
import { createDlqWorker } from "./workers/dlq.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

logger.info("Starting CyclOps worker process");

const webhookIngestionWorker = createWebhookIngestionWorker();
const dlqWorker = createDlqWorker();

logger.info(
  {
    workers: ["webhook-ingestion (concurrency=20)", "dlq (concurrency=5)"],
  },
  "Workers started"
);

// WHK-05: Verify Redis server is configured for job workloads.
// Railway Redis defaults to allkeys-lru which silently evicts jobs under memory pressure.
// Required: maxmemory-policy=noeviction and appendonly=yes.
// This check is non-blocking — worker starts regardless, but warns on misconfiguration.
(async () => {
  try {
    const redis = getRedis();
    const result = await redis.config("GET", "maxmemory-policy");
    // ioredis returns config as [key, value, key, value, ...] array
    const policyValue = Array.isArray(result) ? result[1] : undefined;
    if (policyValue !== "noeviction") {
      logger.warn(
        { currentPolicy: policyValue ?? "unknown" },
        "WARNING: Redis maxmemory-policy is not 'noeviction'. " +
        "BullMQ jobs may be silently evicted under memory pressure. " +
        "Set maxmemory-policy=noeviction in Railway Redis service config (Settings → Config)."
      );
    } else {
      logger.info({ maxmemoryPolicy: policyValue }, "Redis maxmemory-policy check passed");
    }
  } catch (err) {
    // Non-fatal — some Redis configurations restrict CONFIG GET
    logger.warn({ err }, "Could not verify Redis maxmemory-policy — skipping check");
  }
})();

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info("Shutting down workers...");
  await Promise.all([
    webhookIngestionWorker.close(),
    dlqWorker.close(),
  ]);
  logger.info("Workers stopped gracefully");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```
  </action>
  <verify>
1. `cat apps/worker/src/index.ts | grep "maxmemory-policy"` — config check present
2. `cat apps/worker/src/index.ts | grep "noeviction"` — correct expected value
3. `cat apps/worker/src/index.ts | grep "redis.config"` — CONFIG GET call present
4. `cat apps/worker/src/index.ts | grep "WARNING"` — warning message present
5. `pnpm --filter @ciintel/worker exec tsc --noEmit` — exits 0 (or only generated type errors)
  </verify>
  <done>apps/worker/src/index.ts now checks Redis maxmemory-policy on startup and logs a WARNING if not set to noeviction. The check is non-blocking and catches CONFIG GET permission errors gracefully.</done>
</task>

</tasks>

<verification>
Run the end-to-end test against a locally running API:
```bash
# Start Redis and API locally first
WEBHOOK_SECRET=test-secret API_URL=http://localhost:3000 ./scripts/test-webhook.sh
```

Expected output:
- Line: "Response status: 202"
- Line: "SUCCESS: Webhook delivery accepted (202)"
- Line: "SUCCESS: Duplicate delivery returned 202 (deduped, not rejected)"

Phase 1 success criteria verification:
1. `GET /health` returns 200 — `curl http://localhost:3000/health`
2. `POST /webhooks` with valid signature returns 202 — verified by test script
3. Duplicate delivery returns 202 — verified by test script
4. Redis contains enqueued job — `redis-cli llen bull:webhook-ingestion:wait`
5. Worker startup logs show Redis maxmemory-policy check result
</verification>

<success_criteria>
- apps/api/railway.toml has RAILPACK builder, migration pre-deploy, /health healthcheck
- apps/worker/railway.toml has RAILPACK builder, no migration step
- docs/env-vars.md documents all env vars with sources and Railway-specific notes
- docs/env-vars.md has Redis Server Configuration section: noeviction + appendonly requirements (WHK-05)
- docs/env-vars.md has Database Connection Pooling section: PgBouncer port 6543, connection_limit=1, transaction mode (TEN-05)
- apps/worker/src/index.ts logs WARNING if Redis maxmemory-policy is not noeviction
- scripts/test-webhook.sh is executable and sends valid HMAC-signed webhook
- Test script verifies 202 response and duplicate dedup behavior
- Private key \\n formatting documented for Railway deployments
</success_criteria>

<output>
After completion, create `/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-06-SUMMARY.md` with:
- frontmatter: phase, plan, subsystem: deployment, affects: [apps/api, apps/worker], tech-stack.added: []
- What was built (railway.toml configs, env var docs, Redis config assertion, test script)
- Key decisions: only API runs migrations, RAILPACK builder, private key \\n normalization documented, noeviction Redis requirement documented and asserted at runtime, PgBouncer port 6543 with connection_limit=1

Then create `/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-PHASE-SUMMARY.md` summarizing the complete phase:
- All 6 plans completed
- Architecture decisions made
- Full tech stack established
- Phase 1 success criteria met
</output>
