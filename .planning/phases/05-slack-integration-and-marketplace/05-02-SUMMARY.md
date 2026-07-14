---
phase: 05-slack-integration-and-marketplace
plan: 02
subsystem: api
tags: [fastify, bullmq, github-marketplace, webhooks, hmac, billing, prisma]

# Dependency graph
requires:
  - phase: 05-01
    provides: billingQueue, MarketplacePurchaseJobSchema, billing-state.ts with deriveTransition, Installation billing fields
provides:
  - POST /marketplace/webhooks Fastify route with MARKETPLACE_WEBHOOK_SECRET HMAC verification
  - BillingWorker consuming billing queue and applying state transitions to Installation rows
  - Future-dated cancellation handling (billingCancelAt without billingStatus change)
affects:
  - 05-03 (GET /status may surface billing state)
  - 05-04 (Slack notifications triggered on billing events)
  - 05-05 (end-to-end marketplace flow)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Dedicated marketplace route with separate MARKETPLACE_WEBHOOK_SECRET (not shared with app webhook secret)
    - Future-dated cancellation: partial DB update (billingCancelAt only) with lazy expiry flip
    - BillingWorker pattern mirrors existing workers: createBillingWorker() factory, concurrency=5, graceful close

key-files:
  created:
    - apps/api/src/routes/marketplace.ts
    - apps/worker/src/workers/billing.ts
  modified:
    - apps/api/src/index.ts
    - apps/worker/src/index.ts

key-decisions:
  - "MARKETPLACE_WEBHOOK_SECRET separate from GITHUB_WEBHOOK_SECRET — marketplace events lack installation.id context"
  - "accountType cast to Organization|User literal — MarketplacePurchaseJobSchema enforces enum; safeParse catches invalid GitHub payloads"
  - "Future cancellation guard in BillingWorker: transition.billingCancelAt > new Date() before deciding partial vs full update"

patterns-established:
  - "Marketplace route: rawBody: true config required for HMAC verification"
  - "BillingWorker: safeParse job data before DB access — silently discard jobs with invalid schema"

# Metrics
duration: 3min
completed: 2026-07-14
---

# Phase 5 Plan 02: Marketplace Webhook Route and BillingWorker Summary

**GitHub Marketplace webhook route (POST /marketplace/webhooks) with HMAC-SHA256 verification enqueuing to billingQueue, and BillingWorker applying deriveTransition() state machine to Installation rows with future-dated cancellation guard**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-07-14T12:44:34Z
- **Completed:** 2026-07-14T12:47:14Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Marketplace webhook route verifies x-hub-signature-256 using dedicated MARKETPLACE_WEBHOOK_SECRET and enqueues MarketplacePurchaseJob with deduplicated jobId
- BillingWorker processes all three eventType transitions (marketplace_purchase, marketplace_plan_changed, marketplace_purchase_cancelled) with correct billingStatus writes
- Future-dated cancellations store billingCancelAt without touching billingStatus — lazy expiry gate in checkInstallationActive handles the eventual flip

## Task Commits

Each task was committed atomically:

1. **Task 1: Marketplace webhook route** - `6a3c2a3` (feat)
2. **Task 2: BillingWorker** - `b6b547d` (feat)

## Files Created/Modified

- `apps/api/src/routes/marketplace.ts` - POST /marketplace/webhooks with HMAC signature verification and billingQueue.add()
- `apps/api/src/index.ts` - Registered marketplaceRoutes
- `apps/worker/src/workers/billing.ts` - BillingWorker with deriveTransition() and future-cancellation partial update path
- `apps/worker/src/index.ts` - Registered createBillingWorker(), added to workers log and graceful shutdown

## Decisions Made

- `accountType` cast to `"Organization" | "User"` before jobData construction (TypeScript rule 1 bug fix): MarketplacePurchaseJobSchema uses z.enum — the cast is safe because safeParse rejects unknown types from real GitHub payloads at runtime
- Future cancellation guard checks `transition.billingCancelAt > new Date()` at BillingWorker level rather than inside deriveTransition — keeps the state machine pure; caller owns the partial-vs-full update decision (consistent with billing-state.ts design from 05-01)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript error: accountType cast missing**
- **Found during:** Task 1 (marketplace webhook route)
- **Issue:** `(account["type"] as string) ?? "Organization"` was not assignable to `"Organization" | "User"` — TS2322 error
- **Fix:** Added `as "Organization" | "User"` cast; safeParse downstream rejects truly invalid values at runtime
- **Files modified:** apps/api/src/routes/marketplace.ts
- **Verification:** `pnpm --filter @cyclops/api exec tsc --noEmit` exits 0
- **Committed in:** 6a3c2a3 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — type cast)
**Impact on plan:** Minimal — TypeScript strict-mode correction only. No behavior change.

## Issues Encountered

None beyond the TypeScript cast fixed above.

## Next Phase Readiness

- POST /marketplace/webhooks is wired and ready to receive GitHub Marketplace events
- BillingWorker processes all state transitions; future-dated cancellations handled correctly
- Installation.billingStatus is now maintained in real-time via marketplace events
- Plans 04 and 05 can proceed — Installation rows will have correct billing state for gating checks

---
*Phase: 05-slack-integration-and-marketplace*
*Completed: 2026-07-14*
