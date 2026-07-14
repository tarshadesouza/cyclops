---
phase: 05-slack-integration-and-marketplace
plan: 03
subsystem: api
tags: [fastify, bullmq, redis, prisma, health, status, monitoring]

# Dependency graph
requires:
  - phase: 05-01
    provides: billingQueue exported from @cyclops/queue
  - phase: 01-03
    provides: redisDecorator plugin decorating app.redis on FastifyInstance
  - phase: 01-02
    provides: getDb() from @cyclops/db, Prisma client
provides:
  - GET /status endpoint returning real-time health for DB, Redis, and BullMQ queues
  - Per-component latencyMs with independent try/catch isolation
  - Public endpoint (no auth required) satisfying MKT-03
affects:
  - marketplace-listing
  - monitoring
  - ops-runbook

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Independent component checks with isolated try/catch so one failure does not block others
    - Aggregated status (ok/degraded) derived from all component statuses
    - Queue depth exposed alongside health status for operational visibility

key-files:
  created:
    - apps/api/src/routes/status.ts
  modified:
    - apps/api/src/index.ts

key-decisions:
  - "Use app.redis (Fastify decorator) not getRedis() from @cyclops/queue — API has its own Redis singleton"
  - "Each component check wrapped in independent try/catch — one failure reports but does not prevent other checks"
  - "Returns 200 when all ok, 503 when any component degraded — enables load balancer health routing"
  - "No authentication guard on /status — publicly accessible per MKT-03 requirement"

patterns-established:
  - "Status endpoint pattern: independent checks + latencyMs per component + aggregated ok/degraded"

# Metrics
duration: 1min
completed: 2026-07-14
---

# Phase 5 Plan 03: GET /status Health Endpoint Summary

**Public GET /status endpoint with independent DB (SELECT 1), Redis (ping), and BullMQ queue depth checks returning per-component latencyMs and 200/503 aggregated status**

## Performance

- **Duration:** ~1 min
- **Started:** 2026-07-14T12:44:56Z
- **Completed:** 2026-07-14T12:45:53Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Created `apps/api/src/routes/status.ts` with three independent health checks (DB, Redis, queues)
- DB health via `prisma.$queryRaw\`SELECT 1\`` with latencyMs tracking
- Redis health via `app.redis.ping()` using the existing Fastify decorator
- Queue depth reads `billingQueue` and `actionExecutionQueue` waiting counts
- Registered statusRoutes in `apps/api/src/index.ts` — publicly accessible, no auth guard
- TypeScript compiles clean (0 errors)

## Task Commits

Each task was committed atomically:

1. **Task 1: GET /status health endpoint** - `710b0f5` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified
- `apps/api/src/routes/status.ts` - GET /status route with DB + Redis + queue depth health checks
- `apps/api/src/index.ts` - Added statusRoutes import and registration

## Decisions Made
- Used `app.redis` (Fastify decorator) instead of `getRedis()` from `@cyclops/queue` — API service manages its own Redis connection via `redisDecorator` plugin; importing from queue package would create a second connection
- Each component check is isolated in its own try/catch block so a DB outage doesn't prevent Redis or queue checks from reporting
- 503 returned when any component fails, 200 only when all three report "ok" — enables upstream load balancers and uptime monitors to detect partial degradation

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness
- GET /status is live and satisfies MKT-03 (marketplace listing health check requirement)
- Parallel with 05-02 (Slack webhook routes) — both independently register routes in index.ts without conflict
- Ready for 05-04 and beyond

---
*Phase: 05-slack-integration-and-marketplace*
*Completed: 2026-07-14*
