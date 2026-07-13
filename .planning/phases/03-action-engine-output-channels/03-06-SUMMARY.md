---
phase: 03-action-engine-output-channels
plan: "06"
subsystem: action-engine
tags: [bullmq, octokit, github-api, slack, deduplication, prisma, typescript]

# Dependency graph
requires:
  - phase: 03-05
    provides: handleAutofixLint, handleAutofixSnapshot wired into HANDLERS; ActionDedup schema in place
  - phase: 03-01
    provides: ActionDedup and TrackedIssue Prisma models (migration 0004_phase3_action_tables)
provides:
  - handleRerunWorkflow: POST /actions/runs/{id}/rerun with 24h ActionDedup (ACT-07)
  - handleCancelWorkflow: POST /actions/runs/{id}/cancel; 409=success; 24h ActionDedup (ACT-08)
  - handleSlackAlert: native fetch() Slack webhook; skips if no URL; 24h ActionDedup (ACT-09)
  - handleCreateGithubIssue: creates issue first time, comments on repeat via TrackedIssue (ACT-10)
  - checkActionDedup / recordActionDedup helper functions with expiry-aware TTL
  - HANDLERS map fully complete — zero not-yet-implemented stubs
affects: [03-07, 04-api-endpoints, phase-4, phase-5]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ActionDedup: findFirst with expiresAt gt filter (TTL-aware), upsert to refresh on repeat"
    - "HandlerResult discriminated union: literal true as const required for skipped/ok branches"
    - "409 Conflict = already-cancelled = success (not error) for workflow cancel"
    - "Native fetch() for Slack webhooks — no Slack SDK"
    - "TrackedIssue dedup for GitHub Issues (separate table from ActionDedup — issue number preserved)"

key-files:
  created:
    - apps/worker/src/lib/github-secondary.ts
  modified:
    - apps/worker/src/workers/action-execution.ts

key-decisions:
  - "checkActionDedup uses findFirst with expiresAt filter, not findUnique — TTL check is part of the query"
  - "HandlerResult return type requires skipped: true as const and ok: true as const — plan's Promise<{ skipped?: boolean }> signature was too loose; fixed to match discriminated union"
  - "handleCreateGithubIssue uses TrackedIssue (not ActionDedup) — TrackedIssue stores githubIssueNumber for comment routing on repeat failures"
  - "Slack webhookUrl: config.notifications.slack.webhookUrl takes precedence, falls back to SLACK_WEBHOOK_URL env var"

patterns-established:
  - "All secondary action handlers follow: dedup check → execute → record dedup → return { ok: true as const }"
  - "409 response from GitHub Actions cancel endpoint treated as success (run already completed)"
  - "GitHub Issue repeat failures add a comment to existing issue, never create a duplicate"

# Metrics
duration: 3min
completed: 2026-07-13
---

# Phase 3 Plan 06: Secondary Action Handlers Summary

**Workflow rerun/cancel via GitHub Actions API, Slack alert via native fetch(), and GitHub Issue creation with TrackedIssue dedup — HANDLERS map fully complete, zero stubs remaining**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-07-13T15:37:25Z
- **Completed:** 2026-07-13T15:40:09Z
- **Tasks:** 2 (combined into 1 commit)
- **Files modified:** 2

## Accomplishments

- Created `github-secondary.ts` with `checkActionDedup`/`recordActionDedup` helpers (24h TTL via `expiresAt` filter) and all 4 secondary handlers
- handleCancelWorkflow treats 409 Conflict (already completed run) as success rather than error
- handleCreateGithubIssue routes to `POST .../issues` on first failure and `POST .../issues/{n}/comments` on repeat using TrackedIssue dedup
- handleSlackAlert uses Node 22 built-in `fetch()` with no Slack SDK; skips gracefully when no webhook URL configured
- All 4 handlers wired into HANDLERS map — zero `not-yet-implemented` stubs remaining across all 8 action types

## Task Commits

1. **Tasks 1+2: Implement github-secondary.ts and wire into HANDLERS** - `3168e72` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified

- `apps/worker/src/lib/github-secondary.ts` - checkActionDedup, recordActionDedup, handleRerunWorkflow, handleCancelWorkflow, handleSlackAlert, handleCreateGithubIssue
- `apps/worker/src/workers/action-execution.ts` - Import github-secondary.js; replace 4 stubs with real handlers

## Decisions Made

- `checkActionDedup` uses `findFirst` with `expiresAt: { gt: new Date() }` filter — the TTL check must be part of the query, not post-fetch
- `TrackedIssue` used for GitHub Issue dedup (not `ActionDedup`) because issue number must be stored to route repeat failures to comments
- `config.notifications?.slack?.webhookUrl` checked first, then `SLACK_WEBHOOK_URL` env var — config-driven override pattern consistent with rest of system

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed HandlerResult return type signatures**

- **Found during:** Task 1+2 (build)
- **Issue:** Plan specified `Promise<{ skipped?: boolean; reason?: string }>` return type. TypeScript rejected this because `HandlerResult` is a discriminated union requiring `skipped: true` (literal) not `skipped?: boolean`. Returns of `{}` also failed — needed `{ ok: true as const }`.
- **Fix:** Changed all 4 handler signatures to `Promise<{ skipped: true; reason?: string } | { ok: true }>`, used `skipped: true as const` and `ok: true as const` at return sites
- **Files modified:** `apps/worker/src/lib/github-secondary.ts`
- **Verification:** `pnpm --filter @ciintel/worker build` passes cleanly
- **Committed in:** 3168e72

---

**Total deviations:** 1 auto-fixed (Rule 1 - type bug)
**Impact on plan:** Required for TypeScript correctness; no behavioral change.

## Issues Encountered

None beyond the HandlerResult type fix above.

## Next Phase Readiness

- All 8 HANDLERS entries are live implementations — action-execution worker is fully functional end-to-end
- Plan 03-07 (final plan in Phase 3) can proceed — all ACT-07 through ACT-13 requirements met
- Pre-deploy: migration 0004_phase3_action_tables must be applied before TrackedIssue/ActionDedup queries execute

---
*Phase: 03-action-engine-output-channels*
*Completed: 2026-07-13*
