---
phase: 01-github-app-foundation
plan: 04
type: execute
wave: 3
depends_on: ["01-02", "01-03"]
files_modified:
  - apps/api/src/index.ts
  - apps/api/src/plugins/raw-body.ts
  - apps/api/src/plugins/redis.ts
  - apps/api/src/routes/webhooks.ts
  - apps/api/src/routes/health.ts
  - apps/api/.env.example
autonomous: true

must_haves:
  truths:
    - "POST /webhooks returns 202 Accepted within milliseconds — no synchronous processing"
    - "POST /webhooks returns 401 if X-Hub-Signature-256 is missing or invalid"
    - "GET /health returns 200 with JSON status object"
    - "fastify-raw-body is registered BEFORE any routes so rawBody is available in preHandler"
    - "Duplicate deliveries (same X-GitHub-Delivery) are rejected using Redis SET NX EX 259200"
    - "Redis dedup key follows namespace installation:{installationId}:delivery:{deliveryId} (TEN-03)"
    - "Accepted webhook is enqueued on webhook-ingestion queue with jobId = deliveryId (BullMQ dedup)"
    - "Webhook payload is NOT stored in the job — only deliveryId, installationId, eventName, action"
  artifacts:
    - path: "apps/api/src/index.ts"
      provides: "Fastify server bootstrap — registers plugins then routes"
    - path: "apps/api/src/plugins/raw-body.ts"
      provides: "fastify-raw-body plugin registration"
    - path: "apps/api/src/plugins/redis.ts"
      provides: "ioredis plugin — decorates fastify instance with redis client"
    - path: "apps/api/src/routes/webhooks.ts"
      provides: "POST /webhooks handler with HMAC, dedup, and enqueue"
    - path: "apps/api/src/routes/health.ts"
      provides: "GET /health handler"
  key_links:
    - from: "apps/api/src/routes/webhooks.ts"
      to: "apps/api/src/plugins/raw-body.ts"
      via: "request.rawBody used for HMAC verification"
      pattern: "rawBody"
    - from: "apps/api/src/routes/webhooks.ts"
      to: "@ciintel/queue"
      via: "webhookIngestionQueue.add() with jobId"
      pattern: "webhookIngestionQueue"
    - from: "apps/api/src/routes/webhooks.ts"
      to: "@ciintel/github"
      via: "getApp().webhooks.verify() for HMAC"
      pattern: "webhooks.verify"
---

<objective>
Implement the apps/api Fastify webhook receiver: HMAC-SHA256 verification of raw body, 202 immediate response, Redis dedup using SET NX, and enqueue onto the webhook-ingestion BullMQ queue.

Purpose: This is the public entry point of the entire system. GitHub sends all webhook deliveries here. The receiver must be fast (202 before any processing), secure (HMAC verification), and idempotent (Redis dedup + BullMQ jobId dedup). Correctness here prevents ghost jobs and replay attacks.

Output: A running Fastify server at PORT env var that accepts POST /webhooks, verifies HMAC, deduplicates on deliveryId, enqueues an identifier-only job, and returns 202 immediately.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/tsouza/Projects/ciintel/.planning/PROJECT.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-RESEARCH.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-03-SUMMARY.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fastify plugins — raw-body and Redis decorator</name>
  <files>
    apps/api/src/plugins/raw-body.ts
    apps/api/src/plugins/redis.ts
  </files>
  <action>
Create two Fastify plugins. raw-body MUST be registered before any routes — if registered after, rawBody will be undefined on requests that arrived before registration.

**apps/api/src/plugins/raw-body.ts:**

```typescript
import type { FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";

export async function rawBodyPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRawBody, {
    field: "rawBody",        // adds request.rawBody
    global: false,           // opt-in per route via config.rawBody: true
    encoding: "utf8",
    runFirst: true,          // run before content-type parser
  });
}
```

**apps/api/src/plugins/redis.ts:**

```typescript
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

async function redisPlugin(app: FastifyInstance): Promise<void> {
  const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redis.on("error", (err) => {
    app.log.error({ err }, "Redis connection error");
  });

  app.decorate("redis", redis);

  app.addHook("onClose", async () => {
    await redis.quit();
  });
}

export const redisDecorator = fp(redisPlugin, {
  name: "redis",
  fastify: "5.x",
});
```

Note: fastify-plugin is needed as a dependency. Add it to apps/api/package.json dependencies:
`"fastify-plugin": "^5.0.0"`
  </action>
  <verify>
1. `cat apps/api/src/plugins/raw-body.ts | grep "runFirst: true"` — found
2. `cat apps/api/src/plugins/raw-body.ts | grep "global: false"` — found (opt-in per route)
3. `cat apps/api/src/plugins/redis.ts | grep "maxRetriesPerRequest: null"` — found
4. `cat apps/api/src/plugins/redis.ts | grep "fp("` — fastify-plugin wrapping found
  </verify>
  <done>rawBodyPlugin registers fastify-raw-body with global:false (opt-in per route) and runFirst:true. redisDecorator adds redis to FastifyInstance type and handles cleanup in onClose.</done>
</task>

<task type="auto">
  <name>Task 2: Webhook route with HMAC verification, Redis dedup, queue enqueue; health route; server bootstrap</name>
  <files>
    apps/api/src/routes/webhooks.ts
    apps/api/src/routes/health.ts
    apps/api/src/index.ts
    apps/api/.env.example
  </files>
  <action>
Implement the webhook handler and wire up the Fastify server.

**apps/api/src/routes/health.ts:**

```typescript
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "api",
    });
  });
}
```

**apps/api/src/routes/webhooks.ts:**

CRITICAL implementation requirements:
1. Route config must include `{ config: { rawBody: true } }` to enable fastify-raw-body for this route
2. HMAC verification uses `request.rawBody` (the raw string), NOT `request.body` (parsed JSON)
3. Signature is in `X-Hub-Signature-256` header, format: `sha256=<hex>`
4. Return 202 BEFORE any async processing (enqueue is fire-and-forget from caller's perspective)
5. Extract installationId from body BEFORE the Redis dedup step — the dedup key requires it
6. Redis dedup key follows TEN-03 namespace: `installation:{installationId}:delivery:{deliveryId}` with `SET ... 1 NX EX 259200` — 259200 = 3 days in seconds
7. BullMQ jobId = deliveryId provides second dedup layer (BullMQ ignores jobs with duplicate jobId)
8. Job payload contains identifiers ONLY — no payload body, no token

```typescript
import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookIngestionQueue } from "@ciintel/queue";
import type { WebhookIngestionJob } from "@ciintel/queue";

function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string
): boolean {
  const expectedSig = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  // Constant-time comparison prevents timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expectedSig)
    );
  } catch {
    return false;
  }
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (!webhookSecret) {
    throw new Error("GITHUB_WEBHOOK_SECRET environment variable is required");
  }

  app.post(
    "/webhooks",
    {
      config: { rawBody: true },  // enables fastify-raw-body for this route
    },
    async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const deliveryId = request.headers["x-github-delivery"] as string | undefined;
      const eventName = request.headers["x-github-event"] as string | undefined;

      if (!signature || !deliveryId || !eventName) {
        return reply.status(400).send({ error: "Missing required GitHub webhook headers" });
      }

      if (!request.rawBody) {
        return reply.status(400).send({ error: "Raw body not available" });
      }

      // HMAC verification using raw body string
      const isValid = verifyWebhookSignature(webhookSecret, request.rawBody, signature);
      if (!isValid) {
        app.log.warn({ deliveryId }, "Webhook signature verification failed");
        return reply.status(401).send({ error: "Invalid signature" });
      }

      // Extract installationId from parsed body BEFORE dedup — required for TEN-03 key namespace
      // Safe to use request.body here because HMAC already verified the payload
      const installation = (request.body as any).installation as { id?: number } | undefined;
      const installationId = installation?.id;

      if (!installationId || typeof installationId !== "number") {
        app.log.warn({ deliveryId, eventName }, "Webhook delivery has no installation — skipping");
        return reply.status(202).send({ status: "no_installation" });
      }

      // Redis dedup: SET NX EX 259200 (3 days)
      // Key namespace: installation:{installationId}:delivery:{deliveryId} (TEN-03 compliance)
      const dedupKey = `installation:${installationId}:delivery:${deliveryId}`;
      const isNew = await app.redis.set(dedupKey, "1", "NX", "EX", 259200);
      if (!isNew) {
        app.log.info({ deliveryId }, "Duplicate webhook delivery — skipping");
        return reply.status(202).send({ status: "duplicate" });
      }

      const body = request.body as Record<string, unknown>;
      const action = typeof body["action"] === "string" ? body["action"] : undefined;

      // Enqueue identifier-only job — jobId = deliveryId for BullMQ-level dedup
      const jobData: WebhookIngestionJob = {
        installationId,
        deliveryId,
        eventName,
        action,
      };

      await webhookIngestionQueue.add("webhook", jobData, {
        jobId: deliveryId,  // BullMQ dedup: ignores job if jobId already exists in queue
      });

      app.log.info({ deliveryId, installationId, eventName }, "Webhook enqueued");

      return reply.status(202).send({ status: "accepted" });
    }
  );
}
```

**apps/api/src/index.ts** — server bootstrap:

Plugin registration order is CRITICAL:
1. rawBodyPlugin (must be first — before any content-type parsers run)
2. redisDecorator
3. Routes (health, webhooks)

```typescript
import Fastify from "fastify";
import { rawBodyPlugin } from "./plugins/raw-body.js";
import { redisDecorator } from "./plugins/redis.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { healthRoutes } from "./routes/health.js";

const app = Fastify({
  logger: {
    level: process.env["LOG_LEVEL"] ?? "info",
  },
});

// CRITICAL: raw-body MUST be registered before any routes
await app.register(rawBodyPlugin);
await app.register(redisDecorator);

// Routes
await app.register(healthRoutes);
await app.register(webhookRoutes);

const port = parseInt(process.env["PORT"] ?? "3000", 10);
const host = process.env["HOST"] ?? "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info(`API server listening on ${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

**apps/api/.env.example:**

```bash
# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=

# Redis
REDIS_URL=redis://localhost:6379

# Server
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/ciintel
```
  </action>
  <verify>
1. `cat apps/api/src/index.ts | grep "rawBodyPlugin"` — appears before webhookRoutes registration
2. `cat apps/api/src/routes/webhooks.ts | grep "rawBody: true"` — config option present
3. `cat apps/api/src/routes/webhooks.ts | grep "request.rawBody"` — used for HMAC, not request.body
4. `cat apps/api/src/routes/webhooks.ts | grep "202"` — 202 status returned
5. `cat apps/api/src/routes/webhooks.ts | grep "259200"` — Redis TTL present
6. `cat apps/api/src/routes/webhooks.ts | grep "jobId: deliveryId"` — BullMQ dedup jobId
7. `cat apps/api/src/routes/webhooks.ts | grep "installation:"` — dedup key uses TEN-03 namespace
8. `pnpm --filter @ciintel/api exec tsc --noEmit` — exits 0 (or only missing @ciintel/db generated type errors)
  </verify>
  <done>Fastify server bootstraps with raw-body plugin registered first. POST /webhooks verifies HMAC, extracts installationId before dedup, deduplicates using namespaced key installation:{installationId}:delivery:{deliveryId} in Redis, enqueues identifier-only job with jobId dedup, returns 202. GET /health returns 200.</done>
</task>

</tasks>

<verification>
1. Plugin registration order in index.ts: rawBodyPlugin → redisDecorator → routes
2. HMAC uses `request.rawBody` string (not parsed body) — critical for correctness
3. `timingSafeEqual` used for constant-time comparison
4. installationId extracted BEFORE Redis dedup step
5. Redis dedup key uses namespace `installation:{installationId}:delivery:{deliveryId}` with NX EX 259200
6. BullMQ enqueue uses `jobId: deliveryId`
7. Job payload has no body content, no tokens — only identifiers
8. fastify-plugin wraps redis decorator so it's not scoped to a child context
</verification>

<success_criteria>
- POST /webhooks returns 202 for valid signed requests
- POST /webhooks returns 401 for invalid/missing signature
- Duplicate delivery IDs return 202 with status: duplicate (not 4xx)
- Job enqueued contains: installationId, deliveryId, eventName, action — nothing else
- rawBodyPlugin registered before any routes in index.ts
- GET /health returns 200 with JSON
- Redis dedup key follows TEN-03 namespace: installation:{installationId}:delivery:{deliveryId}
- TypeScript compiles cleanly
</success_criteria>

<output>
After completion, create `/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-04-SUMMARY.md` with:
- frontmatter: phase, plan, subsystem: api, affects: [apps/api], tech-stack.added: [fastify@5, fastify-raw-body@5, fastify-plugin@5]
- What was built (webhook receiver, HMAC verification, Redis dedup, queue enqueue)
- Key decisions: rawBodyPlugin registration order, timingSafeEqual for HMAC, jobId=deliveryId for BullMQ dedup, TEN-03 namespaced dedup key
</output>
