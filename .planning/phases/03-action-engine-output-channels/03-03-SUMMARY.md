---
phase: 03-action-engine-output-channels
plan: "03"
subsystem: worker
tags: [bullmq, action-execution, kill-switch, routing, typescript]

# Dependency graph
requires:
  - phase: 03-01
    provides: Prisma models PrComment/ActionDedup/AutofixPr/TrackedIssue, cyclopsCheckRunId on Finding
  - phase: 03-02
    provides: packages/queue ACTION_TYPES enum and ActionExecutionJobSchema, packages/config fetchConfig+CyclopsConfigSchema
provides:
  - action-execution BullMQ worker with 8-entry HANDLERS map (all stubs returning skipped:true)
  - isActionKillSwitched() enforcing prComments/checkRuns/autofix/detectors config gates
  - ai-analysis.ts multi-action dispatch via getActionTypes() (2-4 typed jobs per finding)
  - actionExecutionWorker registered in index.ts with shutdown handling
affects: [03-04, 03-05, 03-06, 03-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "HANDLERS map pattern: all 8 ActionTypes registered as stubs; future plans replace stubs with real implementations"
    - "Kill-switch-before-handler: config kill switches always checked before dispatching to any handler"
    - "getActionTypes() maps detector type to full action job set; dispatches all in parallel"

key-files:
  created:
    - apps/worker/src/workers/action-execution.ts
  modified:
    - apps/worker/src/workers/ai-analysis.ts
    - apps/worker/src/index.ts
    - packages/queue/src/index.ts

key-decisions:
  - "HANDLERS map has all 8 ActionType stubs — future plans replace stubs, no new scaffolding needed"
  - "isActionKillSwitched checks per-detector gate first, then per-action-type gate"
  - "getActionTypes base set: update-check-run + upsert-pr-comment always dispatched; detector-specific extras added"
  - "ACTION_TYPES and ActionType were missing from @ciintel/queue public exports — added (Rule 3 fix)"

patterns-established:
  - "ActionContext interface: carries octokit, finding, config, owner, repo for all handlers"
  - "Kill switch check: runs at job start before any handler dispatch (ACT-14, CFG-01)"

# Metrics
duration: 3min
completed: 2026-07-13
---

# Phase 3 Plan 03: Action-Execution Worker Summary

**Central routing worker with 8-entry HANDLERS map, kill-switch enforcement, and multi-action dispatch from ai-analysis.ts**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-07-13T15:19:27Z
- **Completed:** 2026-07-13T15:22:26Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Created action-execution.ts: validates job, loads Finding, resolves owner/repo, fetches config, enforces kill switches, routes to handler
- HANDLERS map with 8 stub entries (all returning `{ skipped: true, reason: 'not-yet-implemented' }`) ready for 03-04..03-07
- isActionKillSwitched() checks per-detector and per-action-type gates (prComments, checkRuns, autofix)
- ai-analysis.ts: getActionTypes() dispatches 2-4 typed action jobs per finding; zero phase3-placeholder references
- index.ts: actionExecutionWorker instantiated and added to shutdown Promise.all

## Task Commits

1. **Task 1: Create action-execution worker with handler map and kill switches** - `fc110ce` (feat)
2. **Task 2: Update ai-analysis.ts dispatch and register worker in index.ts** - `30f485c` (feat)

## Files Created/Modified

- `apps/worker/src/workers/action-execution.ts` - New worker: validation, DB load, kill switches, HANDLERS dispatch
- `apps/worker/src/workers/ai-analysis.ts` - Added getActionTypes(), multi-action parallel dispatch, ActionType import
- `apps/worker/src/index.ts` - Import/instantiate actionExecutionWorker, added to workers log and shutdown
- `packages/queue/src/index.ts` - Added ACTION_TYPES and ActionType to public exports (were missing)

## Decisions Made

- **HANDLERS map with all 8 stubs at creation** — ensures every ActionType has a registered handler from day one; future plans replace stubs. No handler lookup can fail at runtime.
- **Kill switch order: per-detector first, per-action-type second** — disabling a detector disables all its actions; action-type gates are finer-grained overrides.
- **getActionTypes base set is always update-check-run + upsert-pr-comment** — every finding surfaces to the developer via check run and PR comment regardless of detector type.
- **ACTION_TYPES / ActionType added to @ciintel/queue exports** — they were defined in jobs.ts but not re-exported through index.ts; added as part of Rule 3 (blocking fix).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ACTION_TYPES and ActionType missing from @ciintel/queue public exports**
- **Found during:** Task 1 (importing ActionType from @ciintel/queue)
- **Issue:** jobs.ts defined and exported ACTION_TYPES and ActionType but packages/queue/src/index.ts did not re-export them; tsc error TS2305
- **Fix:** Added `ACTION_TYPES` (value) and `ActionType` (type) to packages/queue/src/index.ts exports; rebuilt @ciintel/queue
- **Files modified:** packages/queue/src/index.ts
- **Verification:** pnpm --filter @ciintel/worker build passed cleanly
- **Committed in:** fc110ce (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for correct TypeScript compilation; no scope change.

## Issues Encountered

None — plan executed cleanly after the blocking export fix.

## Next Phase Readiness

- HANDLERS map is ready: 03-04 through 03-07 replace stubs by importing ActionContext and implementing real handlers
- Kill switches enforced at the routing layer — handlers never need to re-check config
- ActionContext type exported from action-execution.ts for handler files to import

---
*Phase: 03-action-engine-output-channels*
*Completed: 2026-07-13*
