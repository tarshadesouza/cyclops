---
phase: 01-github-app-foundation
plan: "05"
subsystem: worker
tags: [bullmq, worker, ten-04, installation, dlq, pino, redis, concurrency]

dependency-graph:
  requires: ["01-02", "01-03"]
  provides: ["apps/worker webhook ingestion worker", "TEN-04 installation gate", "DLQ worker"]
  affects: ["01-06"]

tech-stack:
  added: ["pino@9"]
  patterns: ["TEN-04 gate pattern (checkInstallationActive at every job start)", "DLQ routing via onFailed handler", "queue drain on installation delete", "upsert for idempotent created events"]

key-files:
  created:
    - apps/worker/src/lib/installation.ts
    - apps/worker/src/workers/dlq.ts
    - apps/worker/src/workers/webhook-ingestion.ts
    - apps/worker/.env.example
  modified:
    - apps/worker/src/index.ts
    - apps/worker/tsconfig.json

decisions:
  - id: checkInstallationActive-gate
    choice: checkInstallationActive() called at the start of every job before any database write
    rationale: TEN-04 requirement — suspended/deleted tenants must be dropped at execution time; no side effects should occur for inactive installations
    alternatives: ["check in enqueue path (api)", "check in each handler separately"]

  - id: upsert-for-created
    choice: db.installation.upsert() for installation.created events
    rationale: Idempotent — GitHub may redeliver webhooks; upsert prevents duplicate key errors and also handles reinstall (unsetting deletedAt)
    alternatives: ["create with catch for duplicate", "findFirst then create"]

  - id: drain-on-delete
    choice: Iterate waiting+delayed jobs across all queues and remove those matching installationId
    rationale: TEN-04 requires draining queued work for deleted installations; job-level check alone would still process them
    alternatives: ["rely solely on job-level gate", "BullMQ obliterate per-queue filter (not available)"]

  - id: dlq-onFailed-routing
    choice: Second worker.on("failed") handler checks attemptsMade >= maxAttempts and adds to dlqQueue
    rationale: BullMQ doesn't have native DLQ; onFailed fires on every retry failure; only route when retries are exhausted
    alternatives: ["separate DLQ queue with BullMQ addFailedPolicy", "periodic cron to scan failed jobs"]

  - id: tsconfig-project-references
    choice: Added project references to apps/worker/tsconfig.json (Rule 3 fix — was missing, causing TS2307)
    rationale: api tsconfig already had these; worker was scaffolded without them in plan 01-01; needed for tsc to resolve workspace packages
    alternatives: ["build all packages first as pre-step"]
---

# Phase 1 Plan 5: Webhook Worker Summary

**One-liner:** BullMQ WebhookIngestionWorker with TEN-04 gate (checkInstallationActive), installation lifecycle handlers, queue drain on delete, DLQ routing via onFailed, and Redis maxmemory-policy assertion.

## What Was Built

Two workers and their supporting infrastructure for the `apps/worker` process:

**TEN-04 Installation Gate** (`src/lib/installation.ts`): `checkInstallationActive()` queries the database for the installation and returns `{ active: false, reason }` if the installation is not found, deleted (deletedAt set), or suspended. Every webhook ingestion job calls this before doing any work.

**DLQ Worker** (`src/workers/dlq.ts`): Consumes the `dlq` queue (concurrency=5) and logs all dead-letter jobs with full context — jobId, jobName, data, failedReason, and attemptsMade.

**WebhookIngestionWorker** (`src/workers/webhook-ingestion.ts`): Consumes `webhook-ingestion` queue at concurrency=20. For each job:
1. Validates payload with `WebhookIngestionJobSchema.safeParse`
2. Calls `checkInstallationActive` (TEN-04 gate)
3. Routes `installation.*` events to lifecycle handlers (created/deleted/suspend/unsuspend)
4. Stubs `installation_repositories` and CI events for Phase 2
5. Second `onFailed` handler routes exhausted-retry jobs to `dlqQueue`

**Installation lifecycle handlers:**
- `created` → `db.installation.upsert()` (idempotent, handles reinstall)
- `deleted` → sets `deletedAt`, drains waiting/delayed jobs across all queues
- `suspend` → sets `suspended: true`
- `unsuspend` → sets `suspended: false`

**Worker bootstrap** (`src/index.ts`): Starts both workers, WHK-05 Redis maxmemory-policy assertion on startup, graceful SIGTERM/SIGINT shutdown.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added project references to apps/worker/tsconfig.json**

- **Found during:** Task 2 TypeScript verification (`tsc --noEmit` returned TS2307 on @ciintel/db)
- **Issue:** Worker tsconfig had no project references; api tsconfig had them for all 4 packages; worker was scaffolded without them in plan 01-01
- **Fix:** Added `references` array with all 4 workspace packages (core, db, github, queue); also built @ciintel/db since its `dist/` was missing
- **Files modified:** `apps/worker/tsconfig.json`
- **Commit:** d488c3c

## Decisions Made

| ID | Decision | Rationale |
|----|----------|-----------|
| checkInstallationActive-gate | Called at every job start before any DB write | TEN-04: no side effects for inactive tenants |
| upsert-for-created | db.installation.upsert() for created events | Idempotent; handles reinstalls and webhook redelivery |
| drain-on-delete | Iterate queue jobs and remove by installationId | Job-level gate alone still processes them; drain enforces TEN-04 at enqueue time |
| dlq-onFailed-routing | Second onFailed handler checks attemptsMade >= maxAttempts | BullMQ has no native DLQ; must detect exhaustion in handler |
| tsconfig-project-references | Added to apps/worker/tsconfig.json | Worker was missing them; required for tsc to resolve workspace packages |

## Next Phase Readiness

- Plan 01-06 (Railway deployment) can proceed — worker process is complete
- Phase 2 will extend WebhookIngestionWorker to dispatch CI events to detector-dispatch queue
- `installation_repositories` handling stubbed with Phase 2 note

## Metrics

- **Duration:** 2m 46s
- **Tasks:** 2/2
- **Commits:** 2 (16195f3, d488c3c)
- **Completed:** 2026-07-13
