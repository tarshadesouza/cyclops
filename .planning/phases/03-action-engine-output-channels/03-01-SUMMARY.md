---
phase: "03"
plan: "01"
subsystem: database-schema
tags: [prisma, postgresql, rls, zod, bullmq, action-engine]
one-liner: "Phase 3 Prisma models (PrComment, ActionDedup, AutofixPr, TrackedIssue) + typed ActionExecutionJobSchema with findingId and 8-value actionType enum"

dependency-graph:
  requires:
    - "02-01: Finding model, packages/db Prisma 7 setup"
    - "01-03: ActionExecutionJobSchema in packages/queue"
  provides:
    - "0004_phase3_action_tables migration SQL with RLS policies"
    - "PrComment, ActionDedup, AutofixPr, TrackedIssue DB tables"
    - "cyclopsCheckRunId on Finding"
    - "Typed ACTION_TYPES enum and ActionType type in packages/queue"
  affects:
    - "03-02: upsert-pr-comment handler (uses PrComment table + ActionDedup)"
    - "03-03: update-check-run handler (uses cyclopsCheckRunId)"
    - "03-04 to 03-07: all action handlers (use ActionDedup for idempotency)"

tech-stack:
  added: []
  patterns:
    - "Manually-authored SQL migration with RLS policies (ENABLE/FORCE + per-table tenant isolation + postgres service bypass)"
    - "z.enum(ACTION_TYPES as const) for typed job routing in BullMQ"
    - "identifier-only job payloads — findingId drives all DB context fetches at handler time"

key-files:
  created:
    - "packages/db/prisma/migrations/0004_phase3_action_tables/migration.sql"
    - "packages/db/src/generated/models/PrComment.ts"
    - "packages/db/src/generated/models/ActionDedup.ts"
    - "packages/db/src/generated/models/AutofixPr.ts"
    - "packages/db/src/generated/models/TrackedIssue.ts"
  modified:
    - "packages/db/prisma/schema.prisma"
    - "packages/db/src/index.ts"
    - "packages/db/src/generated/client.ts"
    - "packages/db/src/generated/models.ts"
    - "packages/db/src/generated/models/Finding.ts"
    - "packages/queue/src/jobs.ts"

decisions:
  - id: "03-01-A"
    decision: "Migration created manually as SQL (not via prisma migrate dev)"
    rationale: "No PostgreSQL available locally; project follows hand-authored SQL migration pattern established in 0003_phase2"
    alternatives: "prisma migrate dev (requires live DB)"
  - id: "03-01-B"
    decision: "New models have no Prisma @relation to Installation — no FK constraints in migration SQL"
    rationale: "Dedup/tracking tables are high-write; FK enforcement deferred; RLS isolation via installationId is sufficient"
    alternatives: "Add @relation and FK (would require cascades and additional migration complexity)"
  - id: "03-01-C"
    decision: "actionParams removed from ActionExecutionJobSchema"
    rationale: "Phase 3 handlers load all context from DB via findingId at execution time — params in Redis payload create state-sync risk"
    alternatives: "Keep actionParams as z.record(z.unknown()) (less type-safe)"

metrics:
  duration: "3m 29s"
  completed: "2026-07-13"
---

# Phase 03 Plan 01: Phase 3 DB Schema Foundation Summary

**One-liner:** Phase 3 Prisma models (PrComment, ActionDedup, AutofixPr, TrackedIssue) + typed ActionExecutionJobSchema with findingId and 8-value actionType enum

## What Was Built

Four new Prisma models required by Phase 3 action handlers were added to `schema.prisma` and a corresponding hand-authored SQL migration (`0004_phase3_action_tables`) was created following the existing RLS policy pattern. The `Finding` model gained a `cyclopsCheckRunId BigInt?` field for check-run lifecycle tracking. The `packages/db` Prisma client was regenerated, and `src/index.ts` was updated to export all 8 model types. `ActionExecutionJobSchema` in `packages/queue` was tightened: `actionParams` removed, `findingId` (uuid, required) and `ref` (optional string) added, and `actionType` replaced with a typed `z.enum(ACTION_TYPES)` over 8 specific action identifiers.

## Tasks Completed

| # | Task | Commit | Key Files |
|---|------|--------|-----------|
| 1 | Add Phase 3 Prisma models and migration | 95995df | schema.prisma, migrations/0004_phase3_action_tables/migration.sql, generated/ |
| 2 | Export new DB types and tighten ActionExecutionJobSchema | 84ac476 | packages/db/src/index.ts, packages/queue/src/jobs.ts |

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Migration authoring | Manual SQL (not prisma migrate dev) | No local PostgreSQL; follows hand-authored pattern from 0003_phase2 |
| FK constraints on new tables | Omitted | Dedup/tracking tables are high-write; RLS installationId isolation is sufficient |
| actionParams removal | Removed from ActionExecutionJobSchema | Handlers fetch all context via findingId from DB; Redis payload stays identifier-only |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] No local PostgreSQL for `prisma migrate dev`**

- **Found during:** Task 1 — `prisma migrate dev` failed with "datasource.url property is required"
- **Issue:** No PostgreSQL running locally; `prisma migrate dev` requires a live connection
- **Fix:** Created `0004_phase3_action_tables/migration.sql` manually, following the SQL structure and RLS patterns established in `0003_phase2/migration.sql`. Client regenerated with `pnpm db:generate` (which does not need a DB connection).
- **Files modified:** `packages/db/prisma/migrations/0004_phase3_action_tables/migration.sql` (new)
- **Commits:** 95995df

## Verification Results

- Migration directory exists: `0004_phase3_action_tables` (contains `cyclopsCheckRunId`, `pr_comments`, `action_dedups`, `autofix_prs`, `tracked_issues`)
- `packages/db build`: exit 0 (TypeScript clean)
- `packages/queue build`: exit 0 (TypeScript clean)
- `packages/db/src/index.ts` exports: PrComment, ActionDedup, AutofixPr, TrackedIssue (confirmed)
- `ActionExecutionJobSchema`: findingId uuid required, actionType z.enum of 8 values, ref optional, no actionParams

## Next Phase Readiness

Phase 3 plans 02-07 can proceed. Each action handler needs:
- `PrComment` table (03-02: upsert-pr-comment)
- `cyclopsCheckRunId` on Finding (03-03: update-check-run)
- `ActionDedup` table (all handlers for idempotency)
- `AutofixPr` table (03-04/03-05: autofix PR handlers)
- `TrackedIssue` table (03-07: create-github-issue)

Pre-deploy: add `0004_phase3_action_tables` to the migration run sequence (already documented in STATE.md Pending Todos).
