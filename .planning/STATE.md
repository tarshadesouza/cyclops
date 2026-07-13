# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-13)

**Core value:** When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time across the organization.
**Current focus:** Phase 2 — Detector Pipeline & AI Analysis

## Current Position

Phase: 2 of 5 (Detector Pipeline & AI Analysis) — In progress
Plan: 6 of ~8 in phase 2 — COMPLETE
Status: In progress — Full Phase 2 pipeline functional (webhook → detector → AI → action routing)
Last activity: 2026-07-13 — Completed 02-06-PLAN.md (AiAnalysisWorker: budget gate, BYOK decrypt, analyzeFailure, TokenUsage, confidence>=0.85 routing to action-execution; concurrency=5)

Progress: [██████████░] 46% (12/26 estimated plans)

## Performance Metrics

**Velocity:**
- Total plans completed: 12
- Average duration: 4m 0s
- Total execution time: ~48 minutes

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. GitHub App Foundation | 6/6 | ~27m | 4m 27s |
| 2. Detector Pipeline & AI Analysis | 6/~8 | ~21m | 3m 30s |

**Recent Trend:**
- Last 12 plans: 01-01 (3m 8s), 01-02 (2m 52s), 01-03 (9m), 01-04 (2m 52s), 01-05 (2m 46s), 01-06 (~3m), 02-01 (4m 21s), 02-02 (3m 1s), 02-03 (5m), 02-04 (1m 59s), 02-05 (4m 53s), 02-06 (2m 42s)
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
- [02-01]: Prisma 7.8.0 datasource url removal — url moved from schema.prisma to prisma.config.ts migrate.adapter; client.ts uses PrismaPg adapter directly, unaffected
- [02-01]: Prisma 7 generated entry point is client.ts (not index.js) — model types (Installation, Finding, etc.) exported directly from client.ts
- [02-01]: findingId replaces failureType in AiAnalysisJobSchema — identifier-only payload; AI worker fetches log content from DB at execution time, never from Redis
- [02-01]: encryptedApiKey String? is nullable — platforms without BYOK use the platform default Anthropic key
- [02-02]: TEST_FAILURE_PATTERNS exported from flaky-test.ts and imported by test-failure.ts — single source of truth prevents pattern drift between mutually exclusive detectors
- [02-02]: detectFlakyTest empty history returns notMatched — first-ever run cannot be classified as flaky by definition
- [02-02]: detectLint returns notMatched when no linter inferred from workflow YAML — prevents false positives
- [02-03]: ai@7.0.18 + @ai-sdk/anthropic@4.0.10 used — plan's ^7.0.19 non-existent, ^2.0.0 now major version 4; both resolved to latest compatible
- [02-03]: zod@^3.25.76 required — ai@7 peer dep raises minimum from plan's ^3.24.0
- [02-03]: ai@7 renamed usage fields: inputTokens/outputTokens → mapped to promptTokens/completionTokens in AnalyzeResult for stable caller API
- [02-03]: Loose db interface in checkTokenBudget — accepts {$queryRaw} duck type so @ciintel/ai never imports @ciintel/db
- [02-04]: Encryption lives in @ciintel/core (not apps/worker) — both apps/api (encrypt on store) and apps/worker (decrypt on use) share one implementation
- [02-04]: timingSafeEqual length-mismatch guard — tokenHeader.length === setupSecret.length check before compare prevents RangeError on mismatched buffers
- [02-05]: Octokit type derived from Awaited<ReturnType<typeof getInstallationClient>> — @octokit/core not in worker deps; deriving from clients.ts avoids adding it
- [02-05]: workflowRunId ?? checkRunId fallback — DetectorDispatchJobSchema.workflowRunId is optional; Finding model requires non-null Int
- [02-05]: DB-stored payload lookup in webhook-ingestion — payload loaded from webhookDelivery table so Redis job payload stays identifier-only
- [02-05]: workflow_run preferred over check_run — lower cardinality (one per run vs one per job); check_run kept as fallback
- [02-06]: ai-analysis worker concurrency=5 — AI calls are latency-bound; lower concurrency avoids rate-limit storms
- [02-06]: Rethrow on analyzeFailure error — BullMQ handles retry/DLQ; prevents partial Finding state
- [02-06]: TokenUsage.inputTokens mapped from result.usage.promptTokens — matches ai@7 field rename already handled in analyze.ts
- [02-06]: actionType='phase3-placeholder' in ActionExecutionJob — schema accepts z.string(); Phase 3 will define real action types

### Pending Todos

- After DATABASE_URL is set: run db:migrate to apply 0003_phase2 (findings, token_usages, encryptedApiKey)
- Pre-deploy: configure Railway Redis maxmemory-policy=noeviction and appendonly=yes
- Pre-deploy: set DATABASE_URL to port 6543 (PgBouncer) in production Railway env
- Pre-deploy: run ./scripts/test-webhook.sh to verify end-to-end delivery
- Pre-deploy: generate CYCLOPS_ENCRYPTION_KEY with `openssl rand -hex 32` (64-hex-char AES-256 key)
- Pre-deploy: generate CYCLOPS_SETUP_SECRET with `openssl rand -hex 32` (setup endpoint shared secret)

### Blockers/Concerns

- [Research]: PgBouncer deployment model — documented in docs/env-vars.md; Railway managed Postgres uses built-in PgBouncer on port 6543 (transaction mode)
- [Resolved 02-04]: LLM provider default and BYOK model — BYOK path implemented via POST /setup/:installationId; decryptApiKey available in @ciintel/core for worker use
- [Research]: Confidence threshold starting values (0.7 for PR comment, 0.9 for fix PR) need empirical calibration in Phase 2

## Session Continuity

Last session: 2026-07-13T14:02Z
Stopped at: Completed 02-06-PLAN.md — AiAnalysisWorker (budget gate, BYOK decrypt, analyzeFailure call, TokenUsage.create, empty-evidence guard, Finding enrichment, confidence>=0.85 action routing, DLQ, concurrency=5); registered in index.ts.
Resume file: None
