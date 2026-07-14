---
phase: 04-public-sdk
plan: 01
subsystem: infra
tags: [pnpm, turborepo, monorepo, typescript, rename, scope]

# Dependency graph
requires:
  - phase: 03-action-engine-output-channels
    provides: Complete action pipeline; all source files that import @ciintel/* packages
provides:
  - Fully renamed monorepo scope from @ciintel/* to @cyclops/*
  - Root package renamed ciintel → cyclops
  - Clean pnpm install + pnpm build after rename
affects:
  - 04-public-sdk plans 02+: all subsequent Phase 4 plans build on @cyclops/core as the publishable name

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "@cyclops/* npm scope used for all workspace packages"
    - "Workspace dependencies use @cyclops/* with workspace:* specifiers"

key-files:
  created: []
  modified:
    - package.json
    - packages/core/package.json
    - packages/db/package.json
    - packages/ai/package.json
    - packages/config/package.json
    - packages/detectors/package.json
    - packages/github/package.json
    - packages/queue/package.json
    - apps/api/package.json
    - apps/worker/package.json
    - packages/core/src/index.ts
    - packages/ai/src/analyze.ts
    - packages/ai/src/budget.ts
    - packages/db/src/client.ts
    - packages/detectors/src/types.ts
    - apps/api/src/routes/setup.ts
    - apps/api/src/routes/webhooks.ts
    - apps/worker/src/index.ts
    - apps/worker/src/lib/installation.ts
    - apps/worker/src/lib/github-actions.ts
    - apps/worker/src/workers/ai-analysis.ts
    - apps/worker/src/workers/detector-dispatch.ts
    - apps/worker/src/workers/action-execution.ts
    - apps/worker/src/workers/webhook-ingestion.ts
    - apps/worker/src/workers/dlq.ts
    - README.md
    - packages/db/README.md

key-decisions:
  - "Scope rename is a pure find-replace — no architectural change; tsconfig references are path-based so zero changes needed there"
  - "sed -i used for bulk TS source replacement; package.json edits done individually to avoid accidental matches"

patterns-established:
  - "All workspace packages under @cyclops/* scope; root package is cyclops (no scope)"

# Metrics
duration: 3min
completed: 2026-07-14
---

# Phase 4 Plan 1: Scope Rename Summary

**Monorepo scope renamed from @ciintel/* to @cyclops/* across all 10 package.json files, 15 TypeScript source files, and 2 README docs; pnpm install and pnpm build both pass clean.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-07-14T07:17:11Z
- **Completed:** 2026-07-14T07:19:48Z
- **Tasks:** 3
- **Files modified:** 27

## Accomplishments

- All 10 package.json name fields and workspace dependency keys updated from @ciintel/* to @cyclops/*
- All 15 TypeScript source files (imports, re-exports, comments) updated to @cyclops/*
- README.md and packages/db/README.md pnpm --filter commands updated
- pnpm install relinked workspace packages cleanly; pnpm build passed across all 9 packages with zero errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Rename all package.json name fields and workspace dependencies** - `37a1fbb` (chore)
2. **Task 2: Rewrite all @ciintel imports in TypeScript source** - `3336dd8` (chore)
3. **Task 3: Update docs, then reinstall and rebuild clean** - `2cb02bc` (chore)

**Plan metadata:** `[see final commit below]` (docs: complete plan)

## Files Created/Modified

- `package.json` - Root package name ciintel → cyclops
- `packages/*/package.json` (×7) - name fields and workspace dep keys renamed
- `apps/*/package.json` (×2) - name fields and workspace dep keys renamed
- `packages/core/src/index.ts` - comment updated
- `packages/ai/src/analyze.ts` - import updated
- `packages/ai/src/budget.ts` - comment updated
- `packages/db/src/client.ts` - comment updated
- `packages/detectors/src/types.ts` - re-export and import updated
- `apps/api/src/routes/setup.ts` - imports updated
- `apps/api/src/routes/webhooks.ts` - imports updated
- `apps/worker/src/index.ts` - import updated
- `apps/worker/src/lib/*.ts` (×2) - imports updated
- `apps/worker/src/workers/*.ts` (×5) - imports updated
- `README.md` - pnpm filter command and example URL updated
- `packages/db/README.md` - all @ciintel/ references updated

## Decisions Made

- tsconfig `references` are path-based (`{ "path": "../core" }`) — no rename needed there; verified during pre-scan
- pnpm-workspace.yaml uses glob patterns — no rename needed
- turbo.json uses task names only — no rename needed
- sed -i used for bulk TypeScript replacement (15 files); package.json edits done individually for precision

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- @cyclops/core is now the stable package name; Phase 4 plan 02 (publishability preparation) can proceed
- All pre-deploy todos still reference @cyclops/db (already correct after rename)
- Zero @ciintel references remain outside node_modules, pnpm-lock.yaml, and .planning/

---
*Phase: 04-public-sdk*
*Completed: 2026-07-14*
