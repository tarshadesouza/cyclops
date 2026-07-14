---
phase: 05-slack-integration-and-marketplace
plan: "05"
subsystem: slack
tags: [slack, bot-token, oauth, dedup, repeat-failure, fetch, crypto]

# Dependency graph
requires:
  - phase: 05-04
    provides: encryptedSlackToken stored per installation via Slack OAuth flow
  - phase: 03-06
    provides: checkActionDedup/recordActionDedup in github-secondary.ts, 24h dedup window
  - phase: 04-02
    provides: decryptApiKey in @cyclops/internal
provides:
  - slack-client.ts with postSlackMessage (never throws) and resolveChannelId (returns null for not found)
  - handleSlackAlert upgraded with bot-token primary path, webhook URL fallback, and SLK-02 repeat detection
  - SLK-02: 3+ findings on same tuple within 7d bypasses 24h dedup window
  - channel name-to-ID resolution via conversations.list API
affects: [future Slack notification enhancements, SLK-03 if paginated channel list needed]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Slack chat.postMessage requires channel ID not name — resolve via conversations.list"
    - "Slack API errors are response-level (ok:false) not HTTP errors — check data.ok after resp.ok"
    - "never-throw Slack client: all errors return ok:false with reason string"
    - "SLK-02 repeat detection: db.finding.count with 7d window; bypass dedup at 3+ occurrences"

key-files:
  created:
    - apps/worker/src/lib/slack-client.ts
  modified:
    - apps/worker/src/lib/github-secondary.ts

key-decisions:
  - "Bot token primary, webhook URL fallback — preserves backward compat for installations without Slack OAuth"
  - "channel_not_found returns skipped (not throw) — missing channel never crashes alert pipeline"
  - "resolveChannelId checks C/D/G/W prefix to bypass conversations.list for already-resolved IDs"
  - "SLK-02 repeat bypass only skips the dedup check — recordActionDedup still called on success"
  - "getDb() used for installation lookup (not ctx.db which is tenant-scoped) — matches pattern from installation.ts"

patterns-established:
  - "Pattern: Slack client never throws — callers receive ok:false + reason and decide whether to skip or propagate"
  - "Pattern: repeat failure label appended to both text and blocks for operator visibility"

# Metrics
duration: 8min
completed: 2026-07-14
---

# Phase 05 Plan 05: Slack Bot Token Integration and SLK-02 Repeat Failure Detection Summary

**Bot-token Slack alerting via postSlackMessage with channel name-to-ID resolution and SLK-02 repeat failure detection (3+/7d bypasses 24h dedup)**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-07-14T12:55:11Z
- **Completed:** 2026-07-14T13:03:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Created `slack-client.ts` with `postSlackMessage` (never throws, returns ok/reason) and `resolveChannelId` (name→ID via conversations.list, null on not found)
- Upgraded `handleSlackAlert` with bot-token primary path using encrypted token from installation, webhook URL fallback preserved
- Implemented SLK-02: `db.finding.count` over 7-day window; 3+ findings on same (installationId, repositoryId, detectorType, ref) tuple bypass the 24h dedup window

## Task Commits

1. **Task 1: slack-client.ts with postSlackMessage and resolveChannelId** - `1a19e4e` (feat)
2. **Task 2: Upgrade handleSlackAlert with bot token path and SLK-02 repeat detection** - `279b536` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified

- `apps/worker/src/lib/slack-client.ts` - Slack API client: postSlackMessage, resolveChannelId; never throws; decrypts token via @cyclops/internal
- `apps/worker/src/lib/github-secondary.ts` - handleSlackAlert replaced with bot-token primary, SLK-02 count, webhook fallback

## Decisions Made

- Bot token primary path, webhook URL fallback: preserves backward compat for pre-OAuth installations
- `channel_not_found` returns `{ skipped: true, reason: "slack_failed:channel_not_found" }` — never throws, alert is silently skipped
- `resolveChannelId` bypasses API call when input already looks like a Slack ID (C/D/G/W prefix) — avoids unnecessary conversations.list call
- `getDb()` used for installation lookup (not `ctx.db` which is tenant-scoped) — consistent with installation.ts pattern
- SLK-02 `recordActionDedup` still called after repeat-failure alert so normal dedup resumes after the alert fires

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required for this plan. Slack OAuth must be connected per installation (covered in 05-04 USER-SETUP.md).

## Next Phase Readiness

- SLK-01 and SLK-02 complete — Slack bot-token alerting and repeat failure detection fully implemented
- Phase 5 worker-side Slack work is complete; all 5 plans (05-01 through 05-05) are done
- Pre-deploy checklist in STATE.md remains the only outstanding work before production launch

---
*Phase: 05-slack-integration-and-marketplace*
*Completed: 2026-07-14*
