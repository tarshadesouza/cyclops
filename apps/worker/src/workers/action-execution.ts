import { Worker } from "bullmq";
import {
  getRedis,
  dlqQueue,
  ActionExecutionJobSchema,
  type ActionExecutionJob,
  type ActionType,
} from "@cyclops/queue";
import { getTenantClient, type Finding, type FixSession } from "@cyclops/db";
import { getInstallationClient } from "@cyclops/github";
import { fetchConfig, type CyclopsConfig } from "@cyclops/config";
import { checkInstallationActive } from "../lib/installation.js";
import { handleUpsertPrComment, handleUpdateCheckRun } from "../lib/github-outputs.js";
import { handleAutofixLint, handleAutofixSnapshot } from "../lib/github-autofix.js";
import {
  findActiveSessionByBranch,
  findActiveSessionByFinding,
  startFixSession,
} from "../lib/fix-loop.js";
import {
  handleRerunWorkflow,
  handleCancelWorkflow,
  handleSlackAlert,
  handleCreateGithubIssue,
} from "../lib/github-secondary.js";
import pino from "pino";

// Derive tenant DB client type
type TenantDb = ReturnType<typeof getTenantClient>;

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
  db: TenantDb;
  log: pino.Logger;
  finding: Finding;
  config: CyclopsConfig;
  owner: string;
  repo: string;
  // manual = triggered by the "Implement fix" check-run button. Autofix handlers
  // use this to bypass dedup/rate-limit and honor autofixMode for branch target.
  manual: boolean;
  // loopSession = the active fix-loop session this action belongs to (Phase 6
  // step 2). When set, autofix handlers commit an iteration onto the session
  // branch instead of a one-shot fix.
  loopSession: FixSession | null;
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
      return !config.autofixEnabled;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// ACT-11: Action deduplication is enforced in each handler:
// - upsert-pr-comment: PrComment table (installationId+repositoryId+prNumber unique)
// - update-check-run: Finding.cyclopsCheckRunId (reuses existing run)
// - create-autofix-pr-*: AutofixPr table (installationId+repositoryId+detectorType+sha unique)
// - rerun/cancel/slack: ActionDedup table (24h TTL window)
// - create-github-issue: TrackedIssue table only (repeat failures add a comment, not a skip)
// ---------------------------------------------------------------------------
// Handler map — all 8 action types registered
// ---------------------------------------------------------------------------
const HANDLERS: Record<ActionType, (ctx: ActionContext) => Promise<HandlerResult>> = {
  "upsert-pr-comment":        handleUpsertPrComment,
  "update-check-run":         handleUpdateCheckRun,
  "create-autofix-pr-lint":     handleAutofixLint,
  "create-autofix-pr-snapshot": handleAutofixSnapshot,
  "rerun-workflow":            handleRerunWorkflow,
  "cancel-workflow":           handleCancelWorkflow,
  "send-slack-alert":          handleSlackAlert,
  "create-github-issue":       handleCreateGithubIssue,
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
        manual,
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
      const config = await fetchConfig(octokit as any, owner, repo, ref || "HEAD", repositoryId);

      // 7b. Fix-loop session resolution (Phase 6 step 2). For autofix actions:
      //   - a manual button press starts (or reuses) a loop session;
      //   - a later pipeline run on a session branch is picked up as the next
      //     loop iteration via branch match (finding.ref == session.branchName).
      // Either case is treated as manual → bypasses the kill switch below.
      let loopSession: FixSession | null = null;
      const isAutofixAction =
        actionType === "create-autofix-pr-lint" ||
        actionType === "create-autofix-pr-snapshot";
      if (isAutofixAction) {
        loopSession = await findActiveSessionByBranch(
          db,
          installationId,
          repositoryId,
          finding.ref
        );
        if (!loopSession && manual) {
          loopSession =
            (await findActiveSessionByFinding(db, installationId, finding.id)) ??
            (await startFixSession(db, {
              installationId,
              repositoryId,
              finding,
              mode: config.autofixMode,
            }));
        }
      }
      const isManual = manual || loopSession !== null;

      // 8. Enforce kill switches (ACT-14, CFG-01). A MANUAL action (the user
      //    pressed "Implement fix") or a loop iteration bypasses the kill switch
      //    — the button is explicit consent, and it must work even when autofix
      //    is OFF.
      if (!isManual && isActionKillSwitched(actionType, config, finding.detectorType)) {
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
        db,
        log: jobLog as pino.Logger,
        finding,
        config,
        owner,
        repo,
        manual: isManual,
        loopSession,
      };

      const result = await handler(ctx);

      jobLog.info(
        { findingId, actionType, result },
        "Action execution complete"
      );

      // Probabilistic cleanup of expired ActionDedup rows (1% of jobs)
      // Prevents unbounded table growth without requiring a separate cron
      if (Math.random() < 0.01) {
        const deleted = await db.actionDedup.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        if (deleted.count > 0) {
          jobLog.info({ deleted: deleted.count }, 'Cleaned up expired ActionDedup rows');
        }
      }

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
