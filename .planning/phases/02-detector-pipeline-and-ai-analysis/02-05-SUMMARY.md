---
phase: 02-detector-pipeline-and-ai-analysis
plan: "05"
subsystem: worker-pipeline
tags: [github-actions-api, detector-dispatch, bullmq, rls, octokit, pino, unknown-fallback]

# Dependency graph
requires:
  - phase: 02-01
    provides: Finding Prisma model; getTenantClient RLS extension
  - phase: 02-02
    provides: runAllDetectors, DetectorResult, stripLogFormatting from @ciintel/detectors
  - phase: 01-05
    provides: checkInstallationActive gate, DLQ routing pattern
provides:
  - "apps/worker/src/lib/github-actions.ts: getRepoInfo, fetchFailedJobs, fetchWorkflowFile, fetchJobLogExcerpt, fetchCheckRunHistory"
  - "apps/worker/src/workers/detector-dispatch.ts: DetectorDispatchWorker — runs all detectors, stores tenant-scoped Finding, dispatches identifiers-only ai-analysis job"
  - "webhook-ingestion.ts: CI stub replaced with real workflow_run/check_run failure dispatch from DB-stored payload"
affects:
  - 02-06-ai-analysis-worker (consumes ai-analysis queue jobs with findingId)
  - 02-07-integration-verification (end-to-end flow tests this worker)

# Tech tracking
tech-stack:
  added:
    - "@ciintel/detectors: workspace:* (added to apps/worker dependencies)"
  patterns:
    - "Octokit type derived via Awaited<ReturnType<typeof getInstallationClient>> — avoids direct @octokit/core dep"
    - "Module-level Map cache for getRepoInfo — repository identity never changes, safe to cache indefinitely"
    - "Unknown fallback: allResults[0] ?? { detectorType: 'Unknown', ... } — no failure ever dropped"
    - "workflowRunId fallback: rawWorkflowRunId ?? checkRunId — handles optional field in schema"
    - "fetchJobLogExcerpt: URL-redirect vs text dual-shape handling for Octokit logs endpoint"
    - "fetchCheckRunHistory: try/catch returning [] — best-effort, never fails the job"
    - "pino redact: apiKey + encryptedApiKey at all nesting depths, censor [REDACTED]"
    - "Detector dispatch from DB-stored payload: DB read prevents re-fetching payload from Redis"

key-files:
  created:
    - apps/worker/src/lib/github-actions.ts
    - apps/worker/src/workers/detector-dispatch.ts
  modified:
    - apps/worker/src/workers/webhook-ingestion.ts
    - apps/worker/src/index.ts
    - apps/worker/package.json
    - apps/worker/tsconfig.json

# Decisions
decisions:
  - "[02-05]: Octokit type from Awaited<ReturnType<typeof getInstallationClient>> — @octokit/core not in worker deps; deriving from clients.ts avoids adding it"
  - "[02-05]: workflowRunId fallback to checkRunId — DetectorDispatchJobSchema.workflowRunId is optional; Finding model requires non-null Int"
  - "[02-05]: DB-stored payload lookup in webhook-ingestion — payload loaded from webhookDelivery table so Redis job payload stays identifier-only"
  - "[02-05]: workflow_run preferred over check_run — lower cardinality (one per run vs one per job); check_run kept as fallback"

# Metrics
metrics:
  duration: "4m 53s"
  completed: "2026-07-13"
  tasks-completed: 3
  tasks-total: 3
---

# Phase 2 Plan 05: Detector Dispatch Worker Summary

**One-liner:** GitHub Actions API lib + DetectorDispatchWorker wiring log fetch, runAllDetectors, tenant-scoped Finding creation, and identifiers-only ai-analysis dispatch with Unknown fallback.

## What Was Built

### Task 1: GitHub Actions API lib (`apps/worker/src/lib/github-actions.ts`)

Five Octokit-backed fetch helpers:

- **`getRepoInfo`** — numeric repository ID → owner/repo string pair, module-level Map cache
- **`fetchFailedJobs`** — latest-attempt jobs with `conclusion === 'failure'`, per_page=100
- **`fetchWorkflowFile`** — reads `run.path`, strips `@branch` suffix via `split('@')[0]`, base64-decodes via Contents API; returns `''` on 404
- **`fetchJobLogExcerpt`** — handles both URL-redirect and text response shapes from the Octokit logs endpoint; applies `stripLogFormatting`, caps 150 lines
- **`fetchCheckRunHistory`** — 5 branch-filtered + 20 unfiltered completed runs, matched by job name; returns `[]` on any error (best-effort)

### Task 2: `DetectorDispatchWorker` (`apps/worker/src/workers/detector-dispatch.ts`)

Pipeline per job:
1. `DetectorDispatchJobSchema.safeParse` — skip on invalid data
2. `checkInstallationActive` gate — TEN-04 compliance
3. `getInstallationClient` + `getRepoInfo` → owner/repo
4. `fetchFailedJobs` → loop: `fetchJobLogExcerpt` + `fetchCheckRunHistory` + `runAllDetectors`
5. `allResults[0]` or Unknown fallback (violations=[], rawExcerpt=firstJobLog)
6. `getTenantClient(installationId).finding.create` — RLS-isolated DB write
7. `aiAnalysisQueue.add('analyze', { ...identifiersOnly })` — no log content in Redis
8. DLQ routing on exhausted retries; concurrency=10

### Task 3: Webhook ingestion CI stub → real dispatch + worker registration

- **`webhook-ingestion.ts`**: Loads `webhookDelivery` from DB; handles `workflow_run` (preferred) and `check_run` (fallback) with `conclusion === 'failure'`; validates via `DetectorDispatchJobSchema.safeParse` before `detectorDispatchQueue.add`
- **`index.ts`**: `createDetectorDispatchWorker()` imported, started, added to shutdown `Promise.all`; pino logger extended with `redact` config for `apiKey`/`encryptedApiKey`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Octokit type derived from `getInstallationClient` return | Avoids adding `@octokit/core` directly to worker deps |
| `workflowRunId ?? checkRunId` fallback | Schema field is optional; Finding model requires non-null |
| DB payload lookup in webhook-ingestion | Keeps Redis job payload identifier-only (decision from 01-03) |
| `workflow_run` preferred over `check_run` | Lower cardinality, richer context (branch, head_sha, path) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Octokit type unavailable in worker package**

- **Found during:** Task 1 build
- **Issue:** `import type { Octokit } from "@octokit/core"` failed — `@octokit/core` not in worker's `node_modules` (pnpm workspace isolation)
- **Fix:** Derived type via `type Octokit = Awaited<ReturnType<typeof getInstallationClient>>` using `@ciintel/github` which is already a worker dependency
- **Files modified:** `apps/worker/src/lib/github-actions.ts`

**2. [Rule 2 - Missing Critical] tsconfig references for @ciintel/detectors**

- **Found during:** Task 1 build
- **Issue:** `@ciintel/detectors` added to `package.json` but not to tsconfig project references — TypeScript composite mode requires both
- **Fix:** Added `{ "path": "../../packages/detectors" }` to `apps/worker/tsconfig.json` references
- **Files modified:** `apps/worker/tsconfig.json`

## Next Phase Readiness

- **02-06 (AI Analysis Worker):** Ready — `ai-analysis` queue is populated with `findingId`-bearing jobs; `@ciintel/ai` analyzeFailure ready to consume
- **02-07 (Integration Verification):** Ready — full flow from webhook → detector-dispatch → Finding → ai-analysis is wired
