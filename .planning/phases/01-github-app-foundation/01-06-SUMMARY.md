---
phase: 01-github-app-foundation
plan: "06"
subsystem: deployment
tags: [railway, railpack, toml, env-vars, pgbouncer, redis, bullmq, webhook, bash, e2e]

dependency-graph:
  requires: ["01-04", "01-05"]
  provides: ["railway.toml for api", "railway.toml for worker", "docs/env-vars.md", "scripts/test-webhook.sh"]
  affects: ["phase-2 (deployment reference)"]

tech-stack:
  added: []
  patterns: ["RAILPACK builder for Railway deployments", "preDeployCommand for DB migrations (api only)", "healthcheckPath for Railway health probing", "HMAC-SHA256 webhook signature verification in bash"]

key-files:
  created:
    - apps/api/railway.toml
    - apps/worker/railway.toml
    - docs/env-vars.md
    - scripts/test-webhook.sh
  modified: []

decisions:
  - id: api-only-runs-migrations
    choice: Only apps/api/railway.toml has preDeployCommand for db:migrate
    rationale: Single migration runner prevents race conditions on concurrent deploys; api is the natural owner since it starts first and depends on schema being current
    alternatives: ["both services run migrations (risk of concurrent migration conflict)", "separate migration service"]

  - id: railpack-builder
    choice: RAILPACK builder for both services
    choice-details: Railway's next-gen builder (replaces Nixpacks); auto-detects pnpm workspaces
    alternatives: ["Nixpacks (legacy)", "Dockerfile (manual, more control)"]

  - id: private-key-newline-normalization
    choice: Document awk command to convert PEM to Railway single-line format; getApp() normalizes \n back to real newlines
    rationale: Railway stores env vars as single-line strings; PEM keys contain literal newlines that must be escaped for storage
    alternatives: ["base64 encode the key (requires decode in app code)"]

  - id: noeviction-redis-requirement
    choice: Documented as infrastructure requirement in docs/env-vars.md; worker logs WARNING on startup if not set
    rationale: WHK-05: BullMQ jobs must never be silently evicted; default allkeys-lru would drop jobs under memory pressure
    alternatives: ["fail hard on startup (too disruptive for misconfigured deploys)", "skip check entirely"]

  - id: pgbouncer-port-6543
    choice: Document port 6543 + connection_limit=1 as required for production DATABASE_URL
    rationale: TEN-05: Railway managed PostgreSQL uses PgBouncer transaction mode on 6543; Prisma requires connection_limit=1 to avoid pooling conflicts
    alternatives: ["direct connection on 5432 (no connection pooling, risks connection exhaustion)"]

  - id: task3-skip-commit
    choice: No commit for Task 3 — Redis assertion was already implemented by 01-05
    rationale: apps/worker/src/index.ts already contains the WHK-05 redis.config("GET", "maxmemory-policy") check; duplicating it would be incorrect
    alternatives: ["add duplicate check (wrong)", "amend prior commit (unsafe)"]
---

# Phase 1 Plan 6: Railway Deployment Summary

**One-liner:** Railway deployment configs (RAILPACK builder, migration pre-deploy for api, health check), full env var reference with Redis noeviction + PgBouncer port 6543 requirements, and an HMAC-signed bash webhook test script with duplicate detection verification.

## What Was Built

**Railway Deployment Configs:**

`apps/api/railway.toml` — Production deployment config for the Fastify webhook receiver:
- RAILPACK builder with monorepo-aware build command (db:generate + api build)
- `preDeployCommand` runs `db:migrate` before each deploy — ensures schema is current before api starts
- `/health` healthcheck endpoint with 30s timeout for Railway's health probing
- ON_FAILURE restart policy, max 3 retries

`apps/worker/railway.toml` — Production deployment config for the BullMQ worker process:
- RAILPACK builder with same monorepo-aware build command pattern
- No migration step — only api runs migrations to avoid concurrent migration conflicts
- ON_FAILURE restart policy, max 3 retries

**Environment Variable Reference (`docs/env-vars.md`):**

Comprehensive reference covering all 8 env vars across both services with:
- Railway-specific private key `\n` normalization guidance (awk command + explanation of getApp() normalization)
- Redis Server Configuration section (WHK-05): `maxmemory-policy=noeviction` and `appendonly=yes` as infrastructure requirements with rationale
- Database Connection Pooling section (TEN-05): PgBouncer port 6543, `connection_limit=1` requirement for Prisma, transaction-mode rationale (set_config TRUE flag compatibility)
- GitHub App permissions table and webhook event subscription list

**End-to-End Test Script (`scripts/test-webhook.sh`):**

Executable bash script for verifying webhook delivery against a running api instance:
- Sends `installation.created` payload with HMAC-SHA256 signature via openssl
- Verifies 202 response (acceptance + async processing)
- Tests duplicate detection: resends same delivery ID, verifies still returns 202 (deduped, not rejected)
- Configurable via `API_URL`, `WEBHOOK_SECRET`, `DELIVERY_ID` env vars
- Includes Redis queue length check hint for job verification

## Deviations from Plan

None — plan executed exactly as written. Task 3 had no commit because the Redis maxmemory-policy assertion was already fully implemented by 01-05.

## Decisions Made

| ID | Decision | Rationale |
|----|----------|-----------|
| api-only-runs-migrations | Only api/railway.toml has preDeployCommand for db:migrate | Prevents concurrent migration race conditions on simultaneous deploys |
| railpack-builder | RAILPACK for both services | Railway's next-gen builder; auto-detects pnpm workspaces |
| private-key-normalization | Document awk PEM → Railway format; getApp() normalizes back | Railway env vars are single-line; PEM keys must have newlines escaped |
| noeviction-redis-requirement | Documented + worker logs WARNING | WHK-05: BullMQ jobs must never be silently evicted |
| pgbouncer-port-6543 | Port 6543 + connection_limit=1 documented as required | TEN-05: PgBouncer transaction mode on Railway; Prisma pooling conflict without limit |

## Next Phase Readiness

- Phase 1 is complete — all 6 plans done
- To deploy: set env vars per docs/env-vars.md, configure Redis in Railway settings panel, link Railway services to repo
- Run `./scripts/test-webhook.sh` against deployed api URL to verify end-to-end delivery
- Phase 2 (Detector Pipeline) can proceed — foundation is complete

## Metrics

- **Duration:** ~3m
- **Tasks:** 3/3 (Task 3 verified, no new commit)
- **Commits:** 2 (e715a11, 77b91f9)
- **Completed:** 2026-07-13
