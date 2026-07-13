---
phase: 01-github-app-foundation
plan: "03"
subsystem: queue+github
tags: [bullmq, ioredis, octokit, zod, job-queues, redis, github-app]

dependency-graph:
  requires: ["01-01"]
  provides: ["@ciintel/queue", "@ciintel/github"]
  affects: ["01-04", "01-05"]

tech-stack:
  added: [bullmq@5, ioredis@5, "@octokit/app@16", "@octokit/auth-app@8", zod@3]
  patterns: [singleton-with-lazy-init, typed-job-payloads, redis-singleton, installation-token-factory]

key-files:
  created:
    - packages/queue/src/redis.ts
    - packages/queue/src/jobs.ts
    - packages/queue/src/queues.ts
    - packages/queue/src/flow.ts
    - packages/github/src/app.ts
    - packages/github/src/clients.ts
  modified:
    - packages/queue/src/index.ts
    - packages/github/src/index.ts
    - packages/github/package.json
    - package.json
    - tsconfig.base.json
    - pnpm-lock.yaml

decisions:
  - id: maxRetriesPerRequest-null
    choice: "ioredis singleton always sets maxRetriesPerRequest: null"
    rationale: "BullMQ throws at worker startup if this is omitted; non-negotiable requirement"
  - id: identifiers-only-payloads
    choice: "Job payloads contain only numeric/string identifiers, no secrets or content"
    rationale: "Secrets in Redis would be accessible to any process with Redis access; fetch data at job-execution time instead"
  - id: private-key-normalization
    choice: "App singleton normalizes \\n to actual newlines in GITHUB_APP_PRIVATE_KEY"
    rationale: "Railway stores multi-line env vars with literal backslash-n; normalization ensures PEM parsing succeeds"
  - id: installation-token-auto-refresh
    choice: "getInstallationClient(id) delegates to @octokit/auth-app which caches tokens for 59 minutes"
    rationale: "No manual token management needed; call at job-start time, never cache the returned client"

metrics:
  duration: "~9m"
  completed: "2026-07-13"
---

# Phase 1 Plan 3: Queue and GitHub Packages Summary

**One-liner:** BullMQ queue package with 4 Zod-typed queues + DLQ + FlowProducer using a deduplicated ioredis singleton, and Octokit App singleton with `\n`-normalized private key and dual client factories (JWT app-level + installation-token-scoped).

## What Was Built

### @ciintel/queue

- **redis.ts** — ioredis singleton with `maxRetriesPerRequest: null` and `enableReadyCheck: false` (both required for BullMQ compatibility)
- **jobs.ts** — 4 Zod schemas (`WebhookIngestionJobSchema`, `DetectorDispatchJobSchema`, `AiAnalysisJobSchema`, `ActionExecutionJobSchema`) with matching TypeScript types; all payloads contain identifiers only
- **queues.ts** — 5 BullMQ `Queue` instances: webhook-ingestion, detector-dispatch, ai-analysis, action-execution, dlq; exponential backoff (3 attempts, 2s base); DLQ has `removeOnFail: false`
- **flow.ts** — `FlowProducer` singleton for linked job chains
- **index.ts** — exports all queues, schemas, types, getRedis, getFlowProducer

### @ciintel/github

- **app.ts** — `@octokit/app` App singleton; validates presence of GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET; normalizes `\n` escape sequences in private key for Railway env var format
- **clients.ts** — `getAppClient()` returns JWT-authenticated App-level Octokit; `getInstallationClient(id)` is async and delegates to `app.getInstallationOctokit(id)` for auto-refreshing installation tokens
- **index.ts** — exports getApp, getAppClient, getInstallationClient

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| maxRetriesPerRequest | Always `null` on ioredis | BullMQ worker throws on startup if omitted |
| Job payload content | Identifiers only (IDs, SHAs, refs) | Secrets in Redis are globally accessible to Redis clients |
| Private key normalization | `.replace(/\\n/g, "\n")` | Railway env vars store PEM keys with literal backslash-n |
| Installation token caching | Delegate to @octokit/auth-app | 59-min LRU cache; call getInstallationClient at job-start, never cache result |
| @octokit/core dep | Added as direct dep to @ciintel/github | clients.ts imports `Octokit` type explicitly; peerDep was insufficient for tsc |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript target `es2025` not valid in TypeScript 5.9.3**

- **Found during:** Task 1 initial tsc --noEmit
- **Issue:** `tsconfig.base.json` had `"target": "es2025"` which TypeScript 5.9.3 rejects; valid options end at `es2024` and `esnext`
- **Fix:** Changed to `"target": "esnext"` which is always valid and equivalent for Node.js 22 ESM builds
- **Files modified:** `tsconfig.base.json`
- **Commit:** a510f20

**2. [Rule 1 - Bug] Duplicate ioredis versions (5.10.1 + 5.11.1) causing TypeScript type incompatibility**

- **Found during:** Task 1 initial tsc --noEmit
- **Issue:** `@ciintel/queue` depended on ioredis@5.11.1, BullMQ pinned ioredis@5.10.1; two distinct module instances caused `Redis` type mismatch on `connection:` parameter
- **Fix:** Added `pnpm.overrides: { "ioredis": "5.11.1" }` to root `package.json`; forced reinstall and cleared orphaned 5.10.1 virtual store folder; deleted stale `.tsbuildinfo` cache
- **Files modified:** `package.json`, `pnpm-lock.yaml`
- **Commit:** a510f20

**3. [Rule 3 - Blocking] Missing `@octokit/core` direct dependency in @ciintel/github**

- **Found during:** Task 2 initial tsc --noEmit
- **Issue:** `clients.ts` imports `Octokit` type from `@octokit/core` but that package was only a transitive dependency; TypeScript module resolution could not find it
- **Fix:** Added `"@octokit/core": "^7.0.6"` to `packages/github/package.json` dependencies
- **Files modified:** `packages/github/package.json`, `pnpm-lock.yaml`
- **Commit:** 9cc5e43

## Next Phase Readiness

Plan 04 (API webhook receiver) and Plan 05 (worker) can now import from both packages:

- `import { webhookIngestionQueue, WebhookIngestionJobSchema } from "@ciintel/queue"` — ready
- `import { getInstallationClient } from "@ciintel/github"` — ready
- Redis singleton with correct BullMQ settings — ready
- GitHub App authentication and installation token factory — ready

No blockers for Plan 04 or Plan 05.
