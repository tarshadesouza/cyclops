---
phase: 02-detector-pipeline-and-ai-analysis
plan: 06
type: execute
wave: 4
depends_on: ["02-01", "02-03", "02-04", "02-05"]
files_modified:
  - apps/worker/src/workers/ai-analysis.ts
  - apps/worker/src/index.ts
  - apps/worker/package.json

must_haves:
  truths:
    - "The worker loads a Finding, checks the monthly token budget, and hard-stops (no AI call) when exceeded"
    - "The decrypted per-installation API key is used per job and never stored/logged"
    - "Every AI call writes a TokenUsage row tagged installationId, detectorId, model, input/output tokens"
    - "Every AI-enriched Finding has non-empty evidence, confidence, and caveat set"
    - "Only confidence >= 0.85 with non-empty evidence dispatches an action-execution job; medium/low are stored only"
    - "Missing API key or budget-exceeded stores a detector-only finding (confidence null / budgetExceeded true), never crashing"
  artifacts:
    - path: "apps/worker/src/workers/ai-analysis.ts"
      provides: "createAiAnalysisWorker"
      contains: "createAiAnalysisWorker"
    - path: "apps/worker/src/index.ts"
      provides: "AiAnalysisWorker registration at concurrency 5"
      contains: "createAiAnalysisWorker"
  key_links:
    - from: "apps/worker/src/workers/ai-analysis.ts"
      to: "checkTokenBudget + analyzeFailure (@ciintel/ai)"
      via: "budget gate then AI call"
      pattern: "checkTokenBudget"
    - from: "apps/worker/src/workers/ai-analysis.ts"
      to: "action-execution queue (high confidence only)"
      via: "actionExecutionQueue.add when confidence >= 0.85 && evidence.length > 0"
      pattern: "0.85"
    - from: "apps/worker/src/workers/ai-analysis.ts"
      to: "token_usages row"
      via: "db.tokenUsage.create per AI call"
      pattern: "tokenUsage.create"
---

<objective>
Implement the `AiAnalysisWorker`: load the Finding, gate on the monthly token budget, decrypt the BYOK key, call Claude Sonnet 5 via @ciintel/ai, record TokenUsage, enrich the Finding, and route ONLY high-confidence findings to action-execution.

Purpose: This is the enrichment + gating stage — the direct owner of success criteria 3, 4, and 5. It must never persist a null/empty-evidence enriched finding and must hard-stop at the budget cap.
Output: AiAnalysisWorker registered at concurrency 5, completing the Phase 2 pipeline (no actions executed yet).
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-RESEARCH.md
@apps/worker/src/index.ts
@apps/worker/src/workers/detector-dispatch.ts
@apps/worker/src/lib/installation.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: AiAnalysisWorker handler</name>
  <files>apps/worker/src/workers/ai-analysis.ts, apps/worker/package.json</files>
  <action>
1. Add dependency `@ciintel/ai: workspace:*` to apps/worker/package.json. Run `pnpm install`.

2. Create `apps/worker/src/workers/ai-analysis.ts` — `export function createAiAnalysisWorker(): Worker<AiAnalysisJob>` following RESEARCH.md Pattern 3 (lines 206-253), Phase 1 worker style (pino child logger + DLQ routing), and the pitfalls (5, 6):

Handler:
1. Validate job.data with `AiAnalysisJobSchema.safeParse`; skip on failure.
2. `checkInstallationActive`; if inactive → `{ skipped: true }`.
3. `const db = getTenantClient(installationId);` (tenant-scoped — REQUIRED so RLS + the budget query resolve, pitfall 5).
4. `const finding = await db.finding.findUniqueOrThrow({ where: { id: findingId } });`
5. BUDGET GATE (before any AI call — criterion 5 hard-stop): `const budget = await checkTokenBudget(db, installationId);` if `budget.exceeded` → `await db.finding.update({ where: { id: findingId }, data: { budgetExceeded: true } });` log `{ used, cap }`; return `{ skipped: true, reason: 'budget_exceeded' }`.
6. KEY: `const inst = await db.installation.findUniqueOrThrow({ where: { id: installationId }, select: { encryptedApiKey: true } });` if `!inst.encryptedApiKey` → log warn, return `{ skipped: true, reason: 'no_api_key' }` (detector-only finding, confidence stays null). Else `const apiKey = decryptApiKey(inst.encryptedApiKey);` (import from @ciintel/core). Never log apiKey.
7. AI CALL: `const result = await analyzeFailure({ logExcerpt: finding.rawExcerpt ?? '', detectorType: finding.detectorType as DetectorType, apiKey });` Wrap in try/catch — on NoObjectGeneratedError (or any AI failure): log (with usage if present), do NOT mark the finding as enriched, rethrow so BullMQ retries (attempts:3) and ultimately DLQs. Do not leave a half-enriched finding.
8. RECORD USAGE (criterion 5 — every AI call): `await db.tokenUsage.create({ data: { installationId, detectorId: finding.detectorType, model: 'claude-sonnet-5', inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens } });`
9. EMPTY-EVIDENCE GUARD (pitfall 6 / criterion 3): if `result.output.evidence.length === 0`, log warn, set `budgetExceeded`? No — instead do NOT enrich; leave confidence null and return `{ skipped: true, reason: 'empty_evidence' }`. (Schema .min(1) makes this rare, but never persist empty evidence.)
10. ENRICH: `await db.finding.update({ where: { id: findingId }, data: { confidence: result.output.confidence, evidence: result.output.evidence, caveat: result.output.caveat, rootCause: result.output.rootCause, suggestedFix: result.output.suggestedFix, affectedFiles: result.output.affectedFiles, severity: result.output.severity, aiEnrichedAt: new Date() } });`
11. ROUTE (criterion 4): `const advance = result.output.confidence >= 0.85 && result.output.evidence.length > 0;` if advance → `await db.finding.update({ where: { id: findingId }, data: { advancedToAction: true } });` and `await actionExecutionQueue.add('execute', { installationId, repositoryId, checkRunId, actionType: 'phase3-placeholder', actionParams: { findingId }, sha });` (validate against ActionExecutionJobSchema first). If NOT advancing (medium/low), do nothing further — finding is stored only (no action job). Log the decision `{ findingId, confidence, advanced }`.
12. Return `{ processed: true, findingId, confidence: result.output.confidence, advanced }`.

Worker options: `{ connection: getRedis(), concurrency: 5 }` (RESEARCH.md line 754). Add the DLQ-routing `worker.on('failed', ...)` block (originalQueue: 'ai-analysis').

CONSTRAINTS: 2 (no key in payload — decrypt from DB), 3 (never log key), 4 (0.85 gate), 5 (record usage + hard-stop).
  </action>
  <verify>
`pnpm --filter @ciintel/worker build` exits 0; `grep -q "checkTokenBudget" apps/worker/src/workers/ai-analysis.ts`; `grep -q "decryptApiKey" apps/worker/src/workers/ai-analysis.ts`; `grep -q "tokenUsage.create" apps/worker/src/workers/ai-analysis.ts`; `grep -q "0.85" apps/worker/src/workers/ai-analysis.ts`; `grep -q "actionExecutionQueue.add" apps/worker/src/workers/ai-analysis.ts`; confirm no `apiKey` is passed to any log call.
  </verify>
  <done>AiAnalysisWorker gates on budget, decrypts per-job, calls Sonnet 5, records TokenUsage, enriches with non-empty evidence, and advances only confidence>=0.85 findings to action-execution.</done>
</task>

<task type="auto">
  <name>Task 2: Register AiAnalysisWorker in worker entrypoint</name>
  <files>apps/worker/src/index.ts</files>
  <action>
In `apps/worker/src/index.ts` (which plan 02-05 already updated to register DetectorDispatchWorker):
- Import `createAiAnalysisWorker` from `./workers/ai-analysis.js`.
- Instantiate `const aiAnalysisWorker = createAiAnalysisWorker();` alongside the others.
- Add `"ai-analysis (concurrency=5)"` to the startup `workers` log array.
- Add `aiAnalysisWorker.close()` to the `shutdown()` `Promise.all([...])`.
- Leave the redact config (added in 02-05) intact.

Build apps/worker.
  </action>
  <verify>
`pnpm --filter @ciintel/worker build` exits 0; `grep -q "createAiAnalysisWorker" apps/worker/src/index.ts`; `grep -q "aiAnalysisWorker.close()" apps/worker/src/index.ts`.
  </verify>
  <done>AiAnalysisWorker is started at boot, listed in the startup log, and closed on shutdown.</done>
</task>

</tasks>

<verification>
- `pnpm --filter @ciintel/worker build` exits 0
- Budget hard-stop path present (skip AI, set budgetExceeded)
- TokenUsage recorded on every successful AI call
- Only confidence>=0.85 + non-empty evidence dispatches action-execution
- No enriched finding persisted with empty evidence; key never logged
</verification>

<success_criteria>
- Every enriched Finding has confidence, evidence[] (non-empty), caveat (criterion 3)
- Medium/low confidence findings never dispatch action jobs (criterion 4)
- TokenUsage tagged with installationId/detectorId/model per AI call; monthly cap hard-stops (criterion 5)
- BYOK key decrypted per job, never stored in Redis/payload/logs (constraints 2, 3)
</success_criteria>

<output>
After completion, create `.planning/phases/02-detector-pipeline-and-ai-analysis/02-06-SUMMARY.md`
</output>
