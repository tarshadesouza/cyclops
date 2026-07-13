---
phase: 02-detector-pipeline-and-ai-analysis
plan: 01
subsystem: database
tags: [prisma, postgresql, rls, typescript, zod, detector, ai-analysis]

# Dependency graph
requires:
  - phase: 01-github-app-foundation
    provides: Installation model, RLS infrastructure (current_installation_id()), Prisma 7 config pattern, PgBouncer-safe tenant extension

provides:
  - Finding model with detector output fields + nullable AI enrichment fields + routing flags
  - TokenUsage model for per-call AI token accounting
  - Installation.encryptedApiKey for AES-256-GCM BYOK Anthropic keys
  - 0003_phase2 migration: both tables with RLS tenant isolation + postgres service bypass
  - DetectorType, FindingSeverity, Violation, DetectorResult, AiFinding types in @ciintel/core
  - AiAnalysisJobSchema updated to carry findingId (UUID) + detectorType (identifier only, no secrets)

affects:
  - 02-detector-pipeline (detectors write Finding rows, return DetectorResult)
  - 02-ai-analysis (AI worker reads Finding by findingId, writes enrichment fields, records TokenUsage)
  - 02-setup-endpoint (stores encryptedApiKey on Installation)
  - all workers (import DetectorType, AiFinding from @ciintel/core)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Prisma 7: datasource block has no url — DATABASE_URL lives in prisma.config.ts migrate.adapter"
    - "Prisma 7 generated output: client.ts (not index.js) is the entry point; model types exported as Installation/Finding/etc."
    - "Two-phase Finding lifecycle: create with detector output, enrich with AI fields later (all nullable)"
    - "TokenUsage as append-only audit log: one row per AI call, never updated"
    - "RLS pattern: ENABLE + FORCE + tenant isolation policy + postgres service bypass (matches 0002_rls)"

key-files:
  created:
    - packages/db/prisma/migrations/0003_phase2/migration.sql
    - packages/db/src/generated/ (Prisma 7 client output — 12 files)
  modified:
    - packages/db/prisma/schema.prisma
    - packages/db/prisma.config.ts
    - packages/db/src/index.ts
    - packages/core/src/index.ts
    - packages/queue/src/jobs.ts

key-decisions:
  - "Prisma 7.8.0 url-in-datasource removal: url moved from schema.prisma datasource block to prisma.config.ts migrate.adapter — client.ts uses PrismaPg adapter directly, unaffected"
  - "Generated type import: Prisma 7 outputs client.ts (not index.js); Installation/Finding/TokenUsage/WebhookDelivery exported directly from client.ts"
  - "findingId replaces failureType in AiAnalysisJobSchema: identifier-only payload, AI worker fetches content from DB at execution time"
  - "encryptedApiKey String? is nullable: platforms without BYOK use the platform default key"

patterns-established:
  - "Finding two-phase lifecycle: create row with detector output (violations, rawExcerpt, detectorType), enrich later via AI (confidence, evidence, severity, etc.)"
  - "RLS migration convention: ENABLE ROW LEVEL SECURITY → FORCE ROW LEVEL SECURITY → tenant isolation policy → postgres service bypass"

# Metrics
duration: 4m 21s
completed: 2026-07-13
---

# Phase 2 Plan 01: Phase 2 Data Foundation Summary

**Prisma Finding + TokenUsage models with RLS migration, shared detector/AI types in @ciintel/core, and AiAnalysisJobSchema carrying findingId — complete data foundation for the detector and AI pipeline.**

## Performance

- **Duration:** 4m 21s
- **Started:** 2026-07-13T11:11:08Z
- **Completed:** 2026-07-13T11:15:29Z
- **Tasks:** 3/3
- **Files modified:** 5 (plus 12 generated)

## Accomplishments

- Added Finding and TokenUsage Prisma models with full column sets; regenerated Prisma 7 client (12 generated files in src/generated/)
- Created 0003_phase2 migration with both tables, compound indexes, FK constraints, and RLS matching the 0002_rls pattern
- Exported DetectorType, FindingSeverity, Violation, DetectorResult, AiFinding from @ciintel/core (I/O-free constraint maintained)
- Replaced AiAnalysisJobSchema's `failureType` with `findingId` (UUID) + `detectorType` — identifier-only payload

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Prisma models and generate client** - `cd08ae3` (feat)
2. **Task 2: Write the 0003_phase2 RLS migration** - `734caff` (feat)
3. **Task 3: Add core types and update queue job schema** - `e7921e1` (feat)

**Plan metadata:** see docs commit below

## Files Created/Modified

- `packages/db/prisma/schema.prisma` - Added Finding, TokenUsage models; Installation.encryptedApiKey + relation fields; removed datasource url (Prisma 7.8.0 breaking change)
- `packages/db/prisma.config.ts` - Added migrate.adapter with PrismaPg pool for DATABASE_URL (Prisma 7 migration config)
- `packages/db/prisma/migrations/0003_phase2/migration.sql` - DDL for findings + token_usages with indexes, FKs, and RLS policies
- `packages/db/src/index.ts` - Uncommented and extended type exports to include Finding and TokenUsage (import from generated/client.js)
- `packages/db/src/generated/` - 12 Prisma 7 generated files (client.ts, models.ts, models/*.ts, browser.ts, enums.ts, etc.)
- `packages/core/src/index.ts` - Appended DetectorType, FindingSeverity, Violation, DetectorResult, AiFinding exports
- `packages/queue/src/jobs.ts` - Replaced AiAnalysisJobSchema: removed failureType, added findingId (z.string().uuid()) + detectorType

## Decisions Made

1. **Prisma 7.8.0 datasource url removal** — `url = env("DATABASE_URL")` in schema.prisma now throws a validation error in Prisma 7.8.0. Fixed by removing `url` from the datasource block and adding `migrate.adapter` to `prisma.config.ts` using PrismaPg. The `getDb()` factory in `client.ts` was already using the adapter pattern directly, so no change needed there.

2. **Prisma 7 generated entry point** — Prisma 7 no longer generates an `index.js`. The main export file is `client.ts`; the barrel for model types is `models.ts`, but the concrete model types (Installation, Finding, etc.) are only exported from `client.ts`. Import corrected from `./generated/index.js` to `./generated/client.js`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Prisma 7.8.0 removed datasource `url` property**

- **Found during:** Task 1 (`pnpm --filter @ciintel/db db:generate`)
- **Issue:** Prisma 7.8.0 throws P1012 validation error: "The datasource property `url` is no longer supported in schema files"
- **Fix:** Removed `url = env("DATABASE_URL")` from `datasource db {}` in schema.prisma; added `migrate.adapter` factory using `PrismaPg` to `prisma.config.ts`
- **Files modified:** `packages/db/prisma/schema.prisma`, `packages/db/prisma.config.ts`
- **Commit:** cd08ae3

**2. [Rule 1 - Bug] Prisma 7 generated output has no `index.js`**

- **Found during:** Task 1 (`pnpm --filter @ciintel/db build`)
- **Issue:** `packages/db/src/index.ts` imported `./generated/index.js` which does not exist; Prisma 7 generates `client.ts` as the main entry; model types (Installation, Finding, etc.) are exported from `client.ts` not `models.ts`
- **Fix:** Changed import to `./generated/client.js`
- **Files modified:** `packages/db/src/index.ts`
- **Commit:** cd08ae3

## Next Phase Readiness

- Detectors can import `DetectorType`, `Violation`, `DetectorResult` from `@ciintel/core`
- AI worker can import `AiFinding`, `FindingSeverity` from `@ciintel/core`
- DB models `Finding` and `TokenUsage` are importable from `@ciintel/db`
- `AiAnalysisJobSchema` is ready to carry `findingId` UUID references
- Migration `0003_phase2` ready to apply when `DATABASE_URL` is available
- **Pending:** Run `db:migrate` in target environment to apply 0003_phase2 migration
