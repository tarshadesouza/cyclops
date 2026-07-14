---
phase: 05-slack-integration-and-marketplace
plan: "04"
subsystem: api
tags: [slack, oauth, csrf, redis, encryption, aes-256-gcm, fastify]

# Dependency graph
requires:
  - phase: 05-01
    provides: Installation model with encryptedSlackToken/slackTeamId/slackTeamName fields
  - phase: 04-02
    provides: encryptApiKey from @cyclops/internal (AES-256-GCM)
  - phase: 01-03
    provides: app.redis Fastify decorator (ioredis)
provides:
  - GET /slack/install — CSRF-protected redirect to Slack OAuth v2 authorization
  - GET /slack/oauth/callback — token exchange, xoxb- validation, encrypted storage
  - DELETE /slack/disconnect — clears all Slack fields from Installation row
  - 05-USER-SETUP.md — checklist for Slack App configuration and env vars
affects:
  - 05-05 (Slack alert delivery uses encryptedSlackToken stored here)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CSRF state embedded as {installationId}:{nonce} in Redis key with 10-min TTL, one-time delete after validation"
    - "Native fetch() for Slack token exchange (no SDK)"
    - "Bot token validated as xoxb- prefix before AES-256-GCM encryption"
    - "app.redis via (app as any).redis Fastify decorator pattern"

key-files:
  created:
    - apps/api/src/routes/slack-oauth.ts
    - .planning/phases/05-slack-integration-and-marketplace/05-USER-SETUP.md
  modified:
    - apps/api/src/index.ts

key-decisions:
  - "State param encodes installationId as {installationId}:{nonce} — callback extracts installationId without extra Redis lookup"
  - "CSRF state deleted immediately after first use — prevents replay attacks"
  - "xoxb- prefix validation before encryption — rejects app tokens (xoxa-) and user tokens (xoxp-) at the gate"
  - "No Slack SDK dependency — native fetch() sufficient for single token exchange call"

patterns-established:
  - "Slack OAuth CSRF: redis.set with EX 600, redis.get + redis.del on callback"
  - "Bot token encryption: encryptApiKey() from @cyclops/internal before DB write"

# Metrics
duration: 2min
completed: 2026-07-14
---

# Phase 05 Plan 04: Slack OAuth Workspace Connection Summary

**Slack OAuth per-installation flow with CSRF state in Redis, xoxb- token validation, AES-256-GCM encryption, and disconnect revocation via three Fastify routes**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-07-14T12:50:26Z
- **Completed:** 2026-07-14T12:52:25Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- GET /slack/install generates CSRF state ({installationId}:{nonce}) stored in Redis with 10-min TTL, redirects to Slack OAuth v2 with required scopes (chat:write, channels:read, groups:read)
- GET /slack/oauth/callback validates CSRF state, deletes it immediately (one-time use), exchanges code for bot token, validates xoxb- prefix, encrypts with encryptApiKey (AES-256-GCM), writes encryptedSlackToken + slackTeamId + slackTeamName to Installation row
- DELETE /slack/disconnect clears all three Slack fields to null, enabling clean re-authorization
- 05-USER-SETUP.md created with env vars checklist, Slack App dashboard steps, and GitHub Marketplace setup

## Task Commits

Each task was committed atomically:

1. **Tasks 1+2: Slack OAuth routes (install, callback, disconnect)** - `73ab3c6` (feat)
2. **Task 3: USER-SETUP.md checklist** - `c447dde` (docs)

## Files Created/Modified
- `apps/api/src/routes/slack-oauth.ts` - All three Slack OAuth routes (install, callback, disconnect)
- `apps/api/src/index.ts` - Added slackOAuthRoutes import and registration
- `.planning/phases/05-slack-integration-and-marketplace/05-USER-SETUP.md` - External service setup checklist

## Decisions Made
- State param encodes installationId as `{installationId}:{nonce}` — callback can extract installationId with a single split() without an additional Redis lookup
- CSRF state deleted immediately after first validation — prevents replay if attacker intercepts the callback URL
- xoxb- prefix validated before encryption — rejects app-level tokens (xoxa-) and user tokens (xoxp-) before they reach the DB
- No Slack SDK added — native fetch() is sufficient for the single oauth.v2.access call; avoids dependency for one endpoint

## Deviations from Plan

None - plan executed exactly as written. Tasks 1 and 2 were implemented together in one file creation (the disconnect route was included in the initial file write rather than as a separate edit, which is equivalent).

## Issues Encountered
None

## User Setup Required

**External services require manual configuration.** See [05-USER-SETUP.md](./05-USER-SETUP.md) for:
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` env vars to add to Railway
- `MARKETPLACE_WEBHOOK_SECRET` env var
- Slack App Dashboard: redirect URL, bot token scopes, workspace installation
- GitHub Marketplace listing and webhook configuration

## Next Phase Readiness
- Plan 05-05 (Slack alert delivery) can now use `encryptedSlackToken` from Installation — the decryptApiKey pattern from @cyclops/internal is already established
- SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_REDIRECT_URI must be set before the OAuth flow works in production; see 05-USER-SETUP.md

---
*Phase: 05-slack-integration-and-marketplace*
*Completed: 2026-07-14*
