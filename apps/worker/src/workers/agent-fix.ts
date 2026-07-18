import { Worker } from "bullmq";
import {
  getRedis,
  dlqQueue,
  AgentFixJobSchema,
  type AgentFixJob,
} from "@cyclops/queue";
import { getTenantClient } from "@cyclops/db";
import { getInstallationClient } from "@cyclops/github";
import { fetchConfig } from "@cyclops/config";
import { checkInstallationActive } from "../lib/installation.js";
import { runAgentFixSession, runSuggestSession } from "../lib/agent-loop.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

// ---------------------------------------------------------------------------
// Agent fix worker (Phase 7 step 3). One job = one whole fix session. The heavy
// GitHub choreography (dispatch → poll sandbox → promote → poll real CI →
// re-dispatch until green/cap) lives in runAgentFixSession; this worker just
// resolves the tenant context and hands off. Concurrency is low because each
// job can run for many minutes (it waits on real CI).
// ---------------------------------------------------------------------------
export function createAgentFixWorker(): Worker<AgentFixJob> {
  const worker = new Worker<AgentFixJob>(
    "agent-fix",
    async (job) => {
      const jobLog = logger.child({ jobId: job.id });

      const parsed = AgentFixJobSchema.safeParse(job.data);
      if (!parsed.success) {
        jobLog.error({ errors: parsed.error.errors }, "Invalid agent-fix job — discarding");
        return { skipped: true, reason: "invalid_data" };
      }
      const { sessionId, installationId, repositoryId } = parsed.data;

      const check = await checkInstallationActive(installationId, jobLog as pino.Logger);
      if (!check.active) return { skipped: true, reason: check.reason };

      const db = getTenantClient(installationId);
      const session = await db.fixSession.findUnique({ where: { id: sessionId } });
      if (!session || session.status !== "running") {
        jobLog.warn({ sessionId }, "Agent-fix session missing or not running — skipping");
        return { skipped: true, reason: "session_not_running" };
      }
      const finding = await db.finding.findUnique({ where: { id: session.findingId } });
      if (!finding) {
        jobLog.warn({ sessionId }, "Agent-fix finding missing — skipping");
        return { skipped: true, reason: "finding_missing" };
      }

      const octokit = await getInstallationClient(installationId);
      const repoResp = await (octokit as any).request("GET /repositories/{repository_id}", {
        repository_id: repositoryId,
      });
      const owner: string = repoResp.data.owner.login;
      const repo: string = repoResp.data.name;
      const config = await fetchConfig(
        octokit as any,
        owner,
        repo,
        session.baseBranch,
        repositoryId
      );

      jobLog.info(
        { sessionId, mode: session.mode, branch: session.branchName },
        "Agent fix: running session"
      );

      const deps = {
        octokit,
        db,
        owner,
        repo,
        installationId,
        repositoryId,
        log: jobLog as pino.Logger,
      };
      // "suggest" runs the agent once and proposes a diff (no loop); the agent
      // modes loop until CI is green.
      const result =
        session.mode === "suggest"
          ? await runSuggestSession(deps, { session, finding, config })
          : await runAgentFixSession(deps, { session, finding, config });

      jobLog.info({ sessionId, result }, "Agent fix: session complete");
      return result;
    },
    {
      connection: getRedis(),
      // Each job is long-lived (waits on real CI). Keep the pool small; BullMQ
      // renews the job lock while the process is alive.
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "AgentFixWorker job failed");
  });
  worker.on("error", (err) => {
    logger.error({ err }, "AgentFixWorker error");
  });
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await dlqQueue.add(
        "exhausted",
        {
          originalQueue: "agent-fix",
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
