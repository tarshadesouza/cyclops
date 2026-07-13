---
phase: 01-github-app-foundation
plan: 03
type: execute
wave: 2
depends_on: ["01-01"]
files_modified:
  - packages/queue/src/redis.ts
  - packages/queue/src/queues.ts
  - packages/queue/src/jobs.ts
  - packages/queue/src/flow.ts
  - packages/queue/src/index.ts
  - packages/github/src/app.ts
  - packages/github/src/clients.ts
  - packages/github/src/index.ts
autonomous: true

must_haves:
  truths:
    - "Four BullMQ queues are defined: webhook-ingestion, detector-dispatch, ai-analysis, action-execution"
    - "Each queue has correct concurrency settings: webhook-ingestion=20, detector-dispatch=10, ai-analysis=5, action-execution=10"
    - "getAppClient() returns an App-level Octokit instance (JWT auth)"
    - "getInstallationClient(installationId) returns an installation-scoped Octokit that auto-refreshes tokens"
    - "ioredis connection has maxRetriesPerRequest: null — BullMQ hard requirement"
    - "Job payloads are typed and contain identifiers only — no log content, no tokens, no secrets"
    - "Redis connection created once (singleton) and shared across all queue instances"
  artifacts:
    - path: "packages/queue/src/redis.ts"
      provides: "getRedis() ioredis singleton with maxRetriesPerRequest: null"
    - path: "packages/queue/src/queues.ts"
      provides: "4 named Queue instances + DLQ"
    - path: "packages/queue/src/jobs.ts"
      provides: "Zod-validated job payload types for all 4 queues"
    - path: "packages/queue/src/flow.ts"
      provides: "FlowProducer for fan-out from webhook-ingestion to downstream queues"
    - path: "packages/github/src/app.ts"
      provides: "getApp() singleton returning @octokit/app App instance"
    - path: "packages/github/src/clients.ts"
      provides: "getAppClient() and getInstallationClient(installationId)"
  key_links:
    - from: "packages/queue/src/queues.ts"
      to: "packages/queue/src/redis.ts"
      via: "getRedis() shared connection"
      pattern: "getRedis"
    - from: "packages/github/src/clients.ts"
      to: "packages/github/src/app.ts"
      via: "getApp() singleton"
      pattern: "getApp"
    - from: "packages/github/src/clients.ts"
      to: "@octokit/app"
      via: "app.getInstallationOctokit(installationId)"
      pattern: "getInstallationOctokit"
---

<objective>
Implement two packages in parallel: @ciintel/queue (BullMQ queue definitions, typed job payloads, FlowProducer) and @ciintel/github (Octokit App singleton, getAppClient and getInstallationClient factory functions).

Purpose: The API webhook receiver (Plan 04) needs queue definitions to enqueue jobs. The worker (Plan 05) needs both queue consumers and GitHub clients to process jobs. Both apps import from these packages, so they must be correct and well-typed before Plan 04 and 05 execute.

Output: @ciintel/queue exports 4 typed queues and a FlowProducer. @ciintel/github exports getAppClient() and getInstallationClient(installationId). Both compile cleanly.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/tsouza/Projects/ciintel/.planning/PROJECT.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-RESEARCH.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-01-SUMMARY.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: @ciintel/queue — Redis singleton, 4 queues, typed job payloads, FlowProducer</name>
  <files>
    packages/queue/src/redis.ts
    packages/queue/src/queues.ts
    packages/queue/src/jobs.ts
    packages/queue/src/flow.ts
    packages/queue/src/index.ts
  </files>
  <action>
Implement the complete @ciintel/queue package. All imports between files in this package use .js extensions.

**packages/queue/src/redis.ts** — ioredis singleton:

CRITICAL: `maxRetriesPerRequest: null` is REQUIRED for BullMQ. Omitting it causes BullMQ workers to throw "maxRetriesPerRequest must be null" on startup.

```typescript
import { Redis } from "ioredis";

let redisInstance: Redis | undefined;

export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,  // REQUIRED for BullMQ
      enableReadyCheck: false,
    });
  }
  return redisInstance;
}
```

**packages/queue/src/jobs.ts** — typed job payloads using Zod:

Job payloads contain identifiers ONLY. No log content, no tokens, no file content, no installation secrets. Workers mint tokens at job-start using installationId.

```typescript
import { z } from "zod";

// Webhook ingestion: raw delivery metadata, no payload content in queue
export const WebhookIngestionJobSchema = z.object({
  installationId: z.number().int().positive(),
  deliveryId: z.string().uuid(),
  eventName: z.string(),
  action: z.string().optional(),
});
export type WebhookIngestionJob = z.infer<typeof WebhookIngestionJobSchema>;

// Detector dispatch: point at a specific check run to analyze
export const DetectorDispatchJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  checkRunId: z.number().int().positive(),
  workflowRunId: z.number().int().positive().optional(),
  ref: z.string(),
  sha: z.string().length(40),
});
export type DetectorDispatchJob = z.infer<typeof DetectorDispatchJobSchema>;

// AI analysis: point at a check run + detected failure type
export const AiAnalysisJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  checkRunId: z.number().int().positive(),
  failureType: z.string(),
  sha: z.string().length(40),
});
export type AiAnalysisJob = z.infer<typeof AiAnalysisJobSchema>;

// Action execution: apply a remediation
export const ActionExecutionJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  checkRunId: z.number().int().positive(),
  actionType: z.string(),
  actionParams: z.record(z.unknown()),
  sha: z.string().length(40),
});
export type ActionExecutionJob = z.infer<typeof ActionExecutionJobSchema>;
```

**packages/queue/src/queues.ts** — 4 named queues + DLQ:

```typescript
import { Queue } from "bullmq";
import { getRedis } from "./redis.js";
import type {
  WebhookIngestionJob,
  DetectorDispatchJob,
  AiAnalysisJob,
  ActionExecutionJob,
} from "./jobs.js";

const defaultJobOptions = {
  removeOnComplete: { count: 1000, age: 86400 },  // keep 1k completed jobs for 24h
  removeOnFail: { count: 5000, age: 604800 },      // keep 5k failed jobs for 7d
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
};

// Concurrency is set on the Worker, not the Queue. These are Queue definitions.
export const webhookIngestionQueue = new Queue<WebhookIngestionJob>(
  "webhook-ingestion",
  { connection: getRedis(), defaultJobOptions }
);

export const detectorDispatchQueue = new Queue<DetectorDispatchJob>(
  "detector-dispatch",
  { connection: getRedis(), defaultJobOptions }
);

export const aiAnalysisQueue = new Queue<AiAnalysisJob>(
  "ai-analysis",
  { connection: getRedis(), defaultJobOptions }
);

export const actionExecutionQueue = new Queue<ActionExecutionJob>(
  "action-execution",
  { connection: getRedis(), defaultJobOptions }
);

// Dead Letter Queue: receives jobs that exhausted all retries
export const dlqQueue = new Queue(
  "dlq",
  { connection: getRedis(), defaultJobOptions: { removeOnFail: false } }
);
```

**packages/queue/src/flow.ts** — FlowProducer for fan-out:

```typescript
import { FlowProducer } from "bullmq";
import { getRedis } from "./redis.js";

let flowProducerInstance: FlowProducer | undefined;

export function getFlowProducer(): FlowProducer {
  if (!flowProducerInstance) {
    flowProducerInstance = new FlowProducer({ connection: getRedis() });
  }
  return flowProducerInstance;
}
```

**packages/queue/src/index.ts** — public exports:

```typescript
export { getRedis } from "./redis.js";
export {
  webhookIngestionQueue,
  detectorDispatchQueue,
  aiAnalysisQueue,
  actionExecutionQueue,
  dlqQueue,
} from "./queues.js";
export { getFlowProducer } from "./flow.js";
export type {
  WebhookIngestionJob,
  DetectorDispatchJob,
  AiAnalysisJob,
  ActionExecutionJob,
} from "./jobs.js";
export {
  WebhookIngestionJobSchema,
  DetectorDispatchJobSchema,
  AiAnalysisJobSchema,
  ActionExecutionJobSchema,
} from "./jobs.js";
```
  </action>
  <verify>
1. `cat packages/queue/src/redis.ts | grep "maxRetriesPerRequest"` — returns `maxRetriesPerRequest: null`
2. `cat packages/queue/src/queues.ts | grep "webhook-ingestion"` — returns the queue name
3. `grep -c "Queue" packages/queue/src/queues.ts` — returns 5 (4 queues + DLQ)
4. `cat packages/queue/src/jobs.ts | grep "installationId"` — appears in all 4 schemas
5. `grep "log\|token\|secret\|content" packages/queue/src/jobs.ts` — returns 0 results (no secrets in payloads)
  </verify>
  <done>4 typed queues + DLQ + FlowProducer defined. Redis singleton has maxRetriesPerRequest: null. Job schemas contain identifiers only. All files use .js imports.</done>
</task>

<task type="auto">
  <name>Task 2: @ciintel/github — App singleton, getAppClient(), getInstallationClient()</name>
  <files>
    packages/github/src/app.ts
    packages/github/src/clients.ts
    packages/github/src/index.ts
  </files>
  <action>
Implement the @ciintel/github package. Two distinct factory functions are required per APP-05: getAppClient() for App JWT auth (for listing installations, etc.) and getInstallationClient(installationId) for installation-scoped operations (creating check runs, posting comments). Token caching for installation tokens is handled automatically by @octokit/auth-app (59-min LRU cache, 15K entries).

**packages/github/src/app.ts** — @octokit/app singleton:

```typescript
import { App } from "@octokit/app";

let appInstance: App | undefined;

export function getApp(): App {
  if (!appInstance) {
    const appId = process.env["GITHUB_APP_ID"];
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
    const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];

    if (!appId || !privateKey || !webhookSecret) {
      throw new Error(
        "Missing required environment variables: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET"
      );
    }

    // Railway stores private key with literal \n — normalize to actual newlines
    const normalizedKey = privateKey.replace(/\\n/g, "\n");

    appInstance = new App({
      appId: parseInt(appId, 10),
      privateKey: normalizedKey,
      webhooks: { secret: webhookSecret },
    });
  }
  return appInstance;
}
```

**packages/github/src/clients.ts** — two factory functions:

```typescript
import type { Octokit } from "@octokit/core";
import { getApp } from "./app.js";

/**
 * Returns an App-level Octokit authenticated with a JWT.
 * Use for: listing installations, accessing app metadata.
 * Do NOT use for installation-specific operations (creating check runs, etc).
 */
export function getAppClient(): Octokit {
  return getApp().octokit;
}

/**
 * Returns an installation-scoped Octokit authenticated with an installation token.
 * Token is automatically refreshed by @octokit/auth-app (59-min LRU cache).
 * Use for: all operations on behalf of a specific installation.
 *
 * NEVER store the returned token. NEVER pass tokens in job payloads.
 * Call this function at job-start time with the installationId from the job payload.
 */
export async function getInstallationClient(installationId: number): Promise<Octokit> {
  const app = getApp();
  return app.getInstallationOctokit(installationId);
}
```

**packages/github/src/index.ts** — public exports:

```typescript
export { getApp } from "./app.js";
export { getAppClient, getInstallationClient } from "./clients.js";
```
  </action>
  <verify>
1. `cat packages/github/src/app.ts | grep "replace"` — returns the `\\n` normalization line
2. `cat packages/github/src/clients.ts | grep "getInstallationOctokit"` — returns the call
3. `cat packages/github/src/clients.ts | grep "async"` — getInstallationClient is async
4. `grep "token\|privateKey" packages/github/src/clients.ts` — returns 0 results (no token exposure in clients.ts)
  </verify>
  <done>getApp() singleton with private key normalization for Railway env vars. getAppClient() returns JWT-auth Octokit. getInstallationClient(id) returns installation-scoped Octokit with auto-refreshing token via @octokit/auth-app.</done>
</task>

</tasks>

<verification>
1. `pnpm --filter @ciintel/queue exec tsc --noEmit` — exits 0 (or with only "generated" import errors from @ciintel/db if that dep exists)
2. `pnpm --filter @ciintel/github exec tsc --noEmit` — exits 0
3. `grep "maxRetriesPerRequest: null" packages/queue/src/redis.ts` — found
4. `grep "getInstallationOctokit" packages/github/src/clients.ts` — found
5. Queues named exactly: "webhook-ingestion", "detector-dispatch", "ai-analysis", "action-execution"
6. No token, log, or secret values appear in job schemas
</verification>

<success_criteria>
- @ciintel/queue: 4 queues + DLQ + FlowProducer + Zod-typed job payloads
- @ciintel/github: App singleton with private key normalization, two distinct client factories
- ioredis connection has maxRetriesPerRequest: null
- getInstallationClient returns a Promise (async, calls getInstallationOctokit)
- Job payloads contain only identifiers (installationId, repositoryId, checkRunId, sha, etc.)
- All relative imports use .js extensions
- Both packages export cleanly from their index.ts
</success_criteria>

<output>
After completion, create `/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-03-SUMMARY.md` with:
- frontmatter: phase, plan, subsystem: queue+github, affects: [apps/api, apps/worker], tech-stack.added: [bullmq@5, ioredis@5, @octokit/app@16, @octokit/auth-app@8, @octokit/webhooks@14, zod@3]
- What was built (queue definitions, job types, GitHub factory functions)
- Key decisions: maxRetriesPerRequest: null, private key \\n normalization, getInstallationOctokit for token lifecycle
</output>
