import { Worker } from "bullmq";
import {
  getRedis,
  actionExecutionQueue,
  dlqQueue,
  AiAnalysisJobSchema,
  type AiAnalysisJob,
} from "@ciintel/queue";
import { getTenantClient } from "@ciintel/db";
import { decryptApiKey } from "@ciintel/core";
import { analyzeFailure, checkTokenBudget, type AnalyzeResult } from "@ciintel/ai";
import type { DetectorType } from "@ciintel/core";
import { checkInstallationActive } from "../lib/installation.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export function createAiAnalysisWorker(): Worker<AiAnalysisJob> {
  const worker = new Worker<AiAnalysisJob>(
    "ai-analysis",
    async (job) => {
      const jobLog = logger.child({ jobId: job.id });

      // 1. Validate job payload
      const parsed = AiAnalysisJobSchema.safeParse(job.data);
      if (!parsed.success) {
        jobLog.error({ errors: parsed.error.errors }, "Invalid ai-analysis job data — discarding");
        return { skipped: true, reason: "invalid_data" };
      }

      const {
        installationId,
        repositoryId,
        checkRunId,
        findingId,
        detectorType,
        sha,
      } = parsed.data;

      // 2. TEN-04: Check installation is active before any processing
      const check = await checkInstallationActive(installationId, jobLog as pino.Logger);
      if (!check.active) {
        return { skipped: true, reason: check.reason };
      }

      jobLog.info({ installationId, findingId }, "Starting AI analysis");

      // 3. Tenant-scoped client — required so RLS + budget query resolve correctly
      const db = getTenantClient(installationId);

      // 4. Load the Finding
      const finding = await db.finding.findUniqueOrThrow({ where: { id: findingId } });

      // 5. BUDGET GATE — hard-stop before any AI call
      const budget = await checkTokenBudget(db, installationId);
      if (budget.exceeded) {
        await db.finding.update({
          where: { id: findingId },
          data: { budgetExceeded: true },
        });
        jobLog.warn(
          { used: budget.used, cap: budget.cap },
          "Monthly token budget exceeded — skipping AI"
        );
        return { skipped: true, reason: "budget_exceeded" };
      }

      // 6. LOAD KEY — decrypt per-job, never log
      const inst = await db.installation.findUniqueOrThrow({
        where: { id: installationId },
        select: { encryptedApiKey: true },
      });
      if (!inst.encryptedApiKey) {
        jobLog.warn({ installationId }, "No API key configured — skipping AI analysis");
        return { skipped: true, reason: "no_api_key" };
      }
      // NEVER log apiKey — pino redact config at root covers *.apiKey but we never assign it to a logged object
      const apiKey = decryptApiKey(inst.encryptedApiKey);

      // 7. AI CALL — rethrow on failure so BullMQ handles retry/DLQ; no half-enriched finding left
      let result: AnalyzeResult;
      try {
        result = await analyzeFailure({
          logExcerpt: finding.rawExcerpt ?? "",
          detectorType: finding.detectorType as DetectorType,
          apiKey,
        });
      } catch (err) {
        jobLog.error({ err, findingId }, "AI analysis failed — will retry via BullMQ");
        throw err; // rethrow — BullMQ handles retry/DLQ
      }

      // 8. RECORD USAGE — every successful AI call (criterion 5)
      await db.tokenUsage.create({
        data: {
          installationId,
          detectorId: finding.detectorType,
          model: "claude-sonnet-5",
          inputTokens: result.usage.promptTokens,
          outputTokens: result.usage.completionTokens,
        },
      });

      // 9. EMPTY-EVIDENCE GUARD — schema .min(1) makes this rare but guard anyway (criterion 3)
      if (result.output.evidence.length === 0) {
        jobLog.warn({ findingId }, "AI returned empty evidence — not enriching finding");
        return { skipped: true, reason: "empty_evidence" };
      }

      // 10. ENRICH — persist full AI output to Finding
      await db.finding.update({
        where: { id: findingId },
        data: {
          confidence: result.output.confidence,
          evidence: result.output.evidence,
          caveat: result.output.caveat,
          rootCause: result.output.rootCause,
          suggestedFix: result.output.suggestedFix,
          affectedFiles: result.output.affectedFiles,
          severity: result.output.severity,
          aiEnrichedAt: new Date(),
        },
      });

      // 11. ROUTE — only high confidence + non-empty evidence dispatches action (criterion 4)
      const advance = result.output.confidence >= 0.85 && result.output.evidence.length > 0;
      if (advance) {
        await db.finding.update({
          where: { id: findingId },
          data: { advancedToAction: true },
        });
        // Map detector type to action type; lint gets autofix, everything else
        // gets a check-run update to surface findings to the developer.
        const actionType =
          detectorType === "lint" ? "create-autofix-pr-lint" : "update-check-run";
        await actionExecutionQueue.add("execute", {
          installationId,
          repositoryId,
          checkRunId,
          findingId,
          actionType,
          sha,
        });
      }

      jobLog.info(
        { findingId, confidence: result.output.confidence, advanced: advance },
        "AI analysis complete"
      );
      return { processed: true, findingId, confidence: result.output.confidence, advanced: advance };
    },
    {
      connection: getRedis(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "AiAnalysisWorker job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "AiAnalysisWorker error");
  });

  // DLQ routing: route exhausted-retry jobs to DLQ for observability
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await dlqQueue.add("exhausted", {
        originalQueue: "ai-analysis",
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
