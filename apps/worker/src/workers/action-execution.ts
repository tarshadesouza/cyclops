import { Worker } from "bullmq";
import {
  getRedis,
  dlqQueue,
  ActionExecutionJobSchema,
  type ActionExecutionJob,
  type ActionType,
} from "@ciintel/queue";
import { getTenantClient, type Finding } from "@ciintel/db";
import { getInstallationClient } from "@ciintel/github";
import { fetchConfig, type CyclopsConfig } from "@ciintel/config";
import { checkInstallationActive } from "../lib/installation.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

// Derive Octokit type from the factory — avoids adding @octokit/core as a direct dep
type Octokit = Awaited<ReturnType<typeof getInstallationClient>>;

export interface ActionContext {
  installationId: number;
  repositoryId: number;
  checkRunId: number;
  sha: string;
  ref: string | undefined;
  actionType: ActionType;
  octokit: Octokit;
  finding: Finding;
  config: CyclopsConfig;
  owner: string;
  repo: string;
}

type HandlerResult = { skipped: true; reason?: string } | { ok: true };

// ---------------------------------------------------------------------------
// Kill-switch enforcement (ACT-14, CFG-01)
// Returns true when the action is DISABLED (should skip).
// ---------------------------------------------------------------------------
export function isActionKillSwitched(
  actionType: ActionType,
  config: CyclopsConfig,
  detectorType: string
): boolean {
  // Per-detector gate
  const detectorKey = detectorType.toLowerCase() as keyof typeof config.detectors;
  if (detectorKey in config.detectors && !config.detectors[detectorKey]) {
    return true;
  }

  // Per-action-type gate
  switch (actionType) {
    case "upsert-pr-comment":
      return !config.prComments;
    case "update-check-run":
      return !config.checkRuns;
    case "create-autofix-pr-lint":
    case "create-autofix-pr-snapshot":
      return !config.autofix;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Handler map — all 8 action types registered; stubs until 03-04..03-07
// ---------------------------------------------------------------------------
const HANDLERS: Record<ActionType, (ctx: ActionContext) => Promise<HandlerResult>> = {
  "upsert-pr-comment":        async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
  "update-check-run":         async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
  "create-autofix-pr-lint":   async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
  "create-autofix-pr-snapshot": async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
  "rerun-workflow":            async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
  "cancel-workflow":           async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
  "send-slack-alert":          async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
  "create-github-issue":       async (_ctx) => ({ skipped: true, reason: "not-yet-implemented" }),
};

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------
export function createActionExecutionWorker(): Worker<ActionExecutionJob> {
  const worker = new Worker<ActionExecutionJob>(
    "action-execution",
    async (job) => {
      const jobLog = logger.child({ jobId: job.id });

      // 1. Validate job payload
      const parsed = ActionExecutionJobSchema.safeParse(job.data);
      if (!parsed.success) {
        jobLog.error(
          { errors: parsed.error.errors },
          "Invalid action-execution job data — discarding"
        );
        return { skipped: true, reason: "invalid_data" };
      }

      const {
        installationId,
        repositoryId,
        checkRunId,
        findingId,
        actionType,
        sha,
        ref,
      } = parsed.data;

      // 2. TEN-04: Installation active gate
      const check = await checkInstallationActive(installationId, jobLog as pino.Logger);
      if (!check.active) {
        return { skipped: true, reason: check.reason };
      }

      jobLog.info({ installationId, findingId, actionType }, "Starting action execution");

      // 3. Get installation Octokit client
      const octokit = await getInstallationClient(installationId);

      // 4. Tenant-scoped DB client
      const db = getTenantClient(installationId);

      // 5. Load Finding from DB
      const finding = await db.finding.findUniqueOrThrow({ where: { id: findingId } });

      // 6. Resolve owner/repo from GitHub API using repositoryId
      const repoResp = await (octokit as any).request("GET /repositories/{repository_id}", {
        repository_id: repositoryId,
      });
      const owner: string = repoResp.data.owner.login;
      const repo: string = repoResp.data.name;

      // 7. Load config (kill switch source) — requires owner/repo/ref
      const config = await fetchConfig(octokit as any, owner, repo, ref ?? "HEAD", repositoryId);

      // 8. Enforce kill switches (ACT-14, CFG-01)
      if (isActionKillSwitched(actionType, config, finding.detectorType)) {
        jobLog.info(
          { actionType, detectorType: finding.detectorType },
          "Action kill-switched by config — skipping"
        );
        return { skipped: true, reason: "kill_switched" };
      }

      // 9. Unknown action type guard (defensive — TypeScript enum handles this at compile-time,
      //    but belt-and-suspenders for runtime robustness)
      const handler = HANDLERS[actionType];
      if (!handler) {
        jobLog.warn({ actionType }, "Unknown action type — skipping without crash");
        return { skipped: true, reason: "unknown_action_type" };
      }

      // 10. Build ActionContext and dispatch to handler
      const ctx: ActionContext = {
        installationId,
        repositoryId,
        checkRunId,
        sha,
        ref,
        actionType,
        octokit,
        finding,
        config,
        owner,
        repo,
      };

      const result = await handler(ctx);

      jobLog.info(
        { findingId, actionType, result },
        "Action execution complete"
      );

      return result;
    },
    {
      connection: getRedis(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "ActionExecutionWorker job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "ActionExecutionWorker error");
  });

  // DLQ routing: route exhausted-retry jobs to DLQ for observability
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await dlqQueue.add(
        "exhausted",
        {
          originalQueue: "action-execution",
          jobId: job.id,
          jobName: job.name,
          jobData: job.data,
          error: err.message,
          failedAt: new Date().toISOString(),
        },
        { removeOnComplete: false }
      );
    }
  });

  return worker;
}
