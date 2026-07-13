---
phase: 01-github-app-foundation
plan: "04"
subsystem: api
tags: [fastify, webhook, hmac, redis, bullmq, dedup, raw-body]

dependency-graph:
  requires: ["01-03"]
  provides: ["apps/api webhook receiver", "POST /webhooks endpoint", "GET /health endpoint"]
  affects: ["01-05", "01-06"]

tech-stack:
  added: ["fastify@5", "fastify-raw-body@5", "fastify-plugin@5"]
  patterns: ["plugin registration order (raw-body first)", "fastify-plugin for encapsulation", "redis dedup with NX EX", "BullMQ jobId dedup"]

key-files:
  created:
    - apps/api/src/plugins/raw-body.ts
    - apps/api/src/plugins/redis.ts
    - apps/api/src/routes/health.ts
    - apps/api/src/routes/webhooks.ts
    - apps/api/.env.example
  modified:
    - apps/api/src/index.ts
    - apps/api/package.json
    - apps/api/tsconfig.json

decisions:
  - id: rawBodyPlugin-first
    choice: rawBodyPlugin registered before redisDecorator and all routes
    rationale: fastify-raw-body must intercept the request before any content-type parser runs; registration order in Fastify is execution order
  - id: timingSafeEqual-hmac
    choice: node:crypto timingSafeEqual for HMAC comparison
    rationale: prevents timing side-channel attacks that could allow signature brute-force
  - id: jobId-deliveryId
    choice: BullMQ jobId set to deliveryId
    rationale: provides second dedup layer at queue level; Redis SET NX handles first layer
  - id: redis-dedup-key-namespace
    choice: installation:{installationId}:delivery:{deliveryId} with EX 259200 (3 days)
    rationale: TEN-03 namespace pattern; 3-day TTL covers GitHub's 72h redelivery window
  - id: ioredis-set-arg-order
    choice: set(key, value, "EX", 259200, "NX") — EX before NX
    rationale: ioredis v5 overloads require EX/PX token before NX/XX token; reversed order fails type-check
  - id: tsconfig-references
    choice: Added project references to packages/core, db, github, queue in apps/api/tsconfig.json
    rationale: Required for tsc --noEmit to resolve @ciintel/* workspace imports via composite builds

metrics:
  duration: "2m 52s"
  completed: "2026-07-13"
---

# Phase 1 Plan 04: Fastify Webhook Receiver Summary

**One-liner:** Fastify 5 webhook receiver with HMAC-SHA256 via timingSafeEqual, Redis NX+EX dedup keyed by installationId+deliveryId, and BullMQ enqueue with jobId=deliveryId for idempotent ingestion.

## What Was Built

The public entry point for all GitHub App webhook traffic. The receiver is:
- **Fast:** Returns 202 before any async processing
- **Secure:** HMAC-SHA256 using `timingSafeEqual` prevents timing attacks
- **Idempotent:** Dual dedup — Redis `SET NX EX 259200` (first layer) + BullMQ `jobId: deliveryId` (second layer)

## Files Created/Modified

| File | Change |
|------|--------|
| `apps/api/src/plugins/raw-body.ts` | rawBodyPlugin with `global:false`, `runFirst:true` |
| `apps/api/src/plugins/redis.ts` | redisDecorator with fastify-plugin wrapping, onClose cleanup |
| `apps/api/src/routes/health.ts` | GET /health → 200 JSON |
| `apps/api/src/routes/webhooks.ts` | POST /webhooks — full HMAC+dedup+enqueue flow |
| `apps/api/src/index.ts` | Bootstrap with plugin registration order enforced |
| `apps/api/package.json` | Added fastify-plugin@^5.0.0 |
| `apps/api/tsconfig.json` | Added project references for workspace packages |
| `apps/api/.env.example` | All required env vars documented |

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| rawBodyPlugin registration | Must be first, before all routes | Fastify processes plugins in registration order; raw-body must run before content-type parser |
| HMAC comparison | `timingSafeEqual` | Prevents timing side-channel attacks |
| BullMQ dedup | `jobId: deliveryId` | Second dedup layer at queue level, complements Redis NX |
| Redis key namespace | `installation:{id}:delivery:{id}` | TEN-03 pattern; 3-day TTL covers GitHub 72h redelivery window |
| ioredis `set` arg order | `"EX", 259200, "NX"` (EX before NX) | ioredis v5 type overloads require this order |
| tsconfig references | Added all workspace packages | Required for tsc --noEmit to resolve @ciintel/* imports |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ioredis set() argument order**

- **Found during:** Task 2 TypeScript compilation
- **Issue:** Plan specified `set(key, "1", "NX", "EX", 259200)` but ioredis v5 overloads require EX before NX
- **Fix:** Changed to `set(dedupKey, "1", "EX", 259200, "NX")`
- **Files modified:** `apps/api/src/routes/webhooks.ts`
- **Commit:** b8fb9bb

**2. [Rule 2 - Missing Critical] Added string cast for request.rawBody**

- **Found during:** Task 2 TypeScript compilation
- **Issue:** `fastify-raw-body` types `rawBody` as `string | Buffer`; HMAC function requires `string`
- **Fix:** Added `as string` cast after the `!request.rawBody` null guard
- **Files modified:** `apps/api/src/routes/webhooks.ts`
- **Commit:** b8fb9bb

**3. [Rule 3 - Blocking] Added tsconfig project references**

- **Found during:** Task 2 TypeScript compilation
- **Issue:** `Cannot find module '@ciintel/queue'` — tsconfig had no project references
- **Fix:** Added references to all four workspace packages in apps/api/tsconfig.json
- **Files modified:** `apps/api/tsconfig.json`
- **Commit:** b8fb9bb

## Verification Results

| Check | Result |
|-------|--------|
| rawBodyPlugin before routes in index.ts | Passed |
| HMAC uses `request.rawBody as string` | Passed |
| `timingSafeEqual` for constant-time comparison | Passed |
| installationId extracted before Redis dedup | Passed |
| Redis key: `installation:{id}:delivery:{id}` NX EX 259200 | Passed |
| BullMQ `jobId: deliveryId` | Passed |
| Job payload contains identifiers only | Passed |
| fastify-plugin wraps redis decorator | Passed |
| `tsc --noEmit` exits 0 | Passed |

## Next Phase Readiness

- **01-05 (webhook worker):** Can now consume from `webhook-ingestion` queue — queue is populated by this receiver
- **01-06 (Railway deployment):** `.env.example` documents all required env vars; split-process architecture ready
