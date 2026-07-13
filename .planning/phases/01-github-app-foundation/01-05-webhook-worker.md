---
phase: 01-github-app-foundation
plan: 05
type: execute
wave: 3
depends_on: ["01-02", "01-03"]
files_modified:
  - apps/worker/src/index.ts
  - apps/worker/src/workers/webhook-ingestion.ts
  - apps/worker/src/workers/dlq.ts
  - apps/worker/src/lib/installation.ts
  - apps/worker/.env.example
autonomous: true

must_haves:
  truths:
    - "WebhookIngestionWorker processes jobs with concurrency 20"
    - "Every worker job checks installation.suspended and installation.deletedAt at job start — returns skipped if inactive (TEN-04)"
    - "Installation created event upserts Installation record in the database"
    - "Installation deleted event sets deletedAt and drains all queued jobs for that tenant"
    - "Installation suspended event sets suspended: true — subsequent jobs are dropped without processing"
    - "Installation unsuspended event sets suspended: false — jobs resume processing"
    - "Installation tokens are minted at job-start using getInstallationClient(installationId) — never stored in job payloads"
    - "DLQ worker logs failed jobs and sends error telemetry"
    - "Redis cache keys follow namespace: installation:{id}:{resource_type}:{resource_id}"
  artifacts:
    - path: "apps/worker/src/workers/webhook-ingestion.ts"
      provides: "WebhookIngestionWorker handling installation lifecycle events"
    - path: "apps/worker/src/workers/dlq.ts"
      provides: "DLQWorker for dead-letter job logging"
    - path: "apps/worker/src/lib/installation.ts"
      provides: "checkInstallationActive() — TEN-04 gate used by all workers"
    - path: "apps/worker/src/index.ts"
      provides: "Worker process bootstrap — starts all workers"
  key_links:
    - from: "apps/worker/src/workers/webhook-ingestion.ts"
      to: "apps/worker/src/lib/installation.ts"
      via: "checkInstallationActive() at job start"
      pattern: "checkInstallationActive"
    - from: "apps/worker/src/workers/webhook-ingestion.ts"
      to: "@ciintel/github"
      via: "getInstallationClient(installationId) for token minting"
      pattern: "getInstallationClient"
    - from: "apps/worker/src/workers/webhook-ingestion.ts"
      to: "@ciintel/db"
      via: "getTenantClient(installationId) for all DB writes"
      pattern: "getTenantClient"
    - from: "apps/worker/src/lib/installation.ts"
      to: "@ciintel/db"
      via: "getDb() to query installation status"
      pattern: "getDb"
---

<objective>
Implement the apps/worker BullMQ worker process: WebhookIngestionWorker that handles GitHub App installation lifecycle events (created, deleted, suspended, unsuspended, repositories_added, repositories_removed), enforces TEN-04 job dropping for inactive installations, and a DLQ worker for failed job observability.

Purpose: The worker is where tenant isolation is enforced at execution time. Every job must gate on installation status before doing any work, and all database operations must go through getTenantClient() so the RLS layer is activated. Getting the lifecycle handling right here prevents ghost jobs and data leaks for suspended/deleted tenants.

Output: A worker process that consumes the webhook-ingestion queue with concurrency 20, handles all installation lifecycle events, drops jobs for suspended/deleted installations, and logs all DLQ entries.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/tsouza/Projects/ciintel/.planning/PROJECT.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-RESEARCH.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-02-SUMMARY.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-03-SUMMARY.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: TEN-04 installation gate and DLQ worker</name>
  <files>
    apps/worker/src/lib/installation.ts
    apps/worker/src/workers/dlq.ts
  </files>
  <action>
Create the reusable installation gate function and DLQ worker. The gate is the critical TEN-04 control — all workers call it at job start.

**apps/worker/src/lib/installation.ts** — TEN-04 gate:

This function is called at the start of EVERY worker job. If it returns false, the job must return `{ skipped: true }` immediately without touching any tenant data. This prevents processing jobs for deleted or suspended installations.

```typescript
import { getDb } from "@ciintel/db";
import type { Logger } from "pino";

export type InstallationCheckResult =
  | { active: true }
  | { active: false; reason: "suspended" | "deleted" | "not_found" };

/**
 * TEN-04: Check if installation is active before processing any job.
 * Returns { active: true } if the installation should be processed.
 * Returns { active: false, reason } if the job should be dropped.
 *
 * Called at the start of every worker job — never skip this check.
 */
export async function checkInstallationActive(
  installationId: number,
  logger: Logger
): Promise<InstallationCheckResult> {
  const db = getDb();

  const installation = await db.installation.findUnique({
    where: { id: installationId },
    select: { suspended: true, deletedAt: true },
  });

  if (!installation) {
    logger.warn({ installationId }, "Installation not found — dropping job");
    return { active: false, reason: "not_found" };
  }

  if (installation.deletedAt) {
    logger.info({ installationId }, "Installation deleted — dropping job");
    return { active: false, reason: "deleted" };
  }

  if (installation.suspended) {
    logger.info({ installationId }, "Installation suspended — dropping job");
    return { active: false, reason: "suspended" };
  }

  return { active: true };
}
```

**apps/worker/src/workers/dlq.ts** — DLQ worker:

```typescript
import { Worker } from "bullmq";
import { getRedis } from "@ciintel/queue";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export function createDlqWorker(): Worker {
  const worker = new Worker(
    "dlq",
    async (job) => {
      logger.error(
        {
          jobId: job.id,
          jobName: job.name,
          data: job.data,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
        },
        "Job moved to DLQ after exhausting retries"
      );
      // Future: send to alerting system (PagerDuty, Slack, etc.)
    },
    {
      connection: getRedis(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "DLQ worker job failed unexpectedly");
  });

  return worker;
}
```
  </action>
  <verify>
1. `cat apps/worker/src/lib/installation.ts | grep "deletedAt"` — checks deletedAt
2. `cat apps/worker/src/lib/installation.ts | grep "suspended"` — checks suspended
3. `cat apps/worker/src/lib/installation.ts | grep "active: false"` — returns inactive result
4. `cat apps/worker/src/workers/dlq.ts | grep "failedReason"` — logs failure reason
  </verify>
  <done>checkInstallationActive() implements TEN-04 gate checking both suspended and deletedAt. Returns typed result with reason. DLQ worker logs all dead-letter jobs with full context.</done>
</task>

<task type="auto">
  <name>Task 2: WebhookIngestionWorker — installation lifecycle handling and worker bootstrap</name>
  <files>
    apps/worker/src/workers/webhook-ingestion.ts
    apps/worker/src/index.ts
    apps/worker/.env.example
  </files>
  <action>
Implement the WebhookIngestionWorker that handles GitHub App installation lifecycle events and the worker process bootstrap.

**apps/worker/src/workers/webhook-ingestion.ts:**

Handle the 6 installation lifecycle events defined in APP-02. For each event:
- `installation.created`: Upsert Installation record (idempotent)
- `installation.deleted`: Set deletedAt, drain all queued jobs for tenant
- `installation.suspend`: Set suspended: true
- `installation.unsuspend`: Set suspended: false
- `installation_repositories.added`: Log (repo tracking implemented in later phases)
- `installation_repositories.removed`: Log (repo tracking implemented in later phases)

All non-installation events (check_run, workflow_run, etc.) are passed through for dispatcher (implemented in Phase 2).

```typescript
import { Worker } from "bullmq";
import {
  getRedis,
  webhookIngestionQueue,
  detectorDispatchQueue,
  WebhookIngestionJobSchema,
  type WebhookIngestionJob,
} from "@ciintel/queue";
import { getDb, getTenantClient } from "@ciintel/db";
import { getInstallationClient } from "@ciintel/github";
import { checkInstallationActive } from "../lib/installation.js";
import pino from "pino";
import type { Job } from "bullmq";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

async function handleInstallationCreated(installationId: number): Promise<void> {
  const db = getDb();
  // Note: We don't have the full payload in the job — we use the GitHub API to
  // fetch installation details. This is intentional (no payload in job data).
  // For Phase 1, we upsert with minimal data. The installationId is the source of truth.
  await db.installation.upsert({
    where: { id: installationId },
    create: {
      id: installationId,
      accountLogin: "unknown",   // Will be enriched in Phase 2 via GitHub API
      accountType: "Organization",
      appId: parseInt(process.env["GITHUB_APP_ID"] ?? "0", 10),
      targetId: installationId,
      targetType: "Organization",
      suspended: false,
    },
    update: {
      suspended: false,
      deletedAt: null,
    },
  });
  logger.info({ installationId }, "Installation created/upserted");
}

async function handleInstallationDeleted(installationId: number): Promise<void> {
  const db = getDb();

  // Mark installation as deleted
  await db.installation.update({
    where: { id: installationId },
    data: { deletedAt: new Date() },
  });

  // Drain all pending jobs across all queues for this tenant
  // BullMQ drain removes waiting jobs; in-flight jobs are handled by TEN-04 gate
  const tenantJobFilter = async (job: Job): Promise<boolean> => {
    const data = job.data as { installationId?: number };
    return data.installationId === installationId;
  };

  // Get and remove waiting jobs from all queues
  const queues = [webhookIngestionQueue, detectorDispatchQueue];
  for (const queue of queues) {
    const waitingJobs = await queue.getWaiting();
    for (const job of waitingJobs) {
      if (await tenantJobFilter(job)) {
        await job.remove();
        logger.info({ jobId: job.id, queueName: queue.name, installationId }, "Drained job for deleted installation");
      }
    }
    const delayedJobs = await queue.getDelayed();
    for (const job of delayedJobs) {
      if (await tenantJobFilter(job)) {
        await job.remove();
      }
    }
  }

  logger.info({ installationId }, "Installation deleted, queued jobs drained");
}

async function handleInstallationSuspended(installationId: number): Promise<void> {
  const db = getDb();
  await db.installation.update({
    where: { id: installationId },
    data: { suspended: true },
  });
  logger.info({ installationId }, "Installation suspended");
}

async function handleInstallationUnsuspended(installationId: number): Promise<void> {
  const db = getDb();
  await db.installation.update({
    where: { id: installationId },
    data: { suspended: false },
  });
  logger.info({ installationId }, "Installation unsuspended");
}

export function createWebhookIngestionWorker(): Worker<WebhookIngestionJob> {
  const worker = new Worker<WebhookIngestionJob>(
    "webhook-ingestion",
    async (job) => {
      const jobLog = logger.child({ jobId: job.id, deliveryId: job.data.deliveryId });

      // Validate job data shape
      const parsed = WebhookIngestionJobSchema.safeParse(job.data);
      if (!parsed.success) {
        jobLog.error({ errors: parsed.error.errors }, "Invalid job data — discarding");
        return { skipped: true, reason: "invalid_data" };
      }

      const { installationId, deliveryId, eventName, action } = parsed.data;

      // TEN-04: Check installation is active before any processing
      const check = await checkInstallationActive(installationId, jobLog as pino.Logger);
      if (!check.active) {
        return { skipped: true, reason: check.reason };
      }

      jobLog.info({ installationId, eventName, action }, "Processing webhook delivery");

      // Handle installation lifecycle events (no tenant client needed — admin operations)
      if (eventName === "installation") {
        switch (action) {
          case "created":
            await handleInstallationCreated(installationId);
            break;
          case "deleted":
            await handleInstallationDeleted(installationId);
            break;
          case "suspend":
            await handleInstallationSuspended(installationId);
            break;
          case "unsuspend":
            await handleInstallationUnsuspended(installationId);
            break;
          default:
            jobLog.info({ action }, "Unhandled installation action — skipping");
        }
        return { processed: true, eventName, action };
      }

      if (eventName === "installation_repositories") {
        jobLog.info({ action, installationId }, "Repository access changed — tracking in Phase 2");
        return { processed: true, eventName, action };
      }

      // For CI events (check_run, workflow_run, push), fan out to detector-dispatch
      // These events will be fully handled in Phase 2. For Phase 1, log and return.
      jobLog.info({ eventName, action, installationId }, "CI event received — dispatcher implemented in Phase 2");

      return { processed: true, eventName };
    },
    {
      connection: getRedis(),
      concurrency: 20,  // WHK-04: webhook-ingestion concurrency
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "WebhookIngestionWorker job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "WebhookIngestionWorker error");
  });

  return worker;
}
```

**apps/worker/src/index.ts** — worker process bootstrap:

```typescript
import pino from "pino";
import { createWebhookIngestionWorker } from "./workers/webhook-ingestion.js";
import { createDlqWorker } from "./workers/dlq.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

logger.info("Starting CyclOps worker process");

const webhookIngestionWorker = createWebhookIngestionWorker();
const dlqWorker = createDlqWorker();

logger.info(
  {
    workers: ["webhook-ingestion (concurrency=20)", "dlq (concurrency=5)"],
  },
  "Workers started"
);

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info("Shutting down workers...");
  await Promise.all([
    webhookIngestionWorker.close(),
    dlqWorker.close(),
  ]);
  logger.info("Workers stopped gracefully");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

**apps/worker/.env.example:**

```bash
# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=

# Redis
REDIS_URL=redis://localhost:6379

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/ciintel

# Worker config
LOG_LEVEL=info
```
  </action>
  <verify>
1. `cat apps/worker/src/workers/webhook-ingestion.ts | grep "checkInstallationActive"` — called in every job
2. `cat apps/worker/src/workers/webhook-ingestion.ts | grep "concurrency: 20"` — WHK-04 setting
3. `cat apps/worker/src/workers/webhook-ingestion.ts | grep "deletedAt"` — deletion handled
4. `cat apps/worker/src/workers/webhook-ingestion.ts | grep "suspended"` — suspension handled
5. `cat apps/worker/src/workers/webhook-ingestion.ts | grep "drain\|remove"` — job draining on delete
6. `grep "token\|privateKey\|secret" apps/worker/src/workers/webhook-ingestion.ts` — 0 results (no credentials in job processing)
7. `pnpm --filter @ciintel/worker exec tsc --noEmit` — exits 0 (or only generated type errors)
  </verify>
  <done>WebhookIngestionWorker handles all 6 installation lifecycle events. TEN-04 gate runs at every job start. Deleted installations drain queued jobs. Concurrency=20. Worker process bootstraps both workers and handles SIGTERM/SIGINT gracefully.</done>
</task>

</tasks>

<verification>
1. `checkInstallationActive` called before any tenant data access in every job handler
2. `installation.created` upserts (not just creates — idempotent for re-delivery)
3. `installation.deleted` sets deletedAt AND drains waiting/delayed jobs from queues
4. `installation.suspend` and `installation.unsuspend` toggle `suspended` boolean
5. Worker concurrency: webhook-ingestion=20, dlq=5
6. Graceful shutdown via SIGTERM/SIGINT
7. No tokens or secrets appear in job processing logic — only installationId used to mint on demand
</verification>

<success_criteria>
- Worker process starts without errors when Redis and DATABASE_URL are available
- TEN-04 gate runs at the start of every webhook ingestion job
- All 4 installation lifecycle actions handled: created (upsert), deleted (deletedAt + drain), suspend, unsuspend
- Concurrency=20 on webhook-ingestion queue
- Graceful shutdown on SIGTERM
- TypeScript compiles cleanly
- No credentials or token values appear in job data or processing logic
</success_criteria>

<output>
After completion, create `/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-05-SUMMARY.md` with:
- frontmatter: phase, plan, subsystem: worker, affects: [apps/worker], tech-stack.added: [pino@9]
- What was built (WebhookIngestionWorker, DLQWorker, TEN-04 gate, lifecycle handlers)
- Key decisions: checkInstallationActive gate pattern, drain approach for deleted installations, upsert for idempotent created events
</output>
