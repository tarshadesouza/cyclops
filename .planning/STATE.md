# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-13)

**Core value:** When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time across the organization.
**Current focus:** Phase 1 — GitHub App Foundation

## Current Position

Phase: 1 of 5 (GitHub App Foundation)
Plan: 5 of 6 in current phase
Status: In progress
Last activity: 2026-07-13 — Completed 01-05-PLAN.md (BullMQ webhook worker with TEN-04 gate)

Progress: [█████░░░░░] 19% (5/26 estimated plans)

## Performance Metrics

**Velocity:**
- Total plans completed: 5
- Average duration: 4m 32s
- Total execution time: ~23 minutes

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. GitHub App Foundation | 5/6 | ~23m | 4m 36s |

**Recent Trend:**
- Last 5 plans: 01-01 (3m 8s), 01-02 (2m 52s), 01-03 (9m), 01-04 (2m 52s), 01-05 (2m 46s)
- Trend: 01-05 fast — tsconfig references pattern now established across apps

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

### Pending Todos

- After DATABASE_URL is set: run db:migrate:dev, db:generate, then uncomment type exports in packages/db/src/index.ts

### Blockers/Concerns

- [Research]: PgBouncer deployment model undecided — Railway managed Postgres does not include PgBouncer; transaction-local set_config is ready; decide sidecar vs Supabase vs external before deploy
- [Research]: LLM provider default and BYOK model undecided — platform default key with token caps vs. every installation provides own key
- [Research]: Confidence threshold starting values (0.7 for PR comment, 0.9 for fix PR) need empirical calibration in Phase 2

## Session Continuity

Last session: 2026-07-13T09:32Z
Stopped at: Completed 01-05-PLAN.md — BullMQ webhook worker (WebhookIngestionWorker concurrency=20, TEN-04 gate, DLQ worker, SIGTERM shutdown)
Resume file: None
