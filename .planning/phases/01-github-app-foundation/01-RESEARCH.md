# Phase 1: GitHub App Foundation - Research

**Researched:** 2026-07-13
**Domain:** GitHub App platform, Fastify webhook receiver, BullMQ queue architecture, Prisma 7 multi-tenancy, Railway monorepo deployment
**Confidence:** HIGH (most claims verified against official docs and current tooling)

---

## Summary

Phase 1 establishes the complete infrastructure backbone for CyclOps: a pnpm + Turborepo 2 monorepo, a GitHub App installable by any org, a Fastify 5 webhook receiver with HMAC verification, a 4-queue BullMQ architecture for async processing, a Prisma 7 multi-tenant data layer with Row-Level Security, and Railway deployment config for separate api/worker services.

The most critical architectural constraint is **PgBouncer must run in transaction mode** and all RLS tenant context must be set with `SET LOCAL` (via `set_config(..., TRUE)`) inside a transaction. Using plain `SET` with PgBouncer in transaction mode will leak tenant context across connections and is a data isolation failure.

TypeScript 7 has hard errors for `moduleResolution: node` and `target: es5` — both must be replaced with `nodenext` and `es2025` respectively. Prisma 7 requires `@prisma/adapter-pg` (driver adapters are now mandatory) and generates to a custom output path, no longer to `node_modules`.

**Primary recommendation:** Wire the webhook receiver to call `app.webhooks.verifyAndReceive()` with the raw string body from `request.rawBody` — never the parsed `request.body`. Get `name` from `X-GitHub-Event` header, `signature` from `X-Hub-Signature-256`, `id` from `X-GitHub-Delivery`. The `@octokit/webhooks` library rejects non-string payloads.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@octokit/app` | 16.1.2 | App-level GitHub client, installation iterator, webhook router | Official GitHub SDK; manages JWT and installation token lifecycle |
| `@octokit/auth-app` | 8.2.0 | App JWT + installation token auth strategy | LRU cache of 15K tokens, 59-min invalidation before 1-hr expiry |
| `@octokit/webhooks` | 14.2.0 | Webhook HMAC verification + typed event dispatch | Only library with full TypeScript event payload types for all GH events |
| `fastify` | 5.10.0 | HTTP server for webhook receiver and API | Fastest Node.js framework; encapsulation model maps directly to route isolation |
| `fastify-raw-body` | 5.0.0 | Captures raw request body before JSON parsing | Required for HMAC; Fastify 5 compatible |
| `bullmq` | 5.79.3 | Job queues on Redis | FlowProducer for fan-out, built-in dedup via jobId, typed job data |
| `ioredis` | 5.11.1 | Redis client | BullMQ's required Redis client; `maxRetriesPerRequest: null` required |
| `prisma` | 7.8.0 | ORM + schema migration | Client extensions API for installationId injection; RLS via raw SQL migration |
| `@prisma/adapter-pg` | matching | PostgreSQL driver adapter | Required in Prisma 7; no longer optional |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pg` | 8.x | PostgreSQL Node.js driver | Underlying driver for `@prisma/adapter-pg` |
| `dotenv` | 16.x | Environment variable loading | Prisma 7 no longer auto-loads `.env` for migrations; explicit load required |
| `zod` | 3.x | Runtime schema validation for job payloads | Validates job data shape when dequeuing |
| `pino` | 9.x | Structured logging | Fastify's default logger; Railway shows pino JSON logs in dashboard |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@octokit/app` | Probot | Probot forces Express middleware model; incompatible with Fastify 5 encapsulation |
| BullMQ | Temporal / Inngest | More infra overhead; BullMQ on Redis is sufficient for Phase 1 |
| Prisma 7 RLS extension | per-query WHERE filters | DB-layer enforcement is more secure; Prisma extension can be bypassed if forgotten |

### Installation
```bash
pnpm add @octokit/app @octokit/auth-app @octokit/webhooks
pnpm add fastify fastify-raw-body
pnpm add bullmq ioredis
pnpm add @prisma/client @prisma/adapter-pg pg
pnpm add -D prisma
```

---

## Architecture Patterns

### Recommended Monorepo Structure
```
ciintel/
├── pnpm-workspace.yaml          # declares apps/* packages/*
├── turbo.json                   # task pipeline
├── package.json                 # root: "private": true, turbo scripts
├── tsconfig.base.json           # shared TS options (nodenext, es2025, strict)
├── apps/
│   ├── api/                     # Fastify webhook receiver + REST API
│   │   ├── package.json         # name: "@ciintel/api"
│   │   ├── tsconfig.json        # extends ../../tsconfig.base.json, composite: true
│   │   ├── railway.toml         # api service deploy config
│   │   └── src/
│   │       ├── index.ts         # Fastify server entry point
│   │       ├── plugins/
│   │       │   ├── github.ts    # App instance + getInstallationClient factory
│   │       │   └── queue.ts     # BullMQ queue instances
│   │       └── routes/
│   │           └── webhooks.ts  # POST /webhooks/github
│   └── worker/
│       ├── package.json         # name: "@ciintel/worker"
│       ├── tsconfig.json        # extends ../../tsconfig.base.json, composite: true
│       ├── railway.toml         # worker service deploy config
│       └── src/
│           ├── index.ts         # Worker process entry
│           └── workers/
│               ├── webhook-ingestion.ts
│               ├── detector-dispatch.ts
│               ├── ai-analysis.ts
│               └── action-execution.ts
├── packages/
│   ├── db/                      # Prisma schema + generated client + RLS migrations
│   │   ├── package.json         # name: "@ciintel/db"
│   │   ├── tsconfig.json
│   │   ├── prisma.config.ts     # Prisma 7 config
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── src/
│   │       ├── client.ts        # PrismaClient factory with adapter-pg
│   │       └── extensions/
│   │           └── tenant.ts    # installationId injection extension
│   ├── queue/                   # Queue names, job type definitions, FlowProducer
│   │   ├── package.json         # name: "@ciintel/queue"
│   │   └── src/
│   │       ├── queues.ts        # Queue instances (named exports)
│   │       ├── types.ts         # Job data interfaces
│   │       └── flow.ts          # FlowProducer setup
│   ├── github/                  # Octokit factory functions
│   │   ├── package.json         # name: "@ciintel/github"
│   │   └── src/
│   │       ├── app.ts           # App singleton
│   │       └── clients.ts       # getAppClient() / getInstallationClient()
│   └── core/                    # Shared types, constants, utilities
│       ├── package.json         # name: "@ciintel/core"
│       └── src/
│           ├── types.ts
│           └── constants.ts
```

### Pattern 1: Turborepo + pnpm Workspace Configuration

**pnpm-workspace.yaml:**
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

**turbo.json (root):**
```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "inputs": ["src/**/*.ts", "tsconfig.json", "package.json"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "outputs": [],
      "inputs": ["src/**/*.ts"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "db:generate": {
      "cache": false
    },
    "db:migrate": {
      "cache": false
    }
  }
}
```

**Root tsconfig.base.json (TypeScript 7 compliant):**
```json
{
  "compilerOptions": {
    "target": "es2025",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true
  }
}
```

**Per-package tsconfig.json (e.g., packages/db):**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "references": []
}
```

**TypeScript 7 hard errors to avoid:**
- `"moduleResolution": "node"` or `"node10"` — use `"nodenext"` instead
- `"target": "es5"` — use `"es2025"` or at minimum `"es2022"`
- `"baseUrl": "."` — removed entirely; use path aliases via `paths` only
- `"strict": false` is effectively the default in TS7; be explicit if you need to relax it

### Pattern 2: GitHub App Factory Functions

**packages/github/src/app.ts:**
```typescript
// Source: https://github.com/octokit/app.js README
import { App } from "@octokit/app";

let _app: App | null = null;

export function getApp(): App {
  if (!_app) {
    _app = new App({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      webhooks: {
        secret: process.env.GITHUB_WEBHOOK_SECRET!,
      },
    });
  }
  return _app;
}
```

**packages/github/src/clients.ts:**
```typescript
// getAppClient() — authenticates as the App itself (JWT)
// Use for: listing installations, app-level API calls
export async function getAppClient() {
  return getApp().octokit;
}

// getInstallationClient(installationId) — authenticates as installation
// Use for: all repository operations, PR checks, issue comments
// Token cached by @octokit/auth-app for 59 minutes (expires at 60)
export async function getInstallationClient(installationId: number) {
  return getApp().getInstallationOctokit(installationId);
}
```

**Critical:** `getInstallationClient` is called at **worker job-start**, not stored in the job payload. Installation tokens expire in 1 hour; @octokit/auth-app caches up to 15,000 simultaneously and refreshes automatically. Never put tokens in BullMQ job data.

### Pattern 3: Fastify Webhook Receiver

**Registration order is mandatory:** `fastify-raw-body` must be registered before any routes that need `request.rawBody`.

```typescript
// apps/api/src/index.ts
import Fastify from "fastify";
import rawBody from "fastify-raw-body";

const app = Fastify({ logger: true });

// Step 1: register raw-body FIRST, before any routes
await app.register(rawBody, {
  field: "rawBody",
  global: false,   // opt-in per route to save memory
  encoding: "utf8",
  runFirst: true,
});

// Step 2: register webhook routes plugin
await app.register(webhookRoutes, { prefix: "/webhooks" });
```

**apps/api/src/routes/webhooks.ts:**
```typescript
import type { FastifyPluginAsync } from "fastify";
import { getApp } from "@ciintel/github";
import { webhookIngestionQueue } from "@ciintel/queue";

const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/github", {
    config: { rawBody: true },  // enable rawBody for this route

    // HMAC verification happens in preHandler — before the main handler
    preHandler: async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"] as string;
      const rawBody = request.rawBody as string;

      if (!signature || !rawBody) {
        return reply.code(400).send({ error: "Missing signature or body" });
      }

      const isValid = await getApp().webhooks.verify(rawBody, signature);
      if (!isValid) {
        return reply.code(401).send({ error: "Invalid signature" });
      }
    },

    handler: async (request, reply) => {
      // WHK-02: return 202 immediately
      reply.code(202).send({ queued: true });

      const deliveryId = request.headers["x-github-delivery"] as string;
      const eventName = request.headers["x-github-event"] as string;
      const signature = request.headers["x-hub-signature-256"] as string;

      // WHK-03 layer 1: Redis dedup (SET NX EX 259200 = 3 days)
      const isDuplicate = !(await redis.set(
        `webhook:dedup:${deliveryId}`,
        "1",
        "EX",
        259200,
        "NX"
      ));
      if (isDuplicate) return;

      // WHK-06: enqueue identifiers only — no token, no log content
      await webhookIngestionQueue.add(
        eventName,
        {
          deliveryId,
          eventName,
          installationId: (request.body as any).installation?.id,
        },
        {
          jobId: deliveryId,  // BullMQ dedup: ignored if same ID already queued
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        }
      );
    },
  });
};
```

**Why not use `app.webhooks.verifyAndReceive()`:** That method dispatches event handlers synchronously. For WHK-02 (202 immediately, async processing) you need to split verification and handling. Use `webhooks.verify()` in preHandler and enqueue in the handler.

### Pattern 4: BullMQ 4-Queue Architecture

**Queue names (packages/queue/src/queues.ts):**
```typescript
import { Queue, FlowProducer } from "bullmq";
import { Redis } from "ioredis";

// WHK-05: noeviction + appendonly must be set in Redis config
export const redisConnection = new Redis({
  host: process.env.REDIS_HOST!,
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,  // required by BullMQ
});

export const webhookIngestionQueue = new Queue("webhook-ingestion", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  },
});

export const detectorDispatchQueue = new Queue("detector-dispatch", {
  connection: redisConnection,
});

export const aiAnalysisQueue = new Queue("ai-analysis", {
  connection: redisConnection,
});

export const actionExecutionQueue = new Queue("action-execution", {
  connection: redisConnection,
});

// Dead letter queue — receives jobs that exhausted all retries
export const dlqQueue = new Queue("dead-letter", {
  connection: redisConnection,
});

export const flowProducer = new FlowProducer({
  connection: redisConnection,
});
```

**FlowProducer fan-out (webhook-ingestion → detector-dispatch):**
```typescript
// Source: https://docs.bullmq.io/guide/flows
// In webhook-ingestion worker, after parsing the event:
await flowProducer.add({
  name: "dispatch-event",
  queueName: "detector-dispatch",
  data: { deliveryId, eventName, installationId, repositoryId },
  children: [
    // Each detector type runs in parallel
    { name: "check-run-detector", queueName: "detector-dispatch",
      data: { deliveryId, detectorType: "check-run", installationId } },
    { name: "pr-detector", queueName: "detector-dispatch",
      data: { deliveryId, detectorType: "pull-request", installationId } },
  ],
});
```

**Worker definitions (apps/worker/src/workers/webhook-ingestion.ts):**
```typescript
import { Worker, Job } from "bullmq";

export const webhookIngestionWorker = new Worker<WebhookJobData>(
  "webhook-ingestion",
  async (job: Job<WebhookJobData>) => {
    // WHK-04: token minted here, not from job payload
    const octokit = await getInstallationClient(job.data.installationId);
    // ... process
  },
  {
    connection: redisConnection,
    concurrency: 20,    // I/O-bound: webhook parsing is cheap
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  }
);

// DLQ: move exhausted jobs to dead-letter queue
webhookIngestionWorker.on("failed", async (job, err) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await dlqQueue.add("failed-job", {
      originalQueue: "webhook-ingestion",
      jobData: job.data,
      error: err.message,
    });
  }
});
```

**Concurrency recommendations per queue:**
- `webhook-ingestion`: concurrency 20 (I/O-bound, fast)
- `detector-dispatch`: concurrency 10 (moderate, logic-heavy)
- `ai-analysis`: concurrency 5 (rate-limited by AI API)
- `action-execution`: concurrency 10 (I/O-bound, GitHub API calls)

### Pattern 5: Prisma 7 Multi-Tenant Setup

**packages/db/prisma.config.ts:**
```typescript
// Source: https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

**packages/db/prisma/schema.prisma:**
```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

model Installation {
  id              Int      @id
  accountId       Int
  accountLogin    String
  accountType     String   // "Organization" | "User"
  appId           Int
  targetId        Int
  permissions     Json
  events          String[]
  repositorySelection String
  suspended       Boolean  @default(false)
  deletedAt       DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  webhookEvents   WebhookEvent[]
}

model WebhookEvent {
  id             String   @id @default(cuid())
  deliveryId     String   @unique   // WHK-03: PostgreSQL unique constraint
  installationId Int
  eventName      String
  action         String?
  payload        Json
  processedAt    DateTime?
  createdAt      DateTime @default(now())
  installation   Installation @relation(fields: [installationId], references: [id])

  @@index([installationId])
}
```

**packages/db/src/client.ts (Prisma 7 with adapter-pg):**
```typescript
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
  // For Railway + PgBouncer: use transaction mode URL (port 6543 typically)
});

export const prisma = new PrismaClient({ adapter });
```

**packages/db/src/extensions/tenant.ts (Application-layer tenant scoping):**
```typescript
// Source: https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security
import { prisma } from "../client";

// WHK-02 + TEN-02: inject installationId on all queries in application layer
export function getTenantClient(installationId: number) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          // Add installationId filter to all where clauses
          if (args.where !== undefined) {
            args.where = { ...args.where, installationId };
          } else {
            args = { ...args, where: { installationId } };
          }
          return query(args);
        },
      },
    },
  });
}
```

**RLS SQL migration (run after schema creation):**
```sql
-- TEN-01: Enable RLS on all tenant tables
ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" FORCE ROW LEVEL SECURITY;

-- Policy: only return rows matching current installation context
CREATE POLICY tenant_isolation ON "WebhookEvent"
  USING ("installationId" = current_setting('app.current_installation_id', TRUE)::integer);

-- Bypass policy for superuser/migration operations
CREATE POLICY bypass_rls ON "WebhookEvent"
  USING (current_setting('app.bypass_rls', TRUE)::text = 'on');

-- Repeat for Installation table (self-referential: only see own row)
ALTER TABLE "Installation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Installation" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "Installation"
  USING ("id" = current_setting('app.current_installation_id', TRUE)::integer);
```

**RLS context setter for workers (CRITICAL: must use SET LOCAL):**
```typescript
// TEN-05 + PgBouncer compatibility: SET LOCAL scopes to transaction only
// With PgBouncer transaction mode, a plain SET leaks to next client
async function withInstallation<T>(
  installationId: number,
  fn: (client: typeof prisma) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT set_config('app.current_installation_id', ${String(installationId)}, TRUE)
    `;
    // TRUE = LOCAL scope (transaction-scoped, safe with PgBouncer transaction mode)
    return fn(tx as any);
  });
}
```

### Pattern 6: Installation Lifecycle Event Handling

GitHub sends `installation` events with these `action` values:
- `created` — new installation; create `Installation` row, start listening
- `deleted` — uninstalled; mark `deletedAt`, drain/cancel all queued jobs (TEN-04)
- `suspend` — suspended; set `suspended: true`, drop new jobs without processing
- `unsuspend` — resumed; set `suspended: false`, resume processing
- `new_permissions_accepted` — user accepted updated permission request

GitHub sends `installation_repositories` events:
- `added` — `repositories_added[]` array; store repo associations
- `removed` — `repositories_removed[]` array; remove repo associations

**Payload key fields:**
```typescript
interface InstallationPayload {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";
  installation: {
    id: number;
    app_id: number;
    target_id: number;
    account: { login: string; id: number; type: "Organization" | "User" };
    permissions: Record<string, "read" | "write">;
    events: string[];
    repository_selection: "all" | "selected";
    suspended_at: string | null;
  };
  repositories?: Array<{ id: number; name: string; full_name: string; private: boolean }>;
  sender: { login: string; id: number };
}
```

**TEN-04 implementation — suspended/deleted drop jobs:**
```typescript
// In webhook-ingestion worker, before processing any job:
const installation = await prisma.installation.findUnique({
  where: { id: job.data.installationId },
  select: { suspended: true, deletedAt: true },
});

if (!installation || installation.deletedAt || installation.suspended) {
  // Silently drop: return without error so job is marked complete, not failed
  return { skipped: true, reason: "installation inactive" };
}
```

### Pattern 7: Railway Monorepo Deployment

**apps/api/railway.toml:**
```toml
[build]
builder = "RAILPACK"
buildCommand = "pnpm --filter @ciintel/db build && pnpm --filter @ciintel/queue build && pnpm --filter @ciintel/github build && pnpm --filter @ciintel/core build && pnpm --filter @ciintel/api build"
watchPatterns = ["apps/api/**", "packages/**"]

[deploy]
startCommand = "node apps/api/dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 60
restartPolicyType = "ALWAYS"
restartPolicyMaxRetries = 5

[deploy.preDeployCommand]
# Run migrations only on api service, not worker
command = "pnpm --filter @ciintel/db migrate:deploy"
```

**apps/worker/railway.toml:**
```toml
[build]
builder = "RAILPACK"
buildCommand = "pnpm --filter @ciintel/db build && pnpm --filter @ciintel/queue build && pnpm --filter @ciintel/github build && pnpm --filter @ciintel/core build && pnpm --filter @ciintel/worker build"
watchPatterns = ["apps/worker/**", "packages/**"]

[deploy]
startCommand = "node apps/worker/dist/index.js"
restartPolicyType = "ALWAYS"
restartPolicyMaxRetries = 5
# No healthcheck for worker — it's a background process
```

**Railway environment variables needed per service:**

For both api and worker:
```
GITHUB_APP_ID=<number>
GITHUB_PRIVATE_KEY=<PEM string with literal \n>
GITHUB_WEBHOOK_SECRET=<random 32 bytes hex>
DATABASE_URL=postgresql://user:pass@pgbouncer-host:5432/db
REDIS_HOST=<redis service host>
REDIS_PORT=6379
REDIS_PASSWORD=<password>
```

For api only:
```
PORT=3000
NODE_ENV=production
```

**Railway monorepo import:** When importing the GitHub repo into Railway, the platform auto-detects pnpm workspaces and offers to stage both `apps/api` and `apps/worker` as separate services with workspace-filtered commands. Accept and customize from there. The `railway.toml` file must be at the root of each app directory OR Railway must be configured with the correct service root directory.

### Anti-Patterns to Avoid
- **Do not set `moduleResolution: node`** in any tsconfig — TypeScript 7 hard error
- **Do not store installation tokens in BullMQ job payloads** — tokens expire; mint at job-start via `getInstallationClient()`
- **Do not use plain `SET` for RLS context with PgBouncer** — use `set_config(..., TRUE)` inside a transaction (SET LOCAL semantics)
- **Do not parse request body before HMAC verification** — always verify against `request.rawBody` (string), not `request.body` (object)
- **Do not register routes before `fastify-raw-body`** — routes defined before plugin registration are ignored by the plugin
- **Do not use `statement` pooling mode in PgBouncer** — RLS with SET LOCAL requires at minimum `transaction` mode
- **Do not call `prisma generate` manually** — Prisma 7 requires explicit `prisma generate` after `migrate dev` (auto-generation removed)

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HMAC webhook verification | Custom crypto.createHmac flow | `@octokit/webhooks` `webhooks.verify()` | Handles timing-safe comparison, header name normalization, encoding edge cases |
| Installation token lifecycle | Custom token cache with setTimeout | `@octokit/auth-app` via `app.getInstallationOctokit()` | Clock skew handling (30s past iat), LRU with 15K capacity, auto-refresh |
| Webhook event deduplication | Custom SET/GET Redis pattern | BullMQ `jobId` dedup + Redis SET NX EX | Two-layer: BullMQ ignores duplicate jobId; Redis NX catches race before enqueue |
| Job retry with backoff | Manual setTimeout re-enqueue | BullMQ `attempts` + `backoff: { type: "exponential" }` | Handles worker crashes, Redis persistence, max retry tracking |
| Fan-out to multiple queues | Sequential `queue.add()` calls | `FlowProducer.add({ children: [...] })` | Atomic: all or none added; parent waits for all children |
| Multi-tenant query scoping | Manual WHERE in every query | Prisma client extension `$allOperations` | Applied at every query even if developer forgets; defense-in-depth with RLS |
| Database connection pooling | Node.js connection pool | PgBouncer | PgBouncer handles worker scaling without exhausting Postgres connections |

---

## Common Pitfalls

### Pitfall 1: PgBouncer + SET leaks tenant context
**What goes wrong:** Using `SET app.current_installation_id = 123` (not LOCAL) with PgBouncer in transaction mode. The connection is returned to the pool at transaction end but the session variable persists. Next client inheriting that connection sees another tenant's data.
**Why it happens:** PgBouncer transaction mode reuses connections across clients; SET is session-scoped in PostgreSQL.
**How to avoid:** Always use `set_config('app.current_installation_id', id, TRUE)` where the third argument TRUE means LOCAL (transaction-scoped). This is equivalent to `SET LOCAL` and rolls back when the transaction ends.
**Warning signs:** RLS queries returning data for wrong installationId in load tests; cross-tenant data leaks only visible under concurrent load.

### Pitfall 2: fastify-raw-body plugin registration order
**What goes wrong:** Route defined, then plugin registered. `request.rawBody` is undefined in HMAC check. HMAC verification always fails.
**Why it happens:** fastify-raw-body adds a `preParsing` hook; routes registered before it don't have the hook in their lifecycle.
**How to avoid:** Register the plugin as the first thing after creating the Fastify instance, before any route registration.
**Warning signs:** `request.rawBody` is `undefined` in preHandler; all webhook verification fails with "Missing body".

### Pitfall 3: TypeScript 7 `nodenext` module resolution requires file extensions
**What goes wrong:** Imports like `import { foo } from "./bar"` fail at runtime. TypeScript compiles but Node.js ESM loader can't resolve extensionless imports.
**Why it happens:** `moduleResolution: nodenext` enforces Node.js ESM resolution rules, which require explicit `.js` extensions in import specifiers (even for `.ts` source files).
**How to avoid:** Use `.js` extension in all relative imports (TypeScript maps `.ts` → `.js`): `import { foo } from "./bar.js"`.
**Warning signs:** `ERR_MODULE_NOT_FOUND` at runtime; works in `tsc --watch` but fails when running `node dist/index.js`.

### Pitfall 4: Prisma 7 `prisma generate` not auto-running
**What goes wrong:** Run `prisma migrate dev`, schema changes applied, but TypeScript types are stale. Prisma client doesn't reflect new fields.
**Why it happens:** Prisma 7 removed auto-generation on `migrate dev`.
**How to avoid:** Always run `prisma generate` after `prisma migrate dev`. Add to turbo.json: `"db:migrate": { "dependsOn": ["db:generate"] }`.
**Warning signs:** TypeScript errors about missing fields that exist in schema; generated files have older timestamps than migration files.

### Pitfall 5: BullMQ `maxRetriesPerRequest: null` missing
**What goes wrong:** ioredis throws `ECONNRESET` or command timeout errors intermittently. BullMQ worker crashes on Redis reconnect.
**Why it happens:** ioredis default `maxRetriesPerRequest: 3` conflicts with BullMQ's blocking commands (BLMOVE, BRPOPLPUSH). BullMQ requires unlimited retries on its connection.
**How to avoid:** Always set `maxRetriesPerRequest: null` on the ioredis connection passed to BullMQ.
**Warning signs:** `MaxRetriesPerRequestError` in BullMQ worker logs; intermittent job processing failures after Redis restarts.

### Pitfall 6: GitHub App private key formatting
**What goes wrong:** `createAppAuth` throws "secretOrPrivateKey must be an asymmetric key" or similar PEM parsing error.
**Why it happens:** Railway environment variables collapse multi-line PEM strings. The `\n` in the key become literal backslash-n.
**How to avoid:** Store the private key with literal `\n` characters in the environment variable and replace them: `process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, "\n")`.
**Warning signs:** JWT generation fails; GitHub API returns 401 on app-level requests.

### Pitfall 7: WHK-03 two-layer dedup race condition
**What goes wrong:** Two concurrent webhook deliveries with the same `X-GitHub-Delivery` ID both pass Redis NX check (race condition), both get enqueued, both processed.
**Why it happens:** Redis SET NX is atomic per command, but between the NX check and BullMQ `add()` there is a window where a second request can arrive.
**How to avoid:** The two-layer approach closes this gap: Redis NX is layer 1 (fast, mostly catches it), BullMQ `jobId: deliveryId` is layer 2 (BullMQ atomically rejects duplicate jobId). Together they make processing idempotent.
**Warning signs:** Duplicate `webhook_event` rows despite unique constraint — indicates Redis NX succeeded but BullMQ jobId dedup prevented queue entry, which is correct behavior.

---

## Code Examples

### HMAC Verification: Complete Fastify Route
```typescript
// Source: @octokit/webhooks README + fastify-raw-body README
fastify.post<{ Headers: GithubWebhookHeaders }>("/github", {
  config: { rawBody: true },
  preHandler: async (request, reply) => {
    const sig = request.headers["x-hub-signature-256"];
    const raw = request.rawBody;
    if (!sig || !raw) return reply.code(400).send();
    const valid = await getApp().webhooks.verify(raw, sig);
    if (!valid) return reply.code(401).send();
  },
  handler: async (request, reply) => {
    await reply.code(202).send({ ok: true });
    // async work after response sent
  },
});
```

### Installation Event Handler in Worker
```typescript
// In webhook-ingestion worker processor
switch (payload.action) {
  case "created":
    await prisma.installation.upsert({
      where: { id: payload.installation.id },
      update: { suspended: false, deletedAt: null },
      create: {
        id: payload.installation.id,
        accountId: payload.installation.account.id,
        accountLogin: payload.installation.account.login,
        accountType: payload.installation.account.type,
        appId: payload.installation.app_id,
        targetId: payload.installation.target_id,
        permissions: payload.installation.permissions,
        events: payload.installation.events,
        repositorySelection: payload.installation.repository_selection,
      },
    });
    break;
  case "deleted":
    await prisma.installation.update({
      where: { id: payload.installation.id },
      data: { deletedAt: new Date() },
    });
    // TEN-04: drain queued jobs for this installation
    await drainInstallationJobs(payload.installation.id);
    break;
  case "suspend":
    await prisma.installation.update({
      where: { id: payload.installation.id },
      data: { suspended: true },
    });
    break;
  case "unsuspend":
    await prisma.installation.update({
      where: { id: payload.installation.id },
      data: { suspended: false },
    });
    break;
}
```

### Redis Cache Key Pattern (TEN-03)
```typescript
// Format: installation:{id}:{resource_type}:{resource_id}
const cacheKey = (installationId: number, type: string, resourceId: string) =>
  `installation:${installationId}:${type}:${resourceId}`;

// Examples:
// installation:12345:check-run:cr_abc123
// installation:12345:pr:67890
// installation:12345:repo:my-repo
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `moduleResolution: node` | `nodenext` | TypeScript 7.0 | Hard error; must update all tsconfigs |
| `target: es5` | `target: es2025` minimum | TypeScript 7.0 | Hard error; modern Node.js 22 doesn't need downlevel |
| `generator prisma-client-js` | `generator prisma-client` | Prisma 7.0 | Old value throws error |
| Prisma auto-generates to `node_modules` | Explicit `output` path required | Prisma 7.0 | Must set `output = "./generated/prisma"` |
| Prisma middleware API | Client extensions API | Prisma 5+ (deprecated in 7) | `$use()` removed; use `$extends()` |
| Auto-run `prisma generate` | Manual `prisma generate` step | Prisma 7.0 | CI pipelines must add explicit generate step |
| Turbo `pipeline` key | `tasks` key | Turborepo 2.0 | `pipeline` key no longer valid in turbo.json |
| Probot for GitHub Apps | `@octokit/app` directly | Ongoing | Probot couples to Express; direct usage is framework-agnostic |

**Deprecated/outdated:**
- `prisma-client-js` generator: throws in Prisma 7; replace with `prisma-client`
- `pipeline` key in turbo.json: renamed to `tasks` in Turborepo 2
- `baseUrl` in tsconfig: removed in TypeScript 7; use `paths` only
- PgBouncer statement mode with RLS: incompatible; always use transaction mode

---

## Open Questions

1. **GitHub App Manifest vs manual registration for Phase 1**
   - What we know: Manifest flow automates app creation and returns private key + webhook secret + app ID in one flow; requires a redirect URL to complete OAuth-style exchange
   - What's unclear: Whether Railway's ephemeral preview URLs can be used as redirect for initial setup, or if a stable domain is needed at registration time
   - Recommendation: Register manually for Phase 1 (set all fields explicitly, known values); manifest flow is better for "install for others" onboarding which is Phase 2+

2. **PgBouncer mode configuration on Railway**
   - What we know: Railway provides managed PostgreSQL but PgBouncer is a separate service or Supabase/Neon feature; TEN-05 requires PgBouncer before Phase 2
   - What's unclear: Whether Railway's managed Postgres includes built-in connection pooling or PgBouncer must be deployed as a separate service
   - Recommendation: Verify Railway Postgres add-on pooling options; if unavailable, use `pg` connection pool settings in Phase 1, add PgBouncer sidecar before Phase 2 concurrency increases

3. **TypeScript 7 ESM and Prisma 7 `"type": "module"` in packages**
   - What we know: Prisma 7 requires ESM (`"type": "module"`); TypeScript 7 + `nodenext` supports both CJS and ESM
   - What's unclear: Whether all packages in the monorepo must be ESM or only the `db` package
   - Recommendation: Set `"type": "module"` in `packages/db/package.json` and `apps/api/package.json`. Use `"moduleResolution": "nodenext"` in all tsconfigs. Use `.js` extensions in all relative imports.

---

## Sources

### Primary (HIGH confidence)
- Official: `@octokit/app` README (github.com/octokit/app.js) — App constructor, getInstallationOctokit, octokit property
- Official: `@octokit/auth-app` README (github.com/octokit/auth-app.js) — token caching behavior, 15K LRU, 59-min invalidation, createAppAuth
- Official: `@octokit/webhooks` README (github.com/octokit/webhooks.js) — verifyAndReceive signature, verify(), string payload requirement
- Official: Prisma v7 upgrade guide (prisma.io/docs/guides/upgrade-prisma-orm/v7) — prisma.config.ts, adapter-pg, generator changes, ESM
- Official: Prisma RLS extension (github.com/prisma/prisma-client-extensions/row-level-security) — SQL policies, set_config usage
- Official: BullMQ FlowProducer (docs.bullmq.io/guide/flows) — add() API, children fan-out, queue independence
- Official: BullMQ BaseJobOptions (api.docs.bullmq.io) — attempts, backoff, removeOnComplete, removeOnFail, jobId
- Official: fastify-raw-body README — registration order, rawBody field, global:false optimization, Fastify 5 support
- Official: Turborepo configuration (turborepo.dev/docs/reference/configuration) — tasks key (not pipeline), dependsOn, outputs, persistent
- Official: GitHub webhook installation payload (docs.github.com) — action values including suspend/unsuspend
- Official: GitHub App manifest (docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) — manifest JSON structure, permissions format
- Official: Railway config as code (docs.railway.com/reference/config-as-code) — railway.toml structure, watchPatterns, buildCommand

### Secondary (MEDIUM confidence)
- TypeScript 7 progress blog (devblogs.microsoft.com/typescript) — nodenext, es2025, baseUrl removal, strict default
- WebSearch: PgBouncer transaction mode + SET LOCAL requirement — multiple sources agree on the pattern; critical for RLS correctness
- WebSearch: BullMQ worker concurrency patterns — 2026 articles; consistent with official docs

### Tertiary (LOW confidence)
- WebSearch: Railway + Turborepo monorepo community patterns — anecdotal from community Q&A; verify railway.toml paths against official config-as-code docs

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — versions pinned in requirements; official npm metadata verified
- GitHub App patterns: HIGH — official octokit docs
- Fastify HMAC pattern: HIGH — official fastify-raw-body README
- BullMQ architecture: HIGH — official BullMQ docs
- Prisma 7 setup: HIGH — official upgrade guide
- RLS + PgBouncer: HIGH — multiple authoritative sources agree; SET LOCAL requirement is well-documented
- Railway config: MEDIUM — official config-as-code docs; monorepo patterns from community
- TypeScript 7 restrictions: HIGH — official TypeScript blog post

**Research date:** 2026-07-13
**Valid until:** 2026-08-13 (stable ecosystem; Prisma/Turborepo/Octokit move slowly)
