---
phase: 02-detector-pipeline-and-ai-analysis
plan: 05
type: execute
wave: 3
depends_on: ["02-01", "02-02"]
files_modified:
  - apps/worker/src/lib/github-actions.ts
  - apps/worker/src/workers/detector-dispatch.ts
  - apps/worker/src/workers/webhook-ingestion.ts
  - apps/worker/src/index.ts
  - apps/worker/package.json

must_haves:
  truths:
    - "A failing workflow_run/check_run webhook results in a detector-dispatch job"
    - "The worker fetches failed job logs + workflow YAML from the GitHub Actions API, stripped of timestamps/ANSI"
    - "runAllDetectors classifies the aggregated failure; unmatched failures become an Unknown finding (never dropped)"
    - "A Finding row is created (tenant-scoped) with detectorType, violations, rawExcerpt"
    - "An ai-analysis job is dispatched carrying only identifiers (installationId, findingId, detectorType, ids)"
  artifacts:
    - path: "apps/worker/src/lib/github-actions.ts"
      provides: "getRepoInfo, fetchFailedJobs, fetchWorkflowFile, fetchJobLogExcerpt, fetchCheckRunHistory"
      contains: "fetchWorkflowFile"
    - path: "apps/worker/src/workers/detector-dispatch.ts"
      provides: "createDetectorDispatchWorker"
      contains: "runAllDetectors"
    - path: "apps/worker/src/workers/webhook-ingestion.ts"
      provides: "CI event -> detectorDispatchQueue dispatch (replaces Phase 1 stub)"
      contains: "detectorDispatchQueue"
  key_links:
    - from: "apps/worker/src/workers/detector-dispatch.ts"
      to: "Finding row + aiAnalysisQueue"
      via: "getTenantClient(installationId).finding.create then aiAnalysisQueue.add"
      pattern: "aiAnalysisQueue.add"
    - from: "apps/worker/src/workers/webhook-ingestion.ts"
      to: "detector-dispatch queue"
      via: "detectorDispatchQueue.add on failed CI event"
      pattern: "detectorDispatchQueue.add"
---

<objective>
Wire the detection stage: a `github-actions.ts` lib that fetches logs/workflow/history from the GitHub Actions API, a `DetectorDispatchWorker` that runs all 6 detectors and stores a Finding, and the webhook-ingestion stub replaced with real dispatch on failing CI events.

Purpose: This turns real GitHub events into stored, classified Findings within seconds — the backbone of success criterion 1. It also produces the Unknown fallback so no failure is dropped.
Output: detector-dispatch worker registered and dispatching ai-analysis jobs (identifiers only).
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-RESEARCH.md
@apps/worker/src/index.ts
@apps/worker/src/workers/webhook-ingestion.ts
@apps/worker/src/lib/installation.ts
@packages/github/src/clients.ts
@packages/queue/src/queues.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: GitHub Actions API lib</name>
  <files>apps/worker/src/lib/github-actions.ts, apps/worker/package.json</files>
  <action>
1. Add dependency `@ciintel/detectors: workspace:*` to apps/worker/package.json (it provides stripLogFormatting/extractExcerpt used to shape logs). Run `pnpm install`.

2. Create `apps/worker/src/lib/github-actions.ts` per RESEARCH.md "GitHub Actions API — Implementation Details" (lines 282-367) and Open Question 3 (lines 1102-1106). All functions take an Octokit (`import type { Octokit } from '@octokit/core'`) obtained by the worker via `getInstallationClient`.
   - `getRepoInfo(octokit, repositoryId): Promise<{ owner: string; repo: string }>` — `GET /repositories/{repository_id}`, return `data.owner.login` + `data.name`. Cache results in a module-level `Map<number,{owner,repo}>` (stable data).
   - `fetchFailedJobs(octokit, owner, repo, runId): Promise<{ id: number; name: string }[]>` — `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` with `filter:'latest', per_page:100`; return jobs where `conclusion === 'failure'` mapped to `{ id, name }`.
   - `fetchWorkflowFile(octokit, owner, repo, runId, sha): Promise<string>` — get the run (`GET .../actions/runs/{run_id}`) to read `run.path`; STRIP `@branch` suffix via `run.path.split('@')[0]` (pitfall 8); `GET /repos/{owner}/{repo}/contents/{path}` with `ref: sha`; base64-decode `file.content` to utf-8. On 404 return `''` (workflow file optional for some detectors).
   - `fetchJobLogExcerpt(octokit, owner, repo, jobId, anchorPattern?): Promise<string>` — `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`. Handle both response shapes (pitfall 1): if `resp.data` is a string use it; if it looks like a URL, `await fetch(url)` then `.text()`. Then `stripLogFormatting` (from @ciintel/detectors) and, if anchorPattern given, `extractExcerpt`, else cap to first 150 lines.
   - `fetchCheckRunHistory(octokit, owner, repo, workflowId, jobName, branch): Promise<{ conclusion: string | null }[]>` — per RESEARCH.md lines 347-367: list last 5 completed runs for the workflow on the branch, then last 20 without branch filter (combined window); for each run fetch jobs (`filter:'latest'`), find the job with matching `name`, push its conclusion. Wrap in try/catch returning `[]` on error (history is best-effort; empty history => not flaky).
   - Handle 403/429 by letting the error propagate (BullMQ retry with backoff handles it, per lines 372-377).

CONSTRAINT 6/7: this file lives in the worker (I/O allowed here); detectors stay pure. Never log token/log content beyond counts.
  </action>
  <verify>
`pnpm --filter @ciintel/worker build` exits 0; `grep -q "fetchWorkflowFile" apps/worker/src/lib/github-actions.ts` and `grep -q "getRepoInfo" apps/worker/src/lib/github-actions.ts`; `grep -q "split('@')" apps/worker/src/lib/github-actions.ts` (path suffix stripped); worker package.json lists `@ciintel/detectors`.
  </verify>
  <done>github-actions.ts exposes the five fetch helpers using Octokit, strips log formatting, strips workflow path @branch suffix, and returns empty history gracefully.</done>
</task>

<task type="auto">
  <name>Task 2: DetectorDispatchWorker</name>
  <files>apps/worker/src/workers/detector-dispatch.ts</files>
  <action>
Create `apps/worker/src/workers/detector-dispatch.ts` — `export function createDetectorDispatchWorker(): Worker<DetectorDispatchJob>` following the Phase 1 worker style (pino child logger, DLQ routing on exhausted retries like webhook-ingestion.ts) and RESEARCH.md Pattern 2 (lines 158-200):

Handler:
1. Validate job.data with `DetectorDispatchJobSchema.safeParse`; on failure log + skip.
2. `checkInstallationActive(installationId, jobLog)` (reuse existing helper); if inactive → `{ skipped: true }`.
3. `const octokit = await getInstallationClient(installationId);` `const { owner, repo } = await getRepoInfo(octokit, repositoryId);`
4. Resolve the workflow run id: use `job.data.workflowRunId` if present; else look it up (skip with a logged warning if unavailable).
5. `const failedJobs = await fetchFailedJobs(...)`; `const workflowYaml = await fetchWorkflowFile(...)`.
6. Aggregate across ALL failed jobs (CONTEXT: one finding per workflow run). For each failed job: fetch log excerpt (no anchor — pass full stripped log capped to 150 lines; detectors self-anchor via their patterns), fetch check-run history (workflowId + job name + ref/branch), then `runAllDetectors({ logExcerpt, workflowYaml, jobName: job.name, checkRunHistory: history })`. Collect matched results across jobs.
7. Pick the primary result: first matched result across all jobs; if NONE matched, use `{ detectorType: 'Unknown', matched: true, violations: [], rawExcerpt: <first job's excerpt> }` (CONTEXT: unknown failures still routed to AI, never dropped).
8. Store the Finding using a tenant-scoped client: `const db = getTenantClient(installationId);` `const finding = await db.finding.create({ data: { installationId, repositoryId, workflowRunId, checkRunId, detectorType: primary.detectorType, sha, ref, violations: primary.violations, rawExcerpt: primary.rawExcerpt } });`
9. Dispatch ai-analysis with IDENTIFIERS ONLY (CONSTRAINT 2): `await aiAnalysisQueue.add('analyze', { installationId, repositoryId, checkRunId, findingId: finding.id, detectorType: primary.detectorType, sha });` — no log content, no keys.
10. Return `{ processed: true, findingId: finding.id, detectorType: primary.detectorType }`.

Worker options: `{ connection: getRedis(), concurrency: 10 }` (RESEARCH.md line 753). Add the same `worker.on('failed', ...)` DLQ routing block used in webhook-ingestion.ts (originalQueue: 'detector-dispatch').
  </action>
  <verify>
`pnpm --filter @ciintel/worker build` exits 0; `grep -q "runAllDetectors" apps/worker/src/workers/detector-dispatch.ts`; `grep -q "getTenantClient" apps/worker/src/workers/detector-dispatch.ts`; `grep -q "aiAnalysisQueue.add" apps/worker/src/workers/detector-dispatch.ts`; `grep -q "concurrency: 10" apps/worker/src/workers/detector-dispatch.ts`; confirm the ai-analysis payload object contains no `apiKey`/`rawExcerpt`/`logExcerpt` field (grep the .add call).
  </verify>
  <done>DetectorDispatchWorker fetches GitHub data, runs all detectors, stores a tenant-scoped Finding (Unknown fallback when unmatched), and dispatches an identifiers-only ai-analysis job at concurrency 10.</done>
</task>

<task type="auto">
  <name>Task 3: Replace webhook-ingestion CI stub + register worker</name>
  <files>apps/worker/src/workers/webhook-ingestion.ts, apps/worker/src/index.ts</files>
  <action>
1. In `apps/worker/src/workers/webhook-ingestion.ts`, replace the Phase 1 CI-event stub (the block logging "CI event received — dispatcher implemented in Phase 2") with real dispatch (RESEARCH.md lines 726-747):
   - Load the stored payload from DB: `const delivery = await getDb().webhookDelivery.findUnique({ where: { deliveryId } });` (the worker reads the full payload from DB, not the job payload — per research note lines 746-747). Guard null.
   - Handle `eventName === 'workflow_run' && action === 'completed'` (PREFERRED — aggregates all jobs): read `payload.workflow_run`; if `conclusion === 'failure'`, dispatch to `detectorDispatchQueue.add('detect', { installationId, repositoryId: payload.repository.id, checkRunId: payload.workflow_run.id, workflowRunId: payload.workflow_run.id, ref: payload.workflow_run.head_branch, sha: payload.workflow_run.head_sha })`.
     (checkRunId is required by the schema; for workflow_run events use the run id as the correlation id.)
   - Also handle `eventName === 'check_run' && action === 'completed'` with `payload.check_run.conclusion === 'failure'` as a fallback: dispatch using check_run.id + head_sha + check_suite head_branch/id (lines 732-744).
   - Validate the constructed payload with `DetectorDispatchJobSchema.safeParse` before adding; log + skip on failure.
   - Keep all existing installation-event handling untouched.

2. In `apps/worker/src/index.ts`:
   - Import + start `createDetectorDispatchWorker()`; add it to the `workers` log line and to the `shutdown()` Promise.all close list.
   - Add pino `redact` to the worker logger config for paths `['apiKey','encryptedApiKey','*.apiKey','*.encryptedApiKey']` (CONSTRAINT 3 — worker side; the decrypt happens in plan 02-06 but redaction should already be in place).

3. Build apps/worker.
  </action>
  <verify>
`pnpm --filter @ciintel/worker build` exits 0; `grep -q "detectorDispatchQueue.add" apps/worker/src/workers/webhook-ingestion.ts`; `grep -q "workflow_run" apps/worker/src/workers/webhook-ingestion.ts`; `grep -q "createDetectorDispatchWorker" apps/worker/src/index.ts`; `grep -q "redact" apps/worker/src/index.ts`; the "dispatcher implemented in Phase 2" stub string is gone (`! grep -q "dispatcher implemented in Phase 2" apps/worker/src/workers/webhook-ingestion.ts`).
  </verify>
  <done>Failing workflow_run/check_run events dispatch detector-dispatch jobs from the DB-stored payload; DetectorDispatchWorker is registered, shuts down cleanly, and the worker logger redacts key fields.</done>
</task>

</tasks>

<verification>
- `pnpm --filter @ciintel/worker build` exits 0
- CI failure events dispatch to detector-dispatch (stub removed)
- Worker runs all detectors, stores a Finding, dispatches identifiers-only ai-analysis job
- Unknown fallback path present; concurrency 10; worker logger redacts keys
</verification>

<success_criteria>
- Real GitHub Actions events flow into stored, classified Findings (criterion 1 backbone)
- No failure is dropped (Unknown finding fallback)
- ai-analysis job payload contains identifiers only (constraint 2)
- FlakyTest/TestFailure exclusivity preserved via runAllDetectors
</success_criteria>

<output>
After completion, create `.planning/phases/02-detector-pipeline-and-ai-analysis/02-05-SUMMARY.md`
</output>
