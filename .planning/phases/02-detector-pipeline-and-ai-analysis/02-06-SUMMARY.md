---
phase: "02"
plan: "06"
name: ai-analysis-worker
subsystem: worker-pipeline
tags: [bullmq, ai, anthropic, token-budget, byok, enrichment, routing]

dependency-graph:
  requires: ["02-01", "02-03", "02-04", "02-05"]
  provides: ["AiAnalysisWorker", "token-budget-gate", "finding-enrichment", "high-confidence-routing"]
  affects: ["02-07", "03-*"]

tech-stack:
  added: ["@ciintel/ai (workspace)"]
  patterns:
    - "Budget gate before AI call — hard-stop prevents runaway spend"
    - "Per-job BYOK key decrypt — apiKey never stored in Redis payload or logs"
    - "TokenUsage row per successful AI call — enables monthly cap enforcement"
    - "Confidence routing threshold 0.85 — only high-confidence findings advance to action-execution"
    - "Rethrow on AI failure — BullMQ owns retry/DLQ; no half-enriched findings"
    - "DLQ routing on exhausted retries — mirrors detector-dispatch pattern"

key-files:
  created:
    - apps/worker/src/workers/ai-analysis.ts
  modified:
    - apps/worker/src/index.ts
    - apps/worker/package.json
    - apps/worker/tsconfig.json

decisions:
  - "[02-06]: ai-analysis worker concurrency=5 — AI calls are latency-bound; lower concurrency avoids rate-limit storms"
  - "[02-06]: Rethrow on analyzeFailure error — BullMQ handles retry/DLQ; rethrowing prevents partial Finding state"
  - "[02-06]: TokenUsage.inputTokens mapped from result.usage.promptTokens — matches ai@7 field rename already handled in analyze.ts"
  - "[02-06]: actionType='phase3-placeholder' in ActionExecutionJob — schema accepts z.string(); Phase 3 will define real action types"

metrics:
  duration: "2m 42s"
  completed: "2026-07-13"
  tasks-completed: 2
  tasks-total: 2
  deviations: 0
---

# Phase 2 Plan 06: AI Analysis Worker Summary

**One-liner:** AiAnalysisWorker with monthly token budget gate, per-job BYOK decrypt, Claude Sonnet 5 enrichment, TokenUsage recording, and confidence>=0.85 routing to action-execution queue.

## What Was Built

`createAiAnalysisWorker` — a BullMQ Worker at concurrency 5 that is the enrichment + gating stage of the Phase 2 pipeline:

1. **Budget gate** — `checkTokenBudget(db, installationId)` runs before any AI call; sets `budgetExceeded=true` on the Finding and returns early when the monthly cap is hit.
2. **BYOK key decrypt** — `decryptApiKey(inst.encryptedApiKey)` from `@ciintel/core`; the raw key is never assigned to any logged object (pino redact config provides belt-and-suspenders coverage).
3. **AI call** — `analyzeFailure({ logExcerpt, detectorType, apiKey })` via `@ciintel/ai`; any error is rethrown so BullMQ owns retry/DLQ and no half-enriched Finding is left behind.
4. **TokenUsage recording** — `db.tokenUsage.create` on every successful call, tagged with `installationId`, `detectorType` (as `detectorId`), `model: "claude-sonnet-5"`, `inputTokens`, `outputTokens`.
5. **Empty-evidence guard** — if `result.output.evidence.length === 0` (rare given FindingSchema `.min(1)`) the Finding is not enriched and the job returns skipped.
6. **Finding enrichment** — writes `confidence`, `evidence`, `caveat`, `rootCause`, `suggestedFix`, `affectedFiles`, `severity`, `aiEnrichedAt`.
7. **Confidence routing** — `confidence >= 0.85 && evidence.length > 0` dispatches an `action-execution` job with `actionType: "phase3-placeholder"`; sets `advancedToAction=true`; medium/low findings are stored only.

Registered in `apps/worker/src/index.ts` alongside the three existing workers, listed in the startup log as `"ai-analysis (concurrency=5)"`, and closed in `shutdown()`.

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Hash    | Message                                                              |
|---------|----------------------------------------------------------------------|
| ca64545 | feat(02-06): AiAnalysisWorker with budget gate, BYOK decrypt, TokenUsage, and confidence routing |
| 14eda0c | feat(02-06): register AiAnalysisWorker in worker entrypoint          |

## Success Criteria Verification

- [x] Every enriched Finding has confidence, evidence[] (non-empty), caveat — enforced by FindingSchema `.min(1)` + empty-evidence guard
- [x] Medium/low confidence findings never dispatch action jobs — `confidence >= 0.85` threshold explicit at line-level
- [x] TokenUsage tagged with installationId/detectorId/model per AI call; monthly cap hard-stops — `checkTokenBudget` gates before call
- [x] BYOK key decrypted per job, never stored in Redis/payload/logs — `decryptApiKey` called inline, never assigned to logged object

## Next Phase Readiness

Phase 2 is now at plans 1–6 complete. Plan 02-07 (integration verification) is the final plan in the phase. No blockers for 02-07.

The Phase 2 pipeline is end-to-end:
`webhook → webhook-ingestion → detector-dispatch → [detector classification + Finding create] → ai-analysis → [budget gate + AI call + TokenUsage + enrich] → action-execution (high confidence only)`
