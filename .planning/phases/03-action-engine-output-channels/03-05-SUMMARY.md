---
phase: 03-action-engine-output-channels
plan: "05"
subsystem: api
tags: [octokit, github-api, git-data-api, prisma, autofix, pull-requests, rate-limiting, deduplication]

# Dependency graph
requires:
  - phase: 03-04
    provides: ActionContext interface with db/log, HANDLERS map with stubs for autofix actions
  - phase: 03-01
    provides: AutofixPr model with installationId_repositoryId_detectorType_sha unique constraint
provides:
  - handleAutofixLint: Git Data API 5-step chain creating lint autofix PRs
  - handleAutofixSnapshot: stricter sanity check + same Git Data API chain for snapshot PRs
  - isAutofixDeduped: AutofixPr.findUnique dedup guard (ACT-11, ACT-13)
  - isRateLimited: count AutofixPr rows in last 60m against configurable limit (ACT-12)
  - isValidFileContent: sanity check preventing prose from being committed as file content
affects: [03-06, 03-07, phase4-integration-tests]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Git Data API 5-step chain: GET commit → POST tree → POST commit → POST ref → POST pull (no local clone required)"
    - "Dedup before branch creation: isAutofixDeduped checks AutofixPr table, abort early to prevent orphan branches"
    - "Rate limit via DB count: count rows in last 60m window, no Redis required"
    - "Content sanity guard: isValidFileContent prevents AI prose from being committed as source code"
    - "ref normalization: strip refs/heads/ prefix before using as PR base branch"

key-files:
  created:
    - apps/worker/src/lib/github-autofix.ts
  modified:
    - apps/worker/src/workers/action-execution.ts

key-decisions:
  - "handleAutofixLint return type aligned to HandlerResult union (skipped: true as const | ok: true as const) — matches HANDLERS map constraint"
  - "ref normalization strips refs/heads/ prefix — Finding stores full ref (e.g. refs/heads/main) but GitHub PR base parameter requires branch name only"
  - "isValidFileContent Snapshot check requires exports[ or // Jest prefix — prevents accidental commit of AI-generated explanation text"
  - "Both handlers return ok: true on success (not {}) — satisfies HandlerResult discriminated union"

patterns-established:
  - "All skip paths return { skipped: true as const, reason: '...' } for HandlerResult compatibility"
  - "Guard order: confidence → sanity check → dedup → rate limit → execution (fail fast, cheapest checks first)"
  - "Git Data API chain reused verbatim between Lint and Snapshot handlers; only message/branch/title/body differ"

# Metrics
duration: 2min
completed: 2026-07-13
---

# Phase 3 Plan 05: GitHub Autofix PR Handlers Summary

**Git Data API 5-step autofix PR chain for Lint and Snapshot findings with AutofixPr deduplication, per-repo rate limiting, and content sanity checks**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-07-13T15:32:56Z
- **Completed:** 2026-07-13T15:35:24Z
- **Tasks:** 2 (both committed in single atomic commit)
- **Files modified:** 2

## Accomplishments

- Implemented `handleAutofixLint` with full Git Data API 5-step chain (GET commit → POST tree → POST commit → POST ref → POST pull)
- Implemented `handleAutofixSnapshot` with identical chain but stricter `isValidFileContent` check (requires `exports[` or `// Jest` prefix)
- `isAutofixDeduped` guards against duplicate PRs via `AutofixPr.findUnique` on the `installationId_repositoryId_detectorType_sha` unique constraint
- `isRateLimited` counts `AutofixPr` rows in the last 60-minute window against `config.autofixRateLimit` (default 3)
- Both handlers wired into `HANDLERS` map in `action-execution.ts`, replacing stubs
- Worker builds with zero TypeScript errors

## Task Commits

Each task was committed atomically:

1. **Tasks 1+2: Implement handleAutofixLint, handleAutofixSnapshot, wire HANDLERS** - `f6305fb` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified

- `apps/worker/src/lib/github-autofix.ts` - handleAutofixLint, handleAutofixSnapshot, isAutofixDeduped, isRateLimited, isValidFileContent
- `apps/worker/src/workers/action-execution.ts` - added import and wired both handlers into HANDLERS map

## Decisions Made

- **ref normalization in PR base branch**: `finding.ref` stores the full Git ref (e.g., `refs/heads/main`) but GitHub's Pulls API `base` parameter requires just the branch name. Added `.replace(/^refs\/heads\//, "")` before using as `base`.
- **Return type alignment**: Plan specified `Promise<{ skipped?: boolean; reason?: string }>` but HANDLERS map requires `Promise<HandlerResult>`. Used `{ skipped: true as const, reason: '...' }` and `{ ok: true as const }` throughout to satisfy the discriminated union.
- **`isValidFileContent` Snapshot check**: Requires `exports[` or `// Jest` prefix to reject AI-generated explanation text. This is deliberately strict — false negatives (skipping a valid fix) are safer than false positives (committing prose as source).
- **Guard order**: Confidence → sanity → dedup → rate limit → execution. Cheapest/most certain checks first. Dedup prevents creating orphan branches; rate limit comes after because it's a softer constraint.

## Deviations from Plan

None - plan executed exactly as written, with two minor improvements applied proactively:
1. `ref` normalization (strips `refs/heads/` prefix) — prevents GitHub API error on PR creation
2. Return types aligned to `HandlerResult` discriminated union instead of plan's looser `{ skipped?: boolean }` — required by HANDLERS map type constraint

Both are correctness fixes, not scope changes.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `handleAutofixLint` and `handleAutofixSnapshot` are production-ready
- `AutofixPr` dedup and rate limit logic is in place and testable
- Remaining HANDLERS stubs: `rerun-workflow`, `cancel-workflow`, `send-slack-alert`, `create-github-issue` (03-06 and 03-07)
- No blockers for 03-06

---
*Phase: 03-action-engine-output-channels*
*Completed: 2026-07-13*
