import { Worker } from "bullmq";
import {
  getRedis,
  webhookIngestionQueue,
  detectorDispatchQueue,
  actionExecutionQueue,
  agentFixQueue,
  dlqQueue,
  WebhookIngestionJobSchema,
  DetectorDispatchJobSchema,
  type WebhookIngestionJob,
} from "@cyclops/queue";
import { getDb, getTenantClient, type FixSession } from "@cyclops/db";
import { getInstallationClient } from "@cyclops/github";
import { fetchConfig } from "@cyclops/config";
import { checkInstallationActive } from "../lib/installation.js";
import {
  IMPLEMENT_FIX_ACTION_ID,
  AGENT_FIX_SAFE_ACTION_ID,
  AGENT_FIX_ALLIN_ACTION_ID,
  AGENT_SUGGEST_ACTION_ID,
  autofixActionTypeFor,
} from "../lib/github-autofix.js";
import {
  findActiveSessionByBranch,
  findActiveSessionByFinding,
  finalizeFixSession,
  startAgentSession,
  startSuggestSession,
  findSuggestSession,
} from "../lib/fix-loop.js";
import { applySuggestedFix } from "../lib/agent-loop.js";
import { FIX_CHECKBOX_RE, APPLY_CHECKBOX_RE } from "../lib/github-outputs.js";
import pino from "pino";
import type { Job } from "bullmq";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

type InstallationAccount = {
  id: number;
  login: string;
  type: string;
  appId: number;
  targetType: string;
};

async function handleInstallationCreated(
  installationId: number,
  account?: InstallationAccount
): Promise<void> {
  const db = getDb();
  await db.installation.upsert({
    where: { id: installationId },
    create: {
      id: installationId,
      accountLogin: account?.login ?? "unknown",
      accountType: account?.type ?? "Organization",
      appId: account?.appId ?? parseInt(process.env["GITHUB_APP_ID"] ?? "0", 10),
      // targetId must equal the marketplace account id so billing events resolve.
      targetId: account?.id ?? installationId,
      targetType: account?.targetType ?? "Organization",
      suspended: false,
    },
    update: {
      suspended: false,
      deletedAt: null,
      ...(account
        ? {
            accountLogin: account.login,
            accountType: account.type,
            targetId: account.id,
            targetType: account.targetType,
          }
        : {}),
    },
  });
  logger.info({ installationId }, "Installation created/upserted");
}

async function handleInstallationDeleted(installationId: number): Promise<void> {
  const db = getDb();

  await db.installation.update({
    where: { id: installationId },
    data: { deletedAt: new Date() },
  });

  // Drain waiting and delayed jobs for this tenant from all queues
  const tenantJobFilter = async (job: Job): Promise<boolean> => {
    const data = job.data as { installationId?: number };
    return data.installationId === installationId;
  };

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

// startAgentFix — shared by the check-run button and the PR-comment checkbox.
// Dedupes on an already-running session for the finding, resolves the iteration
// cap from config, creates the FixSession, and enqueues the long-running
// agent-fix job. Returns true when a session was started.
async function startAgentFix(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any,
  installationId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finding: any,
  permission: "safe" | "all-in",
  jobLog: pino.Logger
): Promise<boolean> {
  const existing = await findActiveSessionByFinding(db, installationId, finding.id);
  if (existing) {
    jobLog.info({ findingId: finding.id }, "agent fix: session already running — skipping");
    return false;
  }
  const repoResp = await octokit.request("GET /repositories/{repository_id}", {
    repository_id: finding.repositoryId,
  });
  const owner: string = repoResp.data.owner.login;
  const repo: string = repoResp.data.name;
  const config = await fetchConfig(octokit, owner, repo, finding.ref ?? "HEAD", finding.repositoryId);
  const session = await startAgentSession(db, {
    installationId,
    repositoryId: finding.repositoryId,
    finding,
    permission,
    maxIterations: config.autofix.agent.maxIterations,
  });
  await agentFixQueue.add("run", {
    sessionId: session.id,
    installationId,
    repositoryId: finding.repositoryId,
  });
  jobLog.info(
    { sessionId: session.id, findingId: finding.id, mode: session.mode },
    "agent fix session started"
  );
  return true;
}

// startSuggest — the "suggest" level: run the agent once and propose a diff.
async function startSuggest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  installationId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finding: any,
  jobLog: pino.Logger
): Promise<boolean> {
  const existing = await findActiveSessionByFinding(db, installationId, finding.id);
  if (existing) {
    jobLog.info({ findingId: finding.id }, "suggest: session already running — skipping");
    return false;
  }
  const session = await startSuggestSession(db, {
    installationId,
    repositoryId: finding.repositoryId,
    finding,
  });
  await agentFixQueue.add("run", {
    sessionId: session.id,
    installationId,
    repositoryId: finding.repositoryId,
  });
  jobLog.info({ sessionId: session.id, findingId: finding.id }, "suggest session started");
  return true;
}

// handleFixCheckbox — a repo writer ticked the "Let Cyclops fix this" checkbox
// in our PR comment (issue_comment `edited`). Diff the old vs new comment body
// for a checkbox that went [ ]→[x], map it back to its finding + level via the
// hidden marker, and start the agent loop — same path as the check-run button,
// but triggerable right in the PR conversation. Editing a bot comment requires
// write access, so the box is inherently permission-gated.
async function handleFixCheckbox(
  installationId: number,
  deliveryId: string,
  jobLog: pino.Logger
): Promise<void> {
  const delivery = await getDb().webhookDelivery.findUnique({ where: { deliveryId } });
  if (!delivery) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = delivery.payload as any;

  if (payload.comment?.user?.login !== "cyclops-app[bot]") {
    return; // only our own comment carries the trigger
  }
  const newBody: string = payload.comment?.body ?? "";
  const oldBody: string = payload.changes?.body?.from ?? "";

  // Which boxes went [ ]→[x] between the old and new body. `re` must have /g.
  const newlyChecked = (re: RegExp): Array<[string, string]> => {
    const parse = (body: string) => {
      const m = new Map<string, { checked: boolean; extra: string }>();
      for (const x of body.matchAll(re)) {
        m.set(x[2], { checked: x[1].toLowerCase() === "x", extra: x[3] ?? "" });
      }
      return m;
    };
    const now = parse(newBody);
    const before = parse(oldBody);
    return [...now.entries()]
      .filter(([id, v]) => v.checked && !before.get(id)?.checked)
      .map(([id, v]) => [id, v.extra] as [string, string]);
  };

  const fixTicks = newlyChecked(FIX_CHECKBOX_RE); // [findingId, level]
  const applyTicks = newlyChecked(APPLY_CHECKBOX_RE); // [sessionId, ""]
  if (fixTicks.length === 0 && applyTicks.length === 0) return;

  const db = getTenantClient(installationId);
  const octokit = await getInstallationClient(installationId);

  // Fix checkboxes → start a session (suggest = one pass, safe/all-in = loop).
  for (const [findingId, level] of fixTicks) {
    const finding = await db.finding.findUnique({ where: { id: findingId } });
    if (!finding) {
      jobLog.warn({ findingId }, "fix checkbox: finding not found — skipping");
      continue;
    }
    if (level === "suggest") {
      await startSuggest(db, installationId, finding, jobLog);
    } else {
      await startAgentFix(db, octokit, installationId, finding, level as "safe" | "all-in", jobLog);
    }
  }

  // Apply checkboxes → promote the proposed fix once (no loop).
  for (const [sessionId] of applyTicks) {
    const session = await findSuggestSession(db, installationId, sessionId);
    if (!session) {
      jobLog.warn({ sessionId }, "apply checkbox: no awaiting_apply session — skipping");
      continue;
    }
    const repoResp = await (octokit as any).request("GET /repositories/{repository_id}", {
      repository_id: session.repositoryId,
    });
    await applySuggestedFix(
      {
        octokit,
        db,
        owner: repoResp.data.owner.login,
        repo: repoResp.data.name,
        installationId,
        repositoryId: session.repositoryId,
        log: jobLog,
      },
      session
    );
  }
}

// requested_action → find the analyzed finding behind the pressed check run and
// enqueue a manual autofix action. No-ops (with a log) on any mismatch rather
// than throwing, so a stray button press never poisons the queue.
async function handleRequestedAction(
  installationId: number,
  deliveryId: string,
  jobLog: pino.Logger
): Promise<void> {
  const delivery = await getDb().webhookDelivery.findUnique({
    where: { deliveryId },
  });
  if (!delivery) {
    jobLog.warn({ deliveryId }, "requested_action: delivery payload not found — skipping");
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = delivery.payload as any;

  const identifier: string | undefined = payload.requested_action?.identifier;
  const isAgentSafe = identifier === AGENT_FIX_SAFE_ACTION_ID;
  const isAgentAllIn = identifier === AGENT_FIX_ALLIN_ACTION_ID;
  const isAgentSuggest = identifier === AGENT_SUGGEST_ACTION_ID;
  const isSuggest = identifier === IMPLEMENT_FIX_ACTION_ID; // legacy one-shot
  if (!isAgentSafe && !isAgentAllIn && !isAgentSuggest && !isSuggest) {
    jobLog.info({ identifier }, "requested_action: unrecognized identifier — skipping");
    return;
  }

  const checkRunId = payload.check_run?.id;
  if (typeof checkRunId !== "number") {
    jobLog.warn("requested_action: no check_run.id in payload — skipping");
    return;
  }

  // Locate the finding this check run belongs to (tenant-scoped).
  const db = getTenantClient(installationId);
  const finding = await db.finding.findFirst({
    where: { installationId, cyclopsCheckRunId: BigInt(checkRunId) },
    orderBy: { createdAt: "desc" },
  });
  if (!finding) {
    jobLog.warn({ checkRunId }, "requested_action: no finding for check run — skipping");
    return;
  }

  // Phase 7 agent loop: "Agent fix (safe|all-in)". Start one long-running fix
  // session and hand it to the agent-fix worker, which owns the whole
  // dispatch → poll → promote → re-dispatch loop. The pressed button (not
  // config) decides the permission; config supplies the iteration cap.
  if (isAgentSafe || isAgentAllIn) {
    const octokit = await getInstallationClient(installationId);
    await startAgentFix(
      db,
      octokit,
      installationId,
      finding,
      isAgentAllIn ? "all-in" : "safe",
      jobLog
    );
    return;
  }

  // Suggest level: agent runs once and proposes a diff (Apply lands it).
  if (isAgentSuggest) {
    await startSuggest(db, installationId, finding, jobLog);
    return;
  }

  // Suggest mode (legacy one-shot suggestedFix path).
  const actionType = autofixActionTypeFor(finding.detectorType);
  if (!actionType) {
    jobLog.info(
      { detectorType: finding.detectorType },
      "requested_action: detector has no autofix action — skipping"
    );
    return;
  }

  await actionExecutionQueue.add("execute", {
    installationId,
    repositoryId: finding.repositoryId,
    checkRunId: Number(finding.checkRunId),
    findingId: finding.id,
    actionType,
    sha: finding.sha,
    ref: finding.ref,
    manual: true,
  });

  jobLog.info(
    { findingId: finding.id, actionType, checkRunId },
    "requested_action: manual autofix action enqueued"
  );
}

// handleLoopWorkflowRun — a completed workflow_run landed on a branch an active
// fix-loop session is watching. Green → finalize succeeded. Red → re-dispatch
// the NEW failure through the normal pipeline for another fix (the eventual
// autofix action re-attaches by branch match), unless the iteration cap is hit.
// Returns true if the event was consumed by the loop (skip normal dispatch).
async function handleLoopWorkflowRun(
  installationId: number,
  repositoryId: number,
  session: FixSession,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  jobLog: pino.Logger
): Promise<void> {
  const conclusion: string | undefined = payload.workflow_run?.conclusion;
  const headSha: string | undefined = payload.workflow_run?.head_sha;
  const owner: string = payload.repository?.owner?.login;
  const repo: string = payload.repository?.name;

  // React only to the run for the commit WE pushed. A run for a different sha
  // (e.g. the developer pushing to the same branch mid-loop) is left alone.
  if (session.lastSha && headSha && session.lastSha !== headSha) {
    jobLog.info(
      { sessionId: session.id, headSha, lastSha: session.lastSha },
      "Fix loop: run for a different sha — ignoring"
    );
    return;
  }

  const octokit = await getInstallationClient(installationId);
  const target = { octokit, db: getTenantClient(installationId), owner, repo };

  if (conclusion === "success") {
    jobLog.info({ sessionId: session.id }, "Fix loop: CI green — finalizing succeeded");
    await finalizeFixSession(target, session, "succeeded");
    return;
  }

  if (conclusion === "failure") {
    if (session.iteration >= session.maxIterations) {
      jobLog.warn(
        { sessionId: session.id, iteration: session.iteration },
        "Fix loop: max iterations reached — finalizing"
      );
      await finalizeFixSession(target, session, "failed_max_iterations");
      return;
    }

    // Re-fix: feed the fresh failure back through the normal pipeline.
    const dispatchData = {
      installationId,
      repositoryId,
      checkRunId: payload.workflow_run.id,
      workflowRunId: payload.workflow_run.id,
      ref: payload.workflow_run.head_branch,
      sha: headSha,
    };
    const validation = DetectorDispatchJobSchema.safeParse(dispatchData);
    if (!validation.success) {
      jobLog.warn(
        { sessionId: session.id, errors: validation.error.errors },
        "Fix loop: invalid re-dispatch payload — finalizing error"
      );
      await finalizeFixSession(target, session, "error");
      return;
    }
    await detectorDispatchQueue.add("detect", validation.data);
    jobLog.info(
      { sessionId: session.id, iteration: session.iteration },
      "Fix loop: CI red — re-dispatched for another fix attempt"
    );
    return;
  }

  // cancelled / timed_out / neutral / etc. — leave the session running.
  jobLog.info(
    { sessionId: session.id, conclusion },
    "Fix loop: non-terminal run conclusion — waiting"
  );
}

export function createWebhookIngestionWorker(): Worker<WebhookIngestionJob> {
  const worker = new Worker<WebhookIngestionJob>(
    "webhook-ingestion",
    async (job) => {
      const jobLog = logger.child({ jobId: job.id, deliveryId: job.data.deliveryId });

      const parsed = WebhookIngestionJobSchema.safeParse(job.data);
      if (!parsed.success) {
        jobLog.error({ errors: parsed.error.errors }, "Invalid job data — discarding");
        return { skipped: true, reason: "invalid_data" };
      }

      const { installationId, deliveryId, eventName, action, account } = parsed.data;

      // Installation lifecycle events MANAGE the tenant row, so they must run
      // BEFORE the active-check gate — otherwise installation.created is dropped
      // as "not_found" (the row it would create doesn't exist yet) and the tenant
      // is never provisioned.
      if (eventName === "installation") {
        jobLog.info({ installationId, action }, "Processing installation lifecycle event");
        switch (action) {
          case "created":
            await handleInstallationCreated(installationId, account);
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

      // TEN-04: all other events require an active installation
      const check = await checkInstallationActive(installationId, jobLog as pino.Logger);
      if (!check.active) {
        return { skipped: true, reason: check.reason };
      }

      jobLog.info({ installationId, eventName, action }, "Processing webhook delivery");

      // "Implement fix" button pressed → enqueue a MANUAL autofix action for the
      // finding behind this check run. Skips detection + AI (the finding already
      // exists and was analyzed) and dispatches straight to action-execution.
      if (eventName === "check_run" && action === "requested_action") {
        await handleRequestedAction(installationId, deliveryId, jobLog as pino.Logger);
        return { processed: true, eventName, action };
      }

      // PR-comment checkbox ticked (issue_comment `edited`) — the in-conversation
      // trigger for the agent fix loop.
      if (eventName === "issue_comment" && action === "edited") {
        await handleFixCheckbox(installationId, deliveryId, jobLog as pino.Logger);
        return { processed: true, eventName, action };
      }

      if (eventName === "installation_repositories") {
        jobLog.info({ action, installationId }, "Repository access changed — tracking in Phase 2");
        return { processed: true, eventName, action };
      }

      // CI events — dispatch to detector-dispatch queue on failure
      if (
        (eventName === "workflow_run" || eventName === "check_run") &&
        action === "completed"
      ) {
        // Load the stored payload from DB
        const delivery = await getDb().webhookDelivery.findUnique({
          where: { deliveryId },
        });

        if (!delivery) {
          jobLog.warn({ deliveryId }, "Webhook delivery not found in DB — skipping CI dispatch");
          return { processed: true, eventName, action };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload = delivery.payload as any;

        // Fix-loop watcher (Phase 6 step 2): if this workflow_run is on a branch
        // an active session is driving, the loop owns the event — finalize on
        // green or re-dispatch on red, and do NOT fall through to normal dispatch.
        if (eventName === "workflow_run") {
          const headBranch: string | undefined = payload.workflow_run?.head_branch;
          if (headBranch) {
            const session = await findActiveSessionByBranch(
              getTenantClient(installationId),
              installationId,
              payload.repository.id,
              headBranch
            );
            // Phase 7 agent sessions (mode "agent-*") are driven by the
            // agent-fix worker's own polling loop, NOT this webhook watcher —
            // let their branch's runs fall through to normal processing.
            if (session && !session.mode.startsWith("agent")) {
              await handleLoopWorkflowRun(
                installationId,
                payload.repository.id,
                session,
                payload,
                jobLog as pino.Logger
              );
              return { processed: true, eventName, action, loop: true };
            }
          }
        }

        let dispatchData: unknown;

        if (eventName === "workflow_run" && payload.workflow_run?.conclusion === "failure") {
          // PREFERRED: workflow_run completed with failure
          dispatchData = {
            installationId,
            repositoryId: payload.repository.id,
            checkRunId: payload.workflow_run.id,  // use run id as correlation id
            workflowRunId: payload.workflow_run.id,
            ref: payload.workflow_run.head_branch,
            sha: payload.workflow_run.head_sha,
          };
        } else if (eventName === "check_run" && payload.check_run?.conclusion === "failure") {
          // FALLBACK: check_run completed with failure
          dispatchData = {
            installationId,
            repositoryId: payload.repository.id,
            checkRunId: payload.check_run.id,
            workflowRunId: payload.check_run.check_suite?.id ?? payload.check_run.id,
            ref: payload.check_run.check_suite?.head_branch ?? "",
            sha: payload.check_run.head_sha,
          };
        }

        if (dispatchData) {
          const validation = DetectorDispatchJobSchema.safeParse(dispatchData);
          if (!validation.success) {
            jobLog.warn(
              { errors: validation.error.errors, eventName },
              "Invalid detector-dispatch payload — skipping CI dispatch"
            );
          } else {
            await detectorDispatchQueue.add("detect", validation.data);
            jobLog.info(
              { installationId, eventName, workflowRunId: validation.data.workflowRunId },
              "CI failure dispatched to detector-dispatch queue"
            );
          }
        } else {
          jobLog.info({ eventName, action, conclusion: payload.workflow_run?.conclusion ?? payload.check_run?.conclusion }, "CI event not a failure — no dispatch needed");
        }

        return { processed: true, eventName, action };
      }

      jobLog.info({ eventName, action, installationId }, "Unhandled event — skipping");

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

  // DLQ routing: route exhausted-retry jobs to DLQ for observability
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await dlqQueue.add("exhausted", {
        originalQueue: "webhook-ingestion",
        jobId: job.id,
        jobName: job.name,
        jobData: job.data,
        error: err.message,
        failedAt: new Date().toISOString(),
      }, { removeOnComplete: false });
    }
  });

  return worker;
}
