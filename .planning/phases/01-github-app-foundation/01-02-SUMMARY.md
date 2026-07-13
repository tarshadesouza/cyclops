---
phase: 01-github-app-foundation
plan: 02
subsystem: database
tags: [prisma, postgresql, rls, tenant-isolation, pgbouncer, adapter-pg]
requires:
  - 01-01 (monorepo scaffold, packages/db stub)
provides:
  - Prisma 7 schema with Installation and WebhookDelivery models
  - Two migration SQL files (initial DDL + RLS setup)
  - getDb() singleton using PrismaPg adapter
  - getTenantClient(installationId) with $allOperations RLS injection
  - Tenant isolation at both Prisma extension and PostgreSQL RLS layers
affects:
  - 01-04-webhook-receiver (uses getTenantClient to scope webhook upserts)
  - 01-05-webhook-worker (uses getTenantClient per job, scoped to installationId)
  - 01-06-railway-deployment (requires DATABASE_URL and db:migrate:dev + db:generate)
tech-stack:
  added:
    - prisma@7
    - "@prisma/adapter-pg"
    - pg@8
  patterns:
    - Prisma driver adapter pattern (adapter-pg, required in Prisma 7)
    - $allOperations extension for cross-cutting RLS context injection
    - Transaction-local set_config for PgBouncer-safe tenant isolation
    - createRequire(import.meta.url) for ESM-compatible deferred require of generated client
key-files:
  created:
    - packages/db/prisma/schema.prisma
    - packages/db/prisma.config.ts
    - packages/db/prisma/migrations/0001_initial/migration.sql
    - packages/db/prisma/migrations/0002_rls/migration.sql
    - packages/db/src/client.ts
    - packages/db/src/extensions/tenant.ts
    - packages/db/README.md
  modified:
    - packages/db/src/index.ts (replaced stub with real exports)
    - packages/db/tsconfig.json (removed prisma.config.ts from include; rootDir is src)
decisions:
  - key: set_config-transaction-local
    choice: "set_config('app.current_installation_id', $1, TRUE)"
    rationale: TRUE makes the setting transaction-local — safe with PgBouncer in transaction mode; plain SET leaks context across connections
  - key: prisma-client-generator-name
    choice: "generator prisma-client (not prisma-client-js)"
    rationale: Prisma 7 breaking change — generator name must be prisma-client with explicit output path
  - key: generated-output-path
    choice: "../src/generated"
    rationale: Output inside src/ so TypeScript compilation and type exports work without special tsconfig include paths
  - key: esm-createRequire
    choice: createRequire(import.meta.url) instead of bare require()
    rationale: package.json has type:module and tsconfig uses module:nodenext; bare require() is not available in ESM; createRequire is the standard Node.js ESM pattern
  - key: prisma-config-excluded-from-tsconfig
    choice: Remove prisma.config.ts from tsconfig include
    rationale: tsconfig rootDir is src; including a file outside rootDir causes TS error. Prisma runs prisma.config.ts with its own TypeScript execution (tsx/ts-node), not our tsc build.
metrics:
  duration: 2m 52s
  completed: "2026-07-13"
---

# Phase 01 Plan 02: Database Layer Summary

**One-liner:** Prisma 7 schema with Installation + WebhookDelivery models, PgBouncer-safe RLS via transaction-local set_config, and a $allOperations tenant extension that auto-scopes every query to an installationId.

## What Was Built

The `@ciintel/db` package is the single source of truth for tenant data isolation in CyclOps. Every worker job and API handler calls `getTenantClient(installationId)` to get a scoped client — the Prisma extension layer AND the PostgreSQL RLS layer both enforce that only rows belonging to the current installation are visible.

### Prisma Schema

Two models:
- `Installation` — GitHub App installation record (id is the GitHub installation integer ID)
- `WebhookDelivery` — deduplication table for incoming webhook events (deliveryId is unique)

Generator uses `prisma-client` (Prisma 7 name, not `prisma-client-js`) with explicit `output: ../src/generated`.

### Migrations

- **0001_initial** — DDL: both tables with FK, indexes, unique constraint
- **0002_rls** — RLS: ENABLE + FORCE on both tables, tenant isolation policies using `current_installation_id()` helper function, service bypass policy for the `postgres` superuser role

### Client Factory

`getDb()` — singleton `PrismaClient` using `@prisma/adapter-pg` driver adapter (mandatory in Prisma 7). Uses `createRequire(import.meta.url)` to load the generated client at runtime in an ESM package.

`getTenantClient(installationId)` — extends the singleton with `$allOperations` to wrap every query in a `$transaction` that first calls `set_config('app.current_installation_id', ..., TRUE)` (TRUE = transaction-local scope).

## Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| set_config flag | TRUE (transaction-local) | PgBouncer in transaction mode reuses connections; session-scoped SET leaks tenant context to next user |
| Generator name | prisma-client | Prisma 7 breaking change; prisma-client-js fails |
| Generated output | ../src/generated | Inside src so TypeScript compilation includes it without extra tsconfig paths |
| ESM require | createRequire(import.meta.url) | module:nodenext + type:module means bare require() is unavailable |
| prisma.config.ts | Excluded from tsconfig include | rootDir:src would cause TS2560; Prisma uses its own TS execution |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed prisma.config.ts from tsconfig include**

- **Found during:** Task 2 (pre-tsc check)
- **Issue:** tsconfig.json included `prisma.config.ts` in its include array but had `rootDir: "src"`. Including a file outside rootDir causes TS2560: "File is not under rootDir". Prisma 7 executes prisma.config.ts via its own TypeScript runner, not our tsc build.
- **Fix:** Removed `prisma.config.ts` from the `include` array in `packages/db/tsconfig.json`
- **Files modified:** packages/db/tsconfig.json
- **Commit:** 5e20a89

**2. [Rule 3 - Blocking] Used createRequire instead of bare require()**

- **Found during:** Task 2 (implementation)
- **Issue:** Plan specified `require("./generated/index.js")` directly, but with `"module": "nodenext"` and `"type": "module"` in package.json, bare `require` is not available in TypeScript ESM files.
- **Fix:** Used `createRequire(import.meta.url)` from `node:module` — the standard Node.js pattern for using require() in ESM modules.
- **Files modified:** packages/db/src/client.ts
- **Commit:** b56df71

## Next Phase Readiness

**Provides to 01-03:** packages/db is fully scaffolded; queue and GitHub packages can import @ciintel/db.

**Pending before first deploy:**
1. Set DATABASE_URL
2. Run `db:migrate:dev` (creates tables + RLS)
3. Run `db:generate` (generates Prisma client to src/generated/)
4. Uncomment type exports in src/index.ts

**Open research item carried forward:** PgBouncer deployment model (Railway managed Postgres has no PgBouncer; transaction-local set_config is ready for when PgBouncer is added as sidecar or via Supabase).
