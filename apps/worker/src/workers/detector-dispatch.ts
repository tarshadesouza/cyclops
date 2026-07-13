import { Worker } from "bullmq";
import {
  getRedis,
  aiAnalysisQueue,
  dlqQueue,
  DetectorDispatchJobSchema,
  type DetectorDispatchJob,
} from "@ciintel/queue";
import { getTenantClient } from "@ciintel/db";
import { getInstallationClient } from "@ciintel/github";
import { runAllDetectors } from "@ciintel/detectors";
import type { DetectorResult } from "@ciintel/detectors";
import { checkInstallationActive } from "../lib/installation.js";
import {
  getRepoInfo,
  fetchFailedJobs,
  fetchWorkflowFile,
  fetchJobLogExcerpt,
  fetchCheckRunHistory,
} from "../lib/github-actions.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export function createDetectorDispatchWorker(): Worker<DetectorDispatchJob> {
  const worker = new Worker<DetectorDispatchJob>(
    "detector-dispatch",
    async (job) => {
      const jobLog = logger.child({ jobId: job.id });

      // 1. Validate job payload
      const parsed = DetectorDispatchJobSchema.safeParse(job.data);
      if (!parsed.success) {
        jobLog.error({ errors: parsed.error.errors }, "Invalid detector-dispatch job data — discarding");
        return { skipped: true, reason: "invalid_data" };
      }

      const {
        installationId,
        repositoryId,
        checkRunId,
        workflowRunId: rawWorkflowRunId,
        ref,
        sha,
      } = parsed.data;

      // workflowRunId is optional in schema — fall back to checkRunId
      const workflowRunId = rawWorkflowRunId ?? checkRunId;

      // 2. TEN-04: Check installation is active before any processing
      const check = await checkInstallationActive(installationId, jobLog as pino.Logger);
      if (!check.active) {
        return { skipped: true, reason: check.reason };
      }

      jobLog.info({ installationId, repositoryId, workflowRunId }, "Starting detector dispatch");

      // 3. Get Octokit client + repo info
      const octokit = await getInstallationClient(installationId);
      const { owner, repo } = await getRepoInfo(octokit, repositoryId);

      // 4. Fetch failed jobs for this run
      const failedJobs = await fetchFailedJobs(octokit, owner, repo, workflowRunId);

      jobLog.info({ failedJobCount: failedJobs.length, owner, repo, workflowRunId }, "Fetched failed jobs");

      // 5. Fetch workflow YAML (shared across all failed jobs)
      const workflowYaml = await fetchWorkflowFile(octokit, owner, repo, workflowRunId, sha);

      // 6. Aggregate matched results across ALL failed jobs
      const allResults: DetectorResult[] = [];
      let firstJobLogExcerpt = "";

      for (const failedJob of failedJobs) {
        const logExcerpt = await fetchJobLogExcerpt(octokit, owner, repo, failedJob.id);
        if (!firstJobLogExcerpt) firstJobLogExcerpt = logExcerpt;

        const history = await fetchCheckRunHistory(
          octokit,
          owner,
          repo,
          workflowRunId,
          failedJob.name,
          ref
        );

        const results = runAllDetectors({
          logExcerpt,
          workflowYaml,
          jobName: failedJob.name,
          checkRunHistory: history,
        });

        allResults.push(...results.filter((r) => r.matched));
      }

      // 7. Pick primary result — Unknown fallback ensures no failure is ever dropped
      const primary: DetectorResult =
        allResults[0] ?? {
          detectorType: "Unknown" as const,
          matched: true,
          violations: [],
          rawExcerpt: firstJobLogExcerpt,
        };

      jobLog.info(
        { detectorType: primary.detectorType, matchedCount: allResults.length },
        "Detector classification complete"
      );

      // 8. Store Finding (tenant-scoped via RLS)
      const db = getTenantClient(installationId);
      const finding = await db.finding.create({
        data: {
          installationId,
          repositoryId,
          workflowRunId,
          checkRunId,
          detectorType: primary.detectorType,
          sha,
          ref,
          violations: primary.violations as object[],
          rawExcerpt: primary.rawExcerpt ?? "",
        },
      });

      jobLog.info({ findingId: finding.id, detectorType: primary.detectorType }, "Finding created");

      // 9. Dispatch ai-analysis with IDENTIFIERS ONLY — no log content, no secrets in Redis
      await aiAnalysisQueue.add("analyze", {
        installationId,
        repositoryId,
        checkRunId,
        findingId: finding.id,
        detectorType: primary.detectorType,
        sha,
      });

      jobLog.info({ findingId: finding.id }, "ai-analysis job dispatched");

      return {
        processed: true,
        findingId: finding.id,
        detectorType: primary.detectorType,
      };
    },
    {
      connection: getRedis(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "DetectorDispatchWorker job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "DetectorDispatchWorker error");
  });

  // DLQ routing: route exhausted-retry jobs to DLQ for observability
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await dlqQueue.add("exhausted", {
        originalQueue: "detector-dispatch",
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
