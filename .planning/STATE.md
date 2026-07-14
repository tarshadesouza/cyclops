# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-13)

**Core value:** When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time across the organization.
**Current focus:** Phase 5 — Slack Integration & Marketplace

## Current Position

Phase: 5 of 5 (Slack Integration & Marketplace) — In progress
Plan: 1/? complete
Status: Phase 5 started — billing+Slack schema foundation, billing-state.ts, billingQueue wired
Last activity: 2026-07-14 — Completed 05-01 (Installation billing/Slack fields, migration 0005, billing state machine, billingQueue)

Progress: [█████████████████████░] 97% (29/~30 estimated plans)

## Performance Metrics

**Velocity:**
- Total plans completed: 15
- Average duration: 4m 1s
- Total execution time: ~60 minutes

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. GitHub App Foundation | 6/6 | ~27m | 4m 27s |
| 2. Detector Pipeline & AI Analysis | 7/7 | ~28m | 4m 0s |
| 3. Action Engine & Output Channels | 7/7 | ~24m | 3m 25s |
| 4. Public SDK | 4/~6 | ~25m | ~6m 15s |

**Recent Trend:**
- Last 19 plans: 01-01 (3m 8s), 01-02 (2m 52s), 01-03 (9m), 01-04 (2m 52s), 01-05 (2m 46s), 01-06 (~3m), 02-01 (4m 21s), 02-02 (3m 1s), 02-03 (5m), 02-04 (1m 59s), 02-05 (4m 53s), 02-06 (2m 42s), 02-07 (6m 44s), 03-01 (3m 29s), 03-02 (4m 22s), 03-03 (3m), 03-04 (3m 11s), 03-06 (3m), 03-07 (5m)
- Phase 1 complete in ~27 minutes total; Phase 2 complete in ~28 minutes total

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
- [02-06]: actionType='phase3-placeholder' in ActionExecutionJob — schema accepts z.string(); Phase 3 will define real action types [RESOLVED 03-02]
- [03-02]: fetchConfig uses duck-typed octokit interface — no direct @ciintel/github dep in loader.ts; caller passes octokit instance
- [03-02]: yaml.load() used (not yaml.safeLoad()) — js-yaml v4 removed safeLoad; yaml.load() is the v4 API
- [03-02]: On any fetch/parse error, fetchConfig falls back to CyclopsConfigSchema.parse({}) — zero-config CFG-04 requirement
- [03-02]: detectorType→actionType mapping in ai-analysis.ts: lint→create-autofix-pr-lint, else→update-check-run
- [02-07]: Anthropic API keys are BYOK only — no global ANTHROPIC_API_KEY env var; model is claude-sonnet-5
- [02-07]: CYCLOPS_ENCRYPTION_KEY required in both services and must match — AES-256-GCM shared secret for BYOK key encryption at rest
- [02-07]: e2e checkpoint approved without live infra — build verified clean; runtime verification deferred to first deploy
- [03-01]: Migration created manually as SQL — no local PostgreSQL; follows hand-authored pattern from 0003_phase2; applied via prisma migrate resolve on deploy
- [03-01]: New dedup/tracking tables have no @relation FK to Installation — RLS installationId isolation sufficient; FK deferred for high-write tables
- [03-01]: actionParams removed from ActionExecutionJobSchema — handlers load all context via findingId from DB; identifier-only job payloads enforced
- [03-03]: HANDLERS map has all 8 ActionType stubs at creation — future plans replace stubs; no handler lookup can fail at runtime
- [03-03]: Kill switch order: per-detector gate first, then per-action-type gate (prComments/checkRuns/autofix)
- [03-03]: getActionTypes base set always includes update-check-run + upsert-pr-comment — every finding surfaces to developer regardless of detector
- [03-03]: ACTION_TYPES and ActionType were missing from @ciintel/queue public index.ts exports — added (Rule 3 fix)
- [03-04]: HandlerResult union uses literal true — return sites use `as const` to satisfy TS discriminated union
- [03-04]: ActionContext extended with db + log — handlers need both; added as Rule 2 auto-fix
- [03-04]: conclusion: neutral (not success) when confidence < confidenceThreshold — avoids false green signal
- [03-04]: PR comment body consolidates all findings for workflowRunId — one comment per PR updated on each finding
- [03-05]: ref normalization strips refs/heads/ prefix — Finding stores full ref but GitHub PR base parameter requires branch name only
- [03-05]: isValidFileContent Snapshot check requires exports[ or // Jest — deliberately strict to prevent AI prose committed as source code
- [03-05]: Guard order: confidence → sanity → dedup → rate limit → execution — cheapest/most certain checks first
- [03-06]: checkActionDedup uses findFirst with expiresAt filter, not findUnique — TTL check must be part of the query
- [03-06]: TrackedIssue used for GitHub Issue dedup (not ActionDedup) — githubIssueNumber stored to route repeat failures to comments
- [03-06]: Slack webhookUrl: config.notifications.slack.webhookUrl takes precedence, falls back to SLACK_WEBHOOK_URL env var
- [03-06]: HandlerResult discriminated union requires skipped: true as const and ok: true as const at all return sites
- [03-07]: ActionDedup cleanup runs after handler success (not finally) — avoids DB write pressure on error/retry paths
- [03-07]: 1% probability cleanup sufficient to bound table growth without measurable per-job latency
- [03-07]: All 8 handler dedup strategies confirmed present — no gaps found in audit
- [04-01]: tsconfig references are path-based — zero changes needed for scope rename
- [04-01]: pnpm-workspace.yaml and turbo.json require no changes — globs and task names are name-agnostic
- [04-01]: @cyclops/* is the stable npm scope for all workspace packages; root package is cyclops (no scope)
- [04-02]: crypto moved to @cyclops/internal (private:true) — node:crypto + process.env disqualify it from publishable SDK; I/O-free boundary enforced in @cyclops/core
- [04-02]: DetectorType/Violation/DetectorResult relocated to detector.ts alongside IDetector/DetectorContext — avoids circular imports
- [04-02]: DetectorInput kept as type alias for DetectorContext — 6 detector implementation files compile unchanged via structural compatibility
- [04-03]: composite:false + incremental:false in core tsconfig — tsup DTS fails with composite+incremental (TS5074, TS6307); tsup owns all JS/DTS emission
- [04-03]: @cyclops/core removed from all downstream tsconfig project references — composite:false makes core ineligible as tsc project reference; consumers get types from dist/index.d.ts
- [04-03]: publishConfig.access:public + repository placeholder — required for npm OIDC trusted publisher; actual org/repo filled in before first publish
- [04-04]: attw@^0.18.5 required — 0.17.x and below crash on Node.js v25 (fflate Gunzip streaming incompatibility in untar.js; unzipped undefined)
- [04-04]: engines.node >= 22 added to @cyclops/core — publint --strict elevates missing engines to error
- [04-04]: repository.url git+ prefix required — publint --strict requires full git protocol prefix in repository.url
- [04-04]: validate-sdk job has no continue-on-error — hard blocking gate; any publint/attw error fails CI
- [05-01]: billingStatus defaults to 'trial' at DB level — all new installations start on trial; marketplace purchase upgrades to active
- [05-01]: targetId @unique required for marketplace upsert-by-account (ON CONFLICT DO UPDATE via Prisma upsert where targetId)
- [05-01]: deriveTransition placeholder for future-dated cancellations — billingStatus:'trial' returned; caller must issue partial update setting only billingCancelAt
- [05-01]: Lazy billing expiry: status written to DB on first job arrival after expiry date, no cron required
- [05-01]: @cyclops/core renamed to @tdesouza/cyclops in Phase 4; stale import in ai-analysis.ts fixed (Rule 3)

### Pending Todos

- Pre-deploy: apply DATABASE_URL then run `pnpm --filter @cyclops/db db:migrate` (migrations 0003_phase2 and 0004_phase3_action_tables)
- Pre-deploy: configure Railway Redis maxmemory-policy=noeviction and appendonly=yes
- Pre-deploy: set DATABASE_URL to port 6543 (PgBouncer) in production Railway env
- Pre-deploy: run ./scripts/test-webhook.sh to verify end-to-end delivery
- Pre-deploy: generate CYCLOPS_ENCRYPTION_KEY with `openssl rand -hex 32` (64-hex-char AES-256 key) — set in BOTH services
- Pre-deploy: generate CYCLOPS_SETUP_SECRET with `openssl rand -hex 32` (setup endpoint shared secret) — apps/api only
- Pre-deploy: register BYOK key via `POST /setup/:installationId` with x-setup-token after first deploy
- Pre-deploy verify Criterion 1: Single PR comment per PR, PATCH on subsequent failures — trigger failing workflow on PR, confirm one cyclops[bot] comment edited in-place
- Pre-deploy verify Criterion 2: GitHub Check Run visible in PR Checks tab with pass/fail status and markdown summary
- Pre-deploy verify Criterion 3: High-confidence Lint failure → autofix PR within 2 minutes; duplicate suppressed within 24h
- Pre-deploy verify Criterion 4: autofix: false in .cyclops.yml suppresses autofix PR within 60 seconds (cache TTL)
- Pre-deploy verify Criterion 5: Zero-config installation (no .cyclops.yml) produces PR comment + check run with sensible defaults

### Blockers/Concerns

- [Research]: PgBouncer deployment model — documented in docs/env-vars.md; Railway managed Postgres uses built-in PgBouncer on port 6543 (transaction mode)
- [Resolved 02-04]: LLM provider default and BYOK model — BYOK path implemented via POST /setup/:installationId; decryptApiKey available in @ciintel/core for worker use
- [Deferred 02-07]: Confidence threshold calibration — starting values (>=0.85 advance, <0.85 store-only) need empirical tuning after Phase 3 ships real action types
- [Deferred 02-07]: Live e2e pipeline verification — 6-point checklist approved without infra; must be run before production launch

## Session Continuity

Last session: 2026-07-14
Stopped at: Completed 05-01-PLAN.md — billing+Slack schema fields, migration 0005, billing-state.ts, billingQueue, lazy expiry gate in checkInstallationActive
Resume file: None
