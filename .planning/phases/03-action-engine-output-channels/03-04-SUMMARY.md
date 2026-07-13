---
phase: 03-action-engine-output-channels
plan: "04"
subsystem: api
tags: [github, octokit, check-runs, pr-comments, annotations, bullmq]

# Dependency graph
requires:
  - phase: 03-03
    provides: ActionContext type, HANDLERS map with 8 stubs, action-execution worker

provides:
  - getPrNumber: resolves open PR number from commit SHA via GitHub API
  - handleUpsertPrComment: PR comment upsert with ACT-01/ACT-02/ACT-13 semantics
  - handleUpdateCheckRun: GitHub Check Run with batched annotations (ACT-03/ACT-04/ACT-13)
  - Both handlers wired into HANDLERS map replacing stubs

affects:
  - 03-05 through 03-07: subsequent action handlers use same ActionContext pattern
  - Future: PR comment body will be updated as more findings arrive per workflowRunId

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "octokit.request() duck-typed as any — no @octokit/core direct dep"
    - "Check DB before GitHub API — idempotency via PrComment.findUnique (ACT-13)"
    - "Annotation batching: ANNOTATION_BATCH_SIZE=50 constant, slice loop"
    - "Literal true return types to satisfy HandlerResult union discriminant"

key-files:
  created:
    - apps/worker/src/lib/github-outputs.ts
  modified:
    - apps/worker/src/workers/action-execution.ts

key-decisions:
  - "Return types use 'true as const' to satisfy HandlerResult = { skipped: true } | { ok: true } discriminated union"
  - "ActionContext extended with db: TenantDb and log: pino.Logger — handlers need both"
  - "handleUpdateCheckRun returns neutral (not success) when confidence < threshold — avoids false pass signal"
  - "renderPrCommentBody consolidates all findings for workflowRunId in one comment body"

patterns-established:
  - "ACT-13 idempotency: check DB row existence before creating GitHub resources"
  - "ACT-02 guard: getPrNumber returns undefined → return { skipped: true as const } immediately"
  - "Annotation batching: for loop with ANNOTATION_BATCH_SIZE, isLast flag triggers completion fields"

# Metrics
duration: 3m 11s
completed: 2026-07-13
---

# Phase 3 Plan 04: GitHub Output Channels Summary

**PR comment upsert (ACT-01/02/13) and Check Run with 50-annotation batching (ACT-03/04/13) implemented in github-outputs.ts, stubs replaced in HANDLERS map**

## Performance

- **Duration:** 3m 11s
- **Started:** 2026-07-13T15:27:19Z
- **Completed:** 2026-07-13T15:30:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `getPrNumber` resolves open PR for any commit SHA via `GET /repos/{owner}/{repo}/commits/{sha}/pulls`
- `handleUpsertPrComment` skips when no PR (ACT-02), checks PrComment DB row (ACT-13), POSTs first then PATCHes (ACT-01), body consolidates all findings for workflowRunId
- `handleUpdateCheckRun` creates check run with `in_progress`, persists `cyclopsCheckRunId` on Finding (ACT-03), sends annotations in batches of 50 (ACT-04), completes with `failure`/`neutral` conclusion
- `ActionContext` extended with `db` and `log` fields consumed by both handlers
- Both handlers wired into HANDLERS map — no more stubs for these two action types

## Task Commits

1. **Task 1: Implement getPrNumber and handleUpsertPrComment** - `99938ed` (feat)
2. **Task 2: Implement handleUpdateCheckRun and wire both handlers** - `e2a3bfb` (feat)

## Files Created/Modified
- `apps/worker/src/lib/github-outputs.ts` — New: getPrNumber, renderPrCommentBody, handleUpsertPrComment, renderCheckRunSummary, handleUpdateCheckRun
- `apps/worker/src/workers/action-execution.ts` — Extended ActionContext with db/log, wired two real handlers, added TenantDb type alias

## Decisions Made
- `HandlerResult` union uses literal `true` discriminants — return sites use `as const` to satisfy TypeScript strict checking
- `ActionContext` needed `db` and `log` (not in original stub) — added as part of Task 1 (Rule 2: missing critical fields handlers need)
- `conclusion: neutral` (not `success`) when confidence is below threshold — avoids misleading green check on uncertain findings
- Consolidated PR comment body fetches all findings for workflowRunId rather than single finding only

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added db and log to ActionContext**
- **Found during:** Task 1 (implementing handleUpsertPrComment)
- **Issue:** Plan's implementation used ctx.db and ctx.log but ActionContext interface from 03-03 only had octokit, finding, config, owner, repo, etc. — handlers cannot function without DB access and logging
- **Fix:** Added `db: TenantDb` and `log: pino.Logger` to ActionContext interface; populated in ctx construction in createActionExecutionWorker
- **Files modified:** apps/worker/src/workers/action-execution.ts
- **Verification:** Worker builds cleanly; handlers receive both fields
- **Committed in:** 99938ed (Task 1 commit)

**2. [Rule 1 - Bug] Fixed return type mismatch for HandlerResult union**
- **Found during:** Task 2 build verification
- **Issue:** `handleUpsertPrComment` returned `Promise<{ skipped?: boolean; ok?: boolean }>` and `handleUpdateCheckRun` returned `Promise<{ ok: boolean }>` — neither satisfied `HandlerResult = { skipped: true } | { ok: true }` requiring literal `true`
- **Fix:** Changed return types to use literal `true as const` at all return sites
- **Files modified:** apps/worker/src/lib/github-outputs.ts
- **Verification:** `pnpm --filter @ciintel/worker build` exits 0
- **Committed in:** e2a3bfb (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the two auto-fixed deviations above.

## Next Phase Readiness
- PR comment and check run channels fully operational
- 03-05 (autofix PR creation) can follow same ActionContext + HANDLERS pattern
- Stub handlers for remaining 6 action types still in place — ready for replacement in 03-05 through 03-07

---
*Phase: 03-action-engine-output-channels*
*Completed: 2026-07-13*
