---
phase: 05-slack-integration-and-marketplace
plan: 01
subsystem: database, billing, queue
tags: [prisma, bullmq, billing, slack, state-machine, marketplace]

# Dependency graph
requires:
  - phase: 04-public-sdk
    provides: "@cyclops/* workspace scope, @tdesouza/cyclops public package"
provides:
  - Installation model with 8 billing+Slack fields and @unique targetId
  - Migration 0005_phase5_billing_slack SQL
  - billing-state.ts state machine (deriveTransition, getExpiredBillingStatus)
  - billingQueue exported from @cyclops/queue
  - checkInstallationActive with lazy billing expiry gate
affects:
  - 05-02-billing-worker (imports deriveTransition, billingQueue)
  - 05-03-slack-oauth (imports encryptedSlackToken, slackTeamId)
  - 05-04-marketplace-webhook (imports billingQueue, targetId @unique for upsert)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy billing expiry: status written to DB on first job arrival after expiry date, not via cron"
    - "Identifier-only marketplace job payload: all context derived from stored DB fields at execution time"

key-files:
  created:
    - packages/db/prisma/migrations/0005_phase5_billing_slack/migration.sql
    - apps/worker/src/lib/billing-state.ts
  modified:
    - packages/db/prisma/schema.prisma
    - packages/db/src/generated/ (Prisma client regenerated)
    - packages/queue/src/jobs.ts
    - packages/queue/src/queues.ts
    - packages/queue/src/index.ts
    - apps/worker/src/lib/installation.ts
    - apps/worker/src/workers/ai-analysis.ts

key-decisions:
  - "Migration SQL authored manually (no prisma migrate dev) — applied via prisma migrate deploy at deploy time"
  - "billingStatus defaults to 'trial' — all new installations start on trial; marketplace purchase event upgrades to active"
  - "targetId @unique required for marketplace upsert-by-account (ON CONFLICT DO UPDATE)"
  - "deriveTransition returns billingStatus:'trial' as placeholder for future-dated cancellations — caller must not overwrite billingStatus in that case"
  - "Lazy expiry writes DB update synchronously in checkInstallationActive — avoids cron dependency for billing gate"

patterns-established:
  - "BillingStatus state machine: trial → active (purchase), trial → suspended (expiry), active/trial → cancelled (cancellation)"
  - "checkInstallationActive extends to billing gate — single gate function covers all inactive-installation cases"

# Metrics
duration: 4min
completed: 2026-07-14
---

# Phase 5 Plan 01: Billing & Slack Schema Foundation Summary

**Billing+Slack fields added to Installation model, state machine and billing queue wired as foundation for all Phase 5 plans.**

## Performance

- **Duration:** 4min
- **Started:** 2026-07-14T12:37:16Z
- **Completed:** 2026-07-14T12:41:58Z
- **Tasks:** 3 completed
- **Files modified:** 8

## Accomplishments

- Added 8 new Installation fields (billingStatus, trialEndsAt, billingCancelAt, marketplacePlanId, marketplacePlanName, encryptedSlackToken, slackTeamId, slackTeamName) plus @unique on targetId; migration SQL created
- Exported billingQueue and MarketplacePurchaseJobSchema from @cyclops/queue, enabling Plans 02-04 to enqueue and consume billing events
- Created billing-state.ts state machine and wired lazy billing expiry into checkInstallationActive — expired-trial and future-cancelled installations are detected and gated on the first job arrival

## Task Commits

Each task was committed atomically:

1. **Task 1: Prisma schema migration — billing and Slack fields** - `afb95ac` (feat)
2. **Task 2: Add billing queue and MarketplacePurchaseJob to @cyclops/queue** - `829a7b7` (feat)
3. **Task 3: billing-state.ts + checkInstallationActive lazy billing expiry** - `4d3aa0a` (feat)

**Plan metadata:** (docs commit — see below)

## Files Created/Modified

- `packages/db/prisma/schema.prisma` - 8 new Installation fields + @unique on targetId
- `packages/db/prisma/migrations/0005_phase5_billing_slack/migration.sql` - SQL ALTER TABLE statements for all 8 columns + unique index
- `packages/db/src/generated/` - Prisma client types regenerated with new fields
- `packages/queue/src/jobs.ts` - MarketplacePurchaseJobSchema + type added
- `packages/queue/src/queues.ts` - billingQueue defined
- `packages/queue/src/index.ts` - billingQueue, MarketplacePurchaseJob, MarketplacePurchaseJobSchema exported
- `apps/worker/src/lib/billing-state.ts` - New: deriveTransition and getExpiredBillingStatus state machine
- `apps/worker/src/lib/installation.ts` - Billing fields selected; lazy expiry check + DB update added
- `apps/worker/src/workers/ai-analysis.ts` - [Rule 3] Fixed stale @cyclops/core import → @tdesouza/cyclops

## Decisions Made

- Migration created manually (no `prisma migrate dev`) — follows pattern from migrations 0003 and 0004; deploy via `prisma migrate deploy`
- `billingStatus` defaults to `"trial"` at the DB level — zero-config installations start on trial automatically
- `targetId @unique` is required for Plan 04's marketplace webhook handler to do upsert-by-GitHub-account-id
- `deriveTransition` returns placeholder `billingStatus: "trial"` for future-dated cancellations — the BillingWorker (Plan 02) must issue a partial update that sets only `billingCancelAt` without overwriting `billingStatus`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed stale @cyclops/core import in ai-analysis.ts**

- **Found during:** Task 3 TypeScript build check
- **Issue:** `apps/worker/src/workers/ai-analysis.ts` imported `DetectorType` from `@cyclops/core` which was renamed to `@tdesouza/cyclops` in Phase 4; caused `TS2307: Cannot find module '@cyclops/core'`
- **Fix:** Updated import to `@tdesouza/cyclops` (the package already listed in worker dependencies)
- **Files modified:** `apps/worker/src/workers/ai-analysis.ts`
- **Commit:** `4d3aa0a`
