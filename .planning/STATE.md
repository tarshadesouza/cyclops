# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-13)

**Core value:** When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time across the organization.
**Current focus:** Phase 2 — Detector Pipeline & AI Analysis

## Current Position

Phase: 1 of 5 (GitHub App Foundation) — COMPLETE
Plan: 6 of 6 in phase 1 — COMPLETE
Status: Phase 1 complete — ready for Phase 2
Last activity: 2026-07-13 — Completed 01-06-PLAN.md (Railway deployment configs, env docs, e2e test script)

Progress: [██████░░░░] 23% (6/26 estimated plans)

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 4m 27s
- Total execution time: ~27 minutes

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. GitHub App Foundation | 6/6 | ~27m | 4m 27s |

**Recent Trend:**
- Last 6 plans: 01-01 (3m 8s), 01-02 (2m 52s), 01-03 (9m), 01-04 (2m 52s), 01-05 (2m 46s), 01-06 (~3m)
- Phase 1 complete in ~27 minutes total

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Init]: TypeScript monorepo (Turborepo + pnpm), Fastify, BullMQ + Redis, PostgreSQL + Prisma, Vercel AI SDK
- [Init]: No dashboard in MVP — all user output via GitHub (PR comments, check runs) and Slack
- [Init]: Split-process architecture — `apps/api` (webhook receiver) and `apps/worker` (BullMQ pipeline) are separate Railway services
- [Init]: `packages/core` must be I/O-free — no Octokit, Redis, or Prisma; required for SDK publishability
- [Init]: Permission scope locked before Phase 1 ships — `checks:write`, `contents:write`, `pull_requests:write`, `issues:write`, `actions:write`, `metadata:read`
- [01-01]: Turborepo 2 tasks key schema (not pipeline) — v2 deprecated pipeline; tasks key required
- [01-01]: module: nodenext + moduleResolution: nodenext — full ESM correctness in Node.js 22
- [01-01]: composite: true across all packages — enables tsc --build project references for correct build ordering
- [01-02]: set_config with TRUE (transaction-local) — PgBouncer-safe RLS context injection; plain SET leaks across connections
- [01-02]: Prisma 7 generator name is prisma-client (not prisma-client-js) — breaking change in Prisma 7
- [01-02]: Generated output at ../src/generated — inside src so TypeScript includes it without extra config
- [01-02]: createRequire(import.meta.url) for generated client — ESM package requires this pattern; bare require() unavailable in module:nodenext files
- [01-02]: prisma.config.ts excluded from tsconfig include — Prisma runs it via its own TS executor; rootDir:src would cause TS2560
- [01-03]: maxRetriesPerRequest: null on ioredis — BullMQ throws at worker startup if omitted; enforced in getRedis() singleton
- [01-03]: Job payloads contain identifiers only — secrets/content fetched at execution time; never stored in Redis
- [01-03]: Private key \n normalization in getApp() — Railway stores PEM keys with literal backslash-n; normalized before App instantiation
- [01-03]: target changed from es2025 to esnext in tsconfig.base.json — TypeScript 5.9.3 does not accept es2025 as a --target value
- [01-03]: pnpm.overrides for ioredis unification — BullMQ pinned 5.10.1, queue package used 5.11.1; type mismatch resolved via root override
- [01-04]: rawBodyPlugin must be registered first — Fastify processes plugins in registration order; raw-body must intercept before content-type parser
- [01-04]: ioredis set() EX before NX — v5 overloads require secondsToken "EX" before nx "NX"; reversed order fails type-check
- [01-04]: tsconfig references required for workspace packages — apps/api must declare references to @ciintel/* for tsc --noEmit to resolve imports
- [01-04]: Redis dedup key TEN-03 namespace — installation:{installationId}:delivery:{deliveryId} EX 259200 covers GitHub 72h redelivery window
- [01-05]: checkInstallationActive gate runs at every job start — TEN-04: no side effects for inactive installations; called before any DB write
- [01-05]: upsert for installation.created — idempotent; handles reinstalls and webhook redelivery without duplicate key errors
- [01-05]: drain on installation.deleted — iterate waiting/delayed jobs across queues; job-level gate alone still processes them
- [01-05]: DLQ routing via onFailed — BullMQ has no native DLQ; second onFailed handler routes exhausted-retry jobs (attemptsMade >= maxAttempts) to dlqQueue
- [01-06]: Only api runs db:migrate (preDeployCommand) — prevents concurrent migration race conditions on simultaneous service deploys
- [01-06]: RAILPACK builder for both services — Railway's next-gen builder; auto-detects pnpm workspaces
- [01-06]: noeviction Redis requirement documented + worker WARNING — WHK-05: BullMQ jobs must never be silently evicted
- [01-06]: PgBouncer port 6543 + connection_limit=1 documented — TEN-05: required for Prisma on Railway managed PostgreSQL

### Pending Todos

- After DATABASE_URL is set: run db:migrate:dev, db:generate, then uncomment type exports in packages/db/src/index.ts
- Pre-deploy: configure Railway Redis maxmemory-policy=noeviction and appendonly=yes
- Pre-deploy: set DATABASE_URL to port 6543 (PgBouncer) in production Railway env
- Pre-deploy: run ./scripts/test-webhook.sh to verify end-to-end delivery

### Blockers/Concerns

- [Research]: PgBouncer deployment model — documented in docs/env-vars.md; Railway managed Postgres uses built-in PgBouncer on port 6543 (transaction mode)
- [Research]: LLM provider default and BYOK model undecided — platform default key with token caps vs. every installation provides own key
- [Research]: Confidence threshold starting values (0.7 for PR comment, 0.9 for fix PR) need empirical calibration in Phase 2

## Session Continuity

Last session: 2026-07-13T09:38Z
Stopped at: Completed 01-06-PLAN.md — Railway deployment configs, env var documentation, e2e webhook test script. Phase 1 complete.
Resume file: None
