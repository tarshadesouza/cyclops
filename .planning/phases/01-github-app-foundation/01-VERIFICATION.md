---
phase: 01-github-app-foundation
verified: 2026-07-13T09:41:40Z
status: passed
score: 19/19 must-haves verified
gaps: []
---

# Phase 1: GitHub App Foundation — Verification Report

**Phase Goal:** A GitHub App that any org can install in under 30 seconds, receives webhook events from GitHub, enqueues them for async processing, and maintains strict per-tenant data isolation.
**Verified:** 2026-07-13T09:41:40Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Developer can install cyclops[bot] from a GitHub URL in under 30 seconds | ? HUMAN | Railway deployment artifacts and manifest exist; live install flow needs human test |
| 2 | Webhook deliveries show 202 responses; processing is async via BullMQ | ✓ VERIFIED | `webhooks.ts:86` returns 202 after enqueue; BullMQ add is async |
| 3 | Installing on one org cannot read/write another org's data | ✓ VERIFIED | RLS migration `0002_rls` enables policy on all tenant tables; `tenant.ts` uses transaction-local `set_config` |
| 4 | Deleting or suspending an installation stops all queued jobs | ✓ VERIFIED | `handleInstallationDeleted` drains waiting+delayed jobs; `checkInstallationActive` drops suspended/deleted at job start |
| 5 | Four BullMQ queues exist with correct concurrency and retention | ✓ VERIFIED | `queues.ts` defines 4 main queues + DLQ; `webhook-ingestion` worker has `concurrency: 20`; `attempts: 3` and retention set |

**Score:** 4/5 truths fully verified by code (1 requires human for live install flow)

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/routes/webhooks.ts` | Webhook receiver returning 202 | ✓ VERIFIED | 89 lines, substantive, registered in index.ts |
| `apps/api/src/plugins/raw-body.ts` | rawBody plugin with runFirst+global=false | ✓ VERIFIED | 11 lines, `runFirst: true`, `global: false` confirmed |
| `apps/api/src/index.ts` | Registers rawBodyPlugin before routes | ✓ VERIFIED | rawBodyPlugin registered line 14, routes lines 17-18 |
| `packages/db/src/extensions/tenant.ts` | Tenant isolation via set_config TRUE | ✓ VERIFIED | 37 lines, `set_config(..., TRUE)` transaction-local confirmed |
| `packages/db/prisma/migrations/0002_rls/migration.sql` | RLS on tenant tables | ✓ VERIFIED | ENABLE ROW LEVEL SECURITY on installations + webhook_deliveries |
| `apps/worker/src/lib/installation.ts` | Active installation check | ✓ VERIFIED | 39 lines, checks both `suspended` and `deletedAt` |
| `apps/worker/src/workers/webhook-ingestion.ts` | Webhook ingestion worker | ✓ VERIFIED | 173 lines, concurrency=20, DLQ routing, installation.deleted drain |
| `packages/queue/src/queues.ts` | 4 main queues + DLQ | ✓ VERIFIED | Exactly 5 queues defined with attempts:3 defaultJobOptions |
| `apps/api/railway.toml` | RAILPACK builder + migration preDeployCommand | ✓ VERIFIED | builder="RAILPACK", preDeployCommand runs db:migrate |
| `apps/worker/railway.toml` | RAILPACK builder, no migration step | ✓ VERIFIED | builder="RAILPACK", no preDeployCommand present |
| `docs/env-vars.md` | Documents noeviction Redis requirement | ✓ VERIFIED | noeviction documented with rationale under WHK-05 section |
| `scripts/test-webhook.sh` | Executable with HMAC signing | ✓ VERIFIED | `-rwxr-xr-x`, openssl dgst HMAC-SHA256 signing logic present |

---

## Must-Have Checklist (19/19)

| # | Must-Have | Status | Evidence |
|---|-----------|--------|---------|
| 1 | `webhooks.ts` exists and returns 202 for valid signed requests | PASS | `reply.status(202).send(...)` line 86 |
| 2 | `webhooks.ts` uses `timingSafeEqual` for HMAC | PASS | `timingSafeEqual` imported from `node:crypto`, called line 16 |
| 3 | `webhooks.ts` uses `request.rawBody` for HMAC (not parsed body) | PASS | `verifyWebhookSignature(webhookSecret, request.rawBody as string, signature)` line 49 |
| 4 | `raw-body.ts` registers with `runFirst: true` and `global: false` | PASS | Both flags confirmed in file lines 6, 9 |
| 5 | `index.ts` registers rawBodyPlugin before route plugins | PASS | `register(rawBodyPlugin)` line 14 precedes `register(healthRoutes)` line 17 and `register(webhookRoutes)` line 18 |
| 6 | Redis dedup key uses `installation:{id}:delivery:{id}` with NX EX 259200 | PASS | `installation:${installationId}:delivery:${deliveryId}` with `"EX", 259200, "NX"` lines 63-64 |
| 7 | BullMQ enqueue uses `jobId: deliveryId` for second-layer dedup | PASS | `webhookIngestionQueue.add("webhook", jobData, { jobId: deliveryId })` line 80-82 |
| 8 | `tenant.ts` calls `set_config` with TRUE flag (transaction-local) | PASS | `set_config('app.current_installation_id', ${...}, TRUE)` line 29 |
| 9 | Prisma schema has RLS-enabled tables in migrations | PASS | `0002_rls/migration.sql` enables + forces RLS on both tenant tables |
| 10 | `installation.ts` checks both `suspended` and `deletedAt` | PASS | `if (installation.deletedAt)` line 28, `if (installation.suspended)` line 33 |
| 11 | `webhook-ingestion.ts` has concurrency=20 | PASS | `concurrency: 20` line 144 |
| 12 | `webhook-ingestion.ts` handles installation.deleted by draining queue jobs | PASS | `handleInstallationDeleted` removes waiting+delayed jobs from webhookIngestionQueue + detectorDispatchQueue lines 38-70 |
| 13 | `webhook-ingestion.ts` routes exhausted-retry jobs to DLQ | PASS | `worker.on("failed", ...)` checks `attemptsMade >= maxAttempts` and adds to `dlqQueue` lines 157-170 |
| 14 | `queues.ts` defines exactly 4 main queues + DLQ (5 total) | PASS | webhook-ingestion, detector-dispatch, ai-analysis, action-execution, dlq — exactly 5 |
| 15 | `queues.ts` has `attempts: 3` default | PASS | `attempts: 3` in `defaultJobOptions` line 13 |
| 16 | `apps/api/railway.toml` has RAILPACK builder and migration preDeployCommand | PASS | `builder = "RAILPACK"`, `[deploy.preDeployCommand]` with `db:migrate` |
| 17 | `apps/worker/railway.toml` has RAILPACK builder and NO migration step | PASS | `builder = "RAILPACK"`, no preDeployCommand section |
| 18 | `docs/env-vars.md` documents noeviction Redis requirement | PASS | Section "Redis Server Configuration (WHK-05)" documents `maxmemory-policy noeviction` with rationale |
| 19 | `scripts/test-webhook.sh` is executable and contains HMAC signing | PASS | Permissions `-rwxr-xr-x`, HMAC-SHA256 via `openssl dgst -sha256 -hmac` |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `webhooks.ts` | `webhookIngestionQueue` | `webhookIngestionQueue.add(...)` | WIRED | Import confirmed line 3, add() called line 80 |
| `webhooks.ts` | Redis dedup | `app.redis.set(...)` with NX | WIRED | `app.redis.set(dedupKey, "1", "EX", 259200, "NX")` line 64 |
| `index.ts` | `rawBodyPlugin` | `app.register(rawBodyPlugin)` | WIRED | Line 14, before routes |
| `webhook-ingestion.ts` | `checkInstallationActive` | import + call at job start | WIRED | Import line 11, called line 105 |
| `webhook-ingestion.ts` | `dlqQueue` | `dlqQueue.add(...)` in failed handler | WIRED | Import line 8, add() line 161 |
| `tenant.ts` | PostgreSQL RLS | `set_config` in `$transaction` | WIRED | Transaction wraps all model operations line 28-31 |
| RLS migration | tenant tables | `ENABLE ROW LEVEL SECURITY` | WIRED | Policies on `installations` and `webhook_deliveries` |

---

## Anti-Patterns Found

None. No TODO/FIXME/placeholder/stub patterns detected in phase artifacts.

---

## Human Verification Required

### 1. GitHub App Install Flow

**Test:** Navigate to the GitHub App manifest URL or direct install link; click Install; select an org; authorize permissions.
**Expected:** App appears as authorized in org's GitHub Settings → Installed GitHub Apps within 30 seconds.
**Why human:** Live GitHub OAuth flow and app installation cannot be verified from static code analysis.

### 2. Webhook Delivery Roundtrip

**Test:** After deploying to Railway, use GitHub App settings → Recent Deliveries to trigger a test ping; observe delivery log.
**Expected:** Delivery shows HTTP 202 response; worker logs show job picked up and processed.
**Why human:** Requires live deployed environment and GitHub webhook delivery infrastructure.

---

## Summary

All 19 code-level must-haves pass. The implementation is substantive throughout — no stubs, no placeholder components, no unwired artifacts detected.

Key strengths:
- HMAC verification uses `timingSafeEqual` over raw body (timing-safe, correct input)
- Dedup is two-layer: Redis NX key (3-day TTL) + BullMQ `jobId`
- Tenant isolation is defense-in-depth: Prisma extension enforces `set_config` on every query, PostgreSQL RLS enforces at DB layer with transaction-local scope
- Installation lifecycle (created/deleted/suspended/unsuspended) is fully handled
- DLQ routing is implemented in the failed handler, not just logged
- Railway deployment is correctly split: API runs migrations, worker does not

Two items require a human with a live environment: the GitHub App install flow (30-second SLA) and end-to-end webhook delivery roundtrip.

---

_Verified: 2026-07-13T09:41:40Z_
_Verifier: Claude (gsd-verifier)_
