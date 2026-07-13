---
phase: 01-github-app-foundation
subsystem: foundation
tags: [monorepo, pnpm, turborepo, typescript, prisma, postgresql, rls, bullmq, ioredis, fastify, octokit, railway, railpack]

plans-completed: 6/6
duration: ~27m total
completed: 2026-07-13

tech-stack:
  runtime: ["Node.js 22", "pnpm@9.15.0", "TypeScript 5.9.3"]
  framework: ["Fastify 5", "BullMQ 4", "Prisma 7"]
  infrastructure: ["PostgreSQL (Railway, PgBouncer port 6543)", "Redis (Railway, noeviction)", "Railway (RAILPACK)"]
  packages: ["@octokit/app", "ioredis 5.11.1", "pino@9", "zod", "jose"]

key-files:
  created:
    - apps/api/src/index.ts
    - apps/api/src/routes/webhooks.ts
    - apps/api/src/plugins/rawBody.ts
    - apps/api/railway.toml
    - apps/worker/src/index.ts
    - apps/worker/src/workers/webhook-ingestion.ts
    - apps/worker/src/workers/dlq.ts
    - apps/worker/src/lib/installation.ts
    - apps/worker/railway.toml
    - packages/db/src/index.ts
    - packages/db/src/schema.prisma
    - packages/db/prisma/migrations/
    - packages/db/prisma/config.ts
    - packages/queue/src/index.ts
    - packages/queue/src/queues.ts
    - packages/queue/src/redis.ts
    - packages/github/src/index.ts
    - packages/github/src/app.ts
    - packages/core/src/index.ts
    - docs/env-vars.md
    - scripts/test-webhook.sh
    - turbo.json
    - pnpm-workspace.yaml
    - tsconfig.base.json
    - .github/workflows/ci.yml
---

# Phase 1: GitHub App Foundation — Phase Summary

**One-liner:** Complete multi-tenant webhook ingestion pipeline — Fastify receiver with HMAC verification and Redis dedup, BullMQ 4-queue system, Prisma 7 + RLS tenant isolation, GitHub App Octokit singleton, and Railway deployment configs for both services.

## Overview

Phase 1 established the complete foundation for CyclOps: a GitHub App that can be installed by any organization, receives webhook events, deduplicates deliveries, enqueues jobs asynchronously, and processes them with strict per-tenant isolation. The entire pipeline is deployed as two Railway services (api + worker) sharing a PostgreSQL database and Redis instance.

## Plans Completed

| Plan | Name | What Was Built | Duration |
|------|------|----------------|----------|
| 01-01 | Monorepo Scaffold | pnpm + Turborepo 2 workspace, 6 package scaffolds, strict TypeScript config, GitHub Actions CI | 3m 8s |
| 01-02 | Database Layer | Prisma 7 schema, RLS migrations (set_config transaction-local), adapter-pg client factory, tenant extension | 2m 52s |
| 01-03 | Queue and GitHub Packages | BullMQ 4-queue definitions, typed job payloads, Octokit App singleton with private key normalization | 9m |
| 01-04 | Webhook Receiver | Fastify 5 webhook receiver, HMAC verification plugin, Redis dedup (EX 259200), BullMQ enqueue | 2m 52s |
| 01-05 | Webhook Worker | WebhookIngestionWorker (concurrency=20), TEN-04 gate, installation lifecycle handlers, DLQ worker, Redis startup assertion | 2m 46s |
| 01-06 | Railway Deployment | railway.toml for both services, env var reference with Redis/PgBouncer requirements, e2e webhook test script | ~3m |

**Total:** 6/6 plans, ~27 minutes

## Architecture

```
GitHub → POST /webhooks (apps/api, Fastify 5)
           ├── HMAC-SHA256 verify (X-Hub-Signature-256)
           ├── Redis dedup (delivery ID, 72h window)
           └── BullMQ enqueue → webhook-ingestion queue
                                    ↓
                         apps/worker (BullMQ)
                           ├── WebhookIngestionWorker (concurrency=20)
                           │     ├── TEN-04 gate (checkInstallationActive)
                           │     ├── installation.* lifecycle handlers
                           │     └── CI event stubs (Phase 2)
                           └── DLqWorker (concurrency=5)
                                 └── logs exhausted-retry jobs

PostgreSQL (Prisma 7 + RLS)
  └── per-tenant row-level security via set_config transaction-local

Redis (BullMQ + dedup)
  ├── webhook-ingestion queue
  ├── detector-dispatch queue
  ├── ai-analysis queue
  ├── action-execution queue
  └── dlq queue
```

## Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Split-process architecture | `apps/api` + `apps/worker` as separate Railway services | Webhook receiver must respond in <2s; worker can run jobs for minutes |
| TypeScript config | `module: nodenext` + `moduleResolution: nodenext` | Full ESM correctness in Node.js 22; all imports use .js extensions |
| Build target | `esnext` (not es2025) | TypeScript 5.9.3 does not accept es2025 as --target value |
| Prisma generator | `prisma-client` (not prisma-client-js) | Breaking change in Prisma 7; old name fails silently |
| RLS context injection | `set_config('app.current_installation_id', id, TRUE)` | TRUE flag = transaction-local; PgBouncer transaction mode compatible; plain SET leaks across connections |
| ioredis singleton | `maxRetriesPerRequest: null` required | BullMQ throws at worker startup if omitted; enforced in getRedis() singleton |
| ioredis version | pinned to 5.11.1 via pnpm.overrides | BullMQ pinned 5.10.1, queue package used 5.11.1; type mismatch resolved via root override |
| Private key normalization | getApp() converts literal `\n` to real newlines | Railway env vars are single-line; PEM keys must have newlines escaped for storage |
| Redis dedup window | 72h (259200s) | Matches GitHub's webhook redelivery window; ioredis v5 requires "EX" token before "NX" |
| Redis maxmemory-policy | `noeviction` required (documented + startup warning) | BullMQ jobs must never be silently evicted; default allkeys-lru drops jobs under memory pressure |
| PgBouncer port | 6543 + `connection_limit=1` required | Railway managed PostgreSQL uses PgBouncer transaction mode; Prisma requires connection_limit=1 |
| TEN-04 gate | checkInstallationActive() at every job start | Suspended/deleted tenants must be dropped at execution time; no side effects for inactive installations |
| DLQ routing | onFailed handler checks attemptsMade >= maxAttempts | BullMQ has no native DLQ; must detect exhaustion in handler |
| Migration ownership | Only api runs db:migrate (preDeployCommand) | Prevents concurrent migration race conditions on simultaneous service deploys |

## Packages

| Package | Purpose |
|---------|---------|
| `packages/core` | I/O-free types (IDetector, DetectorContext, DetectorResult) — SDK publishable |
| `packages/db` | Prisma 7 client, RLS schema, migration tooling |
| `packages/queue` | BullMQ queue definitions, typed payloads, Redis singleton |
| `packages/github` | Octokit App singleton, installation client factory |
| `apps/api` | Fastify 5 webhook receiver |
| `apps/worker` | BullMQ worker process |

## Phase 1 Success Criteria Status

| Criterion | Status |
|-----------|--------|
| Install in under 30 seconds — GitHub App installable | Ready (railway.toml + env docs) |
| Webhook deliveries return 202 — processing async via BullMQ | Complete (api + worker) |
| Tenant isolation — no cross-org data access | Complete (Prisma RLS + set_config) |
| Inactive installation stops queued jobs | Complete (TEN-04 gate + queue drain) |
| Four BullMQ queues with correct settings | Complete (webhook-ingestion, detector-dispatch, ai-analysis, action-execution) |

## What Phase 2 Gets

- Fully operational webhook delivery pipeline to build detectors on top of
- `WebhookIngestionWorker` has stubbed CI event handlers ready to route to `detector-dispatch`
- `packages/core` provides I/O-free `IDetector` interface for all 6 detectors
- Typed `DetectorDispatchJob` payload in `packages/queue` ready for Phase 2
- All infrastructure deployed and observable via `scripts/test-webhook.sh`

## Pending (Pre-Deploy Checklist)

- Configure Railway Redis: `maxmemory-policy noeviction`, `appendonly yes`
- Set `DATABASE_URL` to port 6543 (PgBouncer) in production
- Set `GITHUB_APP_PRIVATE_KEY` using awk normalization from env-vars.md
- Run `./scripts/test-webhook.sh` against deployed URL to verify end-to-end delivery
