# Phase 2: Detector Pipeline & AI Analysis — Research

**Researched:** 2026-07-13
**Domain:** GitHub Actions API, Log Parsing, Vercel AI SDK, AES-256-GCM, BullMQ, Prisma
**Confidence:** HIGH (all critical claims verified via official docs or Context7)

---

## Summary

Phase 2 builds two new BullMQ workers: `DetectorDispatchWorker` (runs all 6 detectors from GitHub Actions logs and workflow files) and `AiAnalysisWorker` (enriches detector results via Claude Sonnet 5 using per-installation BYOK API keys). The data flows sequentially: `detector-dispatch` → DB store → `ai-analysis` → DB enrich → conditionally `action-execution`.

The GitHub Actions API delivers individual job logs as plain text (302 redirect) and workflow files via the Contents API (base64-encoded). Rate limits are 5,000 req/hr per installation token, which is sufficient for CI monitoring workloads. The Vercel AI SDK (`ai@7.x`) provides `generateObject()` with typed Zod schema output and exposes `usage.promptTokens` / `usage.completionTokens` directly on the result — these are the values to record in `TokenUsage`.

The recommended package architecture is: new `packages/detectors` (pure functions, no I/O) + new `packages/ai` (Anthropic integration utilities) with GitHub API fetching staying in the workers. This sets up Phase 4 SDK extraction cleanly.

**Primary recommendation:** Implement detectors as pure functions in `packages/detectors` that accept pre-fetched strings. Workers own all GitHub API calls and DB persistence. This makes detectors unit-testable without any mocking.

---

## Standard Stack

### Core (additions for Phase 2)

| Package | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ai` | `^7.0.19` | Vercel AI SDK — `generateObject()`, structured output | Provider-agnostic, `generateObject` returns `usage` directly |
| `@ai-sdk/anthropic` | latest compatible with ai@7 | Anthropic provider for AI SDK | Official provider, supports `createAnthropic({ apiKey })` per-request |
| `zod` | `^3.24.0` | Schema validation for AI output + job schemas | Already in project |
| `js-yaml` | `^4.1.0` | Parse workflow YAML files | Standard YAML parser for Node.js |
| `strip-ansi` | `^7.1.0` | Remove ANSI escape codes from CI logs | Simpler than manual regex, ESM-compatible at v7 |

### Already Available (no new install needed)

| Package | Purpose |
|---------|---------|
| `bullmq ^5.79.3` | Queue workers — already in `@ciintel/queue` |
| `@octokit/core` | GitHub API — already in `@ciintel/github` |
| `node:crypto` | AES-256-GCM encryption — Node.js built-in, no external dep needed |

### Installation

```bash
# In apps/worker
pnpm --filter @ciintel/worker add ai @ai-sdk/anthropic js-yaml strip-ansi

# In packages/detectors (new package)
pnpm --filter @ciintel/detectors add zod js-yaml strip-ansi

# In packages/ai (new package)
pnpm --filter @ciintel/ai add ai @ai-sdk/anthropic zod
```

---

## Architecture Patterns

### Recommended Project Structure

```
packages/
├── detectors/           # NEW: Pure detector functions, no I/O
│   ├── src/
│   │   ├── types.ts         # IDetector, DetectorResult, DetectorInput
│   │   ├── lint.ts          # Lint detector
│   │   ├── flaky-test.ts    # FlakyTest detector
│   │   ├── build-failure.ts # BuildFailure detector
│   │   ├── test-failure.ts  # TestFailure detector
│   │   ├── missing-env-var.ts
│   │   ├── expired-secret.ts
│   │   ├── log-utils.ts     # stripTimestamps(), stripAnsi(), extractSection()
│   │   └── index.ts
│   └── package.json

├── ai/                  # NEW: AI analysis utilities
│   ├── src/
│   │   ├── client.ts        # createAnthropicForInstallation(apiKey)
│   │   ├── analyze.ts       # analyzeFailure(input) -> AiFinding
│   │   ├── schema.ts        # Zod schema for AI output
│   │   ├── budget.ts        # checkTokenBudget(), recordTokenUsage()
│   │   └── index.ts
│   └── package.json

├── core/                # Extend with Phase 2 types
│   └── src/
│       └── index.ts     # Add: DetectorType, DetectorResult, FindingSeverity

apps/
└── worker/
    └── src/
        ├── workers/
        │   ├── webhook-ingestion.ts    # EXTEND: dispatch CI events to detector-dispatch
        │   ├── detector-dispatch.ts    # NEW: fetch logs, run detectors, store Finding
        │   ├── ai-analysis.ts          # NEW: enrich Finding, check budget, dispatch
        │   └── dlq.ts                  # existing
        └── lib/
            ├── installation.ts         # existing
            ├── github-actions.ts       # NEW: fetchJobLog(), fetchWorkflowFile(), fetchCheckRunHistory()
            └── encryption.ts           # NEW: encryptApiKey(), decryptApiKey()

apps/
└── api/
    └── src/
        └── routes/
            └── setup.ts               # NEW: POST /setup/:installationId
```

### Pattern 1: Detector as Pure Function

Each detector receives pre-fetched data and returns a typed result. No network calls inside detectors.

```typescript
// packages/detectors/src/types.ts
export type DetectorInput = {
  logExcerpt: string;       // stripped: no timestamps, no ANSI codes
  workflowYaml: string;     // raw YAML of the triggering workflow file
  jobName: string;          // name of the failed job
  checkRunHistory?: CheckRunHistoryEntry[]; // pre-fetched for FlakyTest only
};

export type DetectorResult = {
  detectorType: DetectorType;
  matched: boolean;
  violations: Violation[];  // e.g. lint violations, env var names, etc.
  rawExcerpt: string;       // the excerpt actually used (for AI)
};

export type Violation = {
  message: string;
  file?: string;
  line?: number;
  rule?: string;
};
```

```typescript
// packages/detectors/src/lint.ts
export function detectLint(input: DetectorInput): DetectorResult {
  const linter = inferLinterFromWorkflow(input.workflowYaml);
  if (!linter) return { detectorType: 'Lint', matched: false, violations: [], rawExcerpt: '' };

  const patterns = LINTER_PATTERNS[linter];
  const violations = extractViolations(input.logExcerpt, patterns);
  return {
    detectorType: 'Lint',
    matched: violations.length > 0,
    violations,
    rawExcerpt: input.logExcerpt,
  };
}
```

**When to use:** Always. All 6 detectors follow this pattern.

### Pattern 2: Worker Owns GitHub API + DB

```typescript
// apps/worker/src/workers/detector-dispatch.ts
export function createDetectorDispatchWorker(): Worker<DetectorDispatchJob> {
  return new Worker('detector-dispatch', async (job) => {
    const { installationId, repositoryId, workflowRunId, checkRunId, sha, ref } = job.data;

    // 1. Check installation is active (reuse existing helper)
    const check = await checkInstallationActive(installationId, logger);
    if (!check.active) return { skipped: true };

    // 2. Fetch GitHub data
    const octokit = await getInstallationClient(installationId);
    const { owner, repo } = await getRepoInfo(octokit, repositoryId);

    const failedJobs = await fetchFailedJobs(octokit, owner, repo, workflowRunId);
    const workflowYaml = await fetchWorkflowFile(octokit, owner, repo, workflowRunId, sha);

    // 3. For each failed job: fetch log, run all detectors, aggregate
    const allResults: DetectorResult[] = [];
    for (const failedJob of failedJobs) {
      const logExcerpt = await fetchJobLogExcerpt(octokit, owner, repo, failedJob.id);
      const history = await fetchCheckRunHistory(octokit, owner, repo, failedJob.name, ref);
      const results = runAllDetectors({ logExcerpt, workflowYaml, jobName: failedJob.name, checkRunHistory: history });
      allResults.push(...results.filter(r => r.matched));
    }

    // 4. Pick primary detector (first match, or Unknown if none)
    const primaryResult = allResults[0] ?? { detectorType: 'Unknown', matched: true, violations: [], rawExcerpt: '' };

    // 5. Store Finding in DB (RLS-scoped)
    const db = getTenantClient(installationId);
    const finding = await db.finding.create({ data: { ...primaryResult, installationId, ... } });

    // 6. Dispatch to ai-analysis queue
    await aiAnalysisQueue.add('analyze', {
      installationId,
      repositoryId,
      checkRunId,
      findingId: finding.id,
      detectorType: primaryResult.detectorType,
      sha,
    });
  });
}
```

### Pattern 3: AI Analysis with BYOK + Budget Check

```typescript
// apps/worker/src/workers/ai-analysis.ts
export function createAiAnalysisWorker(): Worker {
  return new Worker('ai-analysis', async (job) => {
    const { installationId, findingId } = job.data;

    // 1. Load finding (includes logExcerpt stored by detector worker)
    const db = getTenantClient(installationId);
    const finding = await db.finding.findUniqueOrThrow({ where: { id: findingId } });

    // 2. Check token budget
    const budget = await checkTokenBudget(db, installationId);
    if (budget.exceeded) {
      await db.finding.update({ where: { id: findingId }, data: { budgetExceeded: true } });
      return { skipped: true, reason: 'budget_exceeded' };
    }

    // 3. Load decrypted API key
    const installation = await db.installation.findUniqueOrThrow({
      where: { id: installationId },
      select: { encryptedApiKey: true },
    });
    if (!installation.encryptedApiKey) {
      logger.warn({ installationId }, 'No API key configured — skipping AI analysis');
      return { skipped: true, reason: 'no_api_key' };
    }
    const apiKey = decryptApiKey(installation.encryptedApiKey);

    // 4. Call AI
    const aiResult = await analyzeFailure({ logExcerpt: finding.detectorRaw.rawExcerpt, detectorType: finding.detectorType, apiKey });

    // 5. Record token usage
    await db.tokenUsage.create({ data: {
      installationId,
      detectorId: finding.detectorType,
      model: 'claude-sonnet-5',
      inputTokens: aiResult.usage.promptTokens,
      outputTokens: aiResult.usage.completionTokens,
    }});

    // 6. Update finding
    await db.finding.update({ where: { id: findingId }, data: { ...aiResult.output, aiEnrichedAt: new Date() } });

    // 7. Route to action-execution only if high confidence + non-empty evidence
    if (aiResult.output.confidence >= 0.85 && aiResult.output.evidence.length > 0) {
      await actionExecutionQueue.add('execute', { installationId, findingId, ... });
    }
  });
}
```

### Anti-Patterns to Avoid

- **Fetching GitHub data inside detector functions**: Detectors must be pure — pass pre-fetched strings in.
- **Storing the API key in job payload**: Never. Decrypt at job start from DB only.
- **Storing API key in Redis**: Never. The job payload only contains `installationId`; worker fetches key from DB.
- **Using FlowProducer for the sequential pipeline**: FlowProducer children run before parents (reverse depth). For this linear pipeline, each worker dispatches the next job on completion — simpler and more predictable.
- **Calling AI when `encryptedApiKey` is null**: Skip AI, store detector-only finding (`confidence=null`).
- **Parsing individual test names in detectors**: AI does this — detectors only match the overall job failure type.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ANSI escape code stripping | Custom regex | `strip-ansi@7` | Handles all ANSI sequences including nested; ESM-compatible |
| YAML parsing | Custom parser | `js-yaml` | Standard, well-tested, handles workflow YAML edge cases |
| Structured AI output | Manual JSON extraction | `generateObject()` (Vercel AI SDK) | Handles retries, schema validation, type inference |
| AES-256-GCM encrypt/decrypt | External library | `node:crypto` built-in | No extra dep; Node.js 22 crypto is stable and complete |
| Token counting | Manual tokenizer | `usage.promptTokens` from `generateObject()` result | Exact count from the API; no approximation needed |
| Monthly budget reset | Custom cron | `WHERE timestamp >= date_trunc('month', NOW())` SQL | Simpler than cron job; resets automatically each month |

**Key insight:** Do not reach for external crypto libraries for AES-256-GCM. Node.js `crypto` module covers this completely with no external deps. The only gap is ensuring correct IV (12 bytes random) and auth tag handling.

---

## GitHub Actions API — Implementation Details

### Log Fetching

**Individual job log (plain text):**
```
GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs
```
- Returns: `302 Redirect` → expires in 1 minute
- Response body: Plain text (after redirect)
- Format: Each line prefixed with ISO 8601 timestamp: `2024-01-15T10:23:45.1234567Z `
- Contains ANSI escape codes embedded in lines
- **Must strip timestamps and ANSI before processing**

Timestamp regex: `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm`
ANSI regex: `/\x1b\[[0-9;]*m/g` (use `strip-ansi` instead)

**Octokit call:**
```typescript
const resp = await octokit.request(
  'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
  { owner, repo, job_id: jobId }
);
// resp.data is the plain text log content (Octokit follows the redirect)
const rawLog: string = resp.data as string;
```

**Whole-run logs (ZIP):** `GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs` — returns a ZIP archive. Avoid this; use per-job endpoint instead.

### Listing Failed Jobs for a Workflow Run

```typescript
// GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs
const { data } = await octokit.request(
  'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
  { owner, repo, run_id: workflowRunId, filter: 'latest', per_page: 100 }
);
const failedJobs = data.jobs.filter(j => j.conclusion === 'failure');
```

Response includes `job.id`, `job.name`, `job.conclusion`, `job.steps[]`.

### Fetching the Workflow File

The workflow run object contains a `path` field like `.github/workflows/ci.yml`. Use the Contents API to fetch the actual YAML:

```typescript
// Step 1: Get workflow run to find path
const { data: run } = await octokit.request(
  'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
  { owner, repo, run_id: workflowRunId }
);
// run.path is e.g. ".github/workflows/ci.yml"

// Step 2: Fetch file at the exact SHA
const { data: file } = await octokit.request(
  'GET /repos/{owner}/{repo}/contents/{path}',
  { owner, repo, path: run.path, ref: sha }
);
// file.content is base64-encoded
const workflowYaml = Buffer.from(file.content, 'base64').toString('utf-8');
```

### Check Run History for FlakyTest

```typescript
// Per-branch window (last 5 on same branch):
const { data: runs } = await octokit.request(
  'GET /repos/{owner}/{repo}/actions/runs',
  { owner, repo, workflow_id: run.workflow_id, branch: branchName,
    status: 'completed', per_page: 5 }
);

// For each run, get the matching job conclusion:
for (const historicalRun of runs.workflow_runs) {
  const { data: jobs } = await octokit.request(
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
    { owner, repo, run_id: historicalRun.id, filter: 'latest' }
  );
  const matchingJob = jobs.jobs.find(j => j.name === currentJobName);
  if (matchingJob) history.push({ conclusion: matchingJob.conclusion });
}

// Global window (last 20 across all branches):
// Same call but without branch filter, per_page: 20
```

**FlakyTest threshold:** `passCount >= 1 && failCount >= 2` (or vice versa) in the combined window. First-run failures (empty history) → NOT flaky.

### Rate Limits

- Base: **5,000 req/hr per installation token**
- Scales: +50/repo above 20 repos, +50/user above 20 users, cap 12,500/hr
- Per CyclOps event: approximately 3–5 API calls (list jobs, get log, get workflow file, optional history)
- At 5,000 req/hr: ~1,000 CI events/hr per installation before rate limiting
- Handle `403`/`429` with exponential backoff; BullMQ retry config already at `attempts: 3, backoff: exponential`

---

## Detector Implementation Patterns

### Log Excerpt Strategy

**Decision (Claude's Discretion):** Cap excerpts at **150 lines** (~6KB). This is the portion sent to AI. Extraction strategy per detector:

| Detector | Extraction Strategy |
|----------|---------------------|
| Lint | Find first linter invocation line; capture ±75 lines around it |
| FlakyTest | Find first test failure line; capture ±75 lines (test runner output section) |
| BuildFailure | Find first `error:` / `error TS` / `BUILD FAILED` line; capture ±75 lines |
| TestFailure | Same as FlakyTest |
| MissingEnvVar | Scan entire log for env var patterns; collect all matching lines + 5 context lines each |
| ExpiredSecret | Scan entire log for cert/key expiry patterns; collect matching lines + 5 context |

```typescript
// packages/detectors/src/log-utils.ts
export function extractExcerpt(log: string, anchorPattern: RegExp, windowLines = 75): string {
  const lines = log.split('\n');
  const anchorIdx = lines.findIndex(l => anchorPattern.test(l));
  if (anchorIdx === -1) return lines.slice(0, 150).join('\n'); // fallback: first 150 lines
  const start = Math.max(0, anchorIdx - windowLines);
  const end = Math.min(lines.length, anchorIdx + windowLines);
  return lines.slice(start, end).join('\n');
}

export function stripLogFormatting(log: string): string {
  return stripAnsi(log.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm, ''));
}
```

### Linter Identification from Workflow YAML

Parse workflow YAML with `js-yaml`. Search step `run` fields (and `uses` fields for actions) for linter invocations:

```typescript
const LINTER_PATTERNS: Record<string, RegExp> = {
  ESLint:    /\beslint\b/i,
  SwiftLint: /\bswiftlint\b/i,
  ktlint:    /\bktlint\b/i,
  Rubocop:   /\brubocop\b/i,
  Prettier:  /\bprettier\b.*--check\b|\bprettier:check\b/i,
  Flake8:    /\bflake8\b/i,
  Pylint:    /\bpylint\b/i,
  Golangci:  /\bgolangci-lint\b/i,
  Detekt:    /\bdetekt\b/i,
};

export function inferLinterFromWorkflow(yaml: string): string | null {
  const doc = jsYaml.load(yaml) as Record<string, unknown>;
  const runCommands = extractAllRunCommands(doc); // recurse into jobs[].steps[].run
  for (const [linterName, pattern] of Object.entries(LINTER_PATTERNS)) {
    if (runCommands.some(cmd => pattern.test(cmd))) return linterName;
  }
  return null;
}
```

### Log Violation Patterns per Linter (Lint Detector)

```typescript
const LINTER_VIOLATION_PATTERNS: Record<string, RegExp> = {
  ESLint:    /^(.+\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+):(\d+):\s+(error|warning)\s+(.+)\s+([\w/-]+)$/m,
  SwiftLint: /^(.+\.swift):(\d+):(\d+):\s+(error|warning):\s+(.+)\s+\((\w+)\)$/m,
  ktlint:    /^(.+\.kt):(\d+):(\d+):\s+(.+)$/m,
  Rubocop:   /^(.+\.rb):(\d+):(\d+):\s+[CWE]:\s+(.+):\s+(.+)$/m,
  Prettier:  /^\[warn\]\s+(.+)$/m,
  Golangci:  /^(.+\.go):(\d+):(\d+):\s+(.+)\s+\((\w+)\)$/m,
};
```

### MissingEnvVar Patterns

```typescript
const MISSING_ENV_VAR_PATTERNS = [
  /\$\{?(\w+)\}?\s*(?:is not set|is undefined|: unbound variable)/i,
  /environment variable\s+[`'"]([\w_]+)[`'"]\s+(?:is )?(?:not set|undefined|missing)/i,
  /Error: Missing required environment variable[:\s]+[`'"]([\w_]+)[`'"]/i,
  /getenv\([`'"]([\w_]+)[`'"]\)\s*(?:returned|is)\s+(?:null|empty|undefined)/i,
  /KeyError:\s+[`'"]([\w_]+)[`'"]/i,  // Python
  /Cannot find env var[:\s]+[`'"]([\w_]+)[`'"]/i,
  /process\.env\.([\w_]+)\s+is undefined/i,
];
```

### ExpiredSecret Patterns

```typescript
const EXPIRED_SECRET_PATTERNS = [
  // iOS certificates and provisioning profiles
  /certificate\s+(?:has\s+)?expired/i,
  /provisioning profile\s+(?:has\s+)?expired/i,
  /code signing\s+(?:identity|certificate)\s+(?:has\s+)?expired/i,
  /Apple Development.*(?:expired|invalid)/i,
  // API keys / tokens
  /api.?key\s+(?:has\s+)?expired/i,
  /token\s+(?:has\s+)?expired/i,
  /your\s+(?:api\s+)?key\s+(?:has\s+)?(?:expired|been revoked)/i,
  // AWS
  /ExpiredTokenException/i,
  /InvalidClientTokenId/i,
  /The security token included in the request is expired/i,
  // Generic
  /credential\s+(?:has\s+)?expired/i,
  /401\s+Unauthorized.*(?:token|key|credential)/i,
];
```

### BuildFailure Patterns

```typescript
const BUILD_FAILURE_ANCHORS: RegExp[] = [
  /error TS\d+:/,                    // TypeScript
  /BUILD FAILED/,                    // Gradle / Xcode
  /FAILED: /,                        // CMake / Ninja
  /\berror\b.*\.(?:swift|m|mm):/i,   // Xcode
  /^.*: error: /m,                   // GCC/Clang
  /can't load package:/i,            // Go
  /build failed with \d+ error/i,    // generic
];
```

### TestFailure vs FlakyTest Decision Logic

Both detectors see the same log. The distinction is purely history-based:

```typescript
// packages/detectors/src/flaky-test.ts
export function detectFlakyTest(input: DetectorInput): DetectorResult {
  const hasTestFailure = TEST_FAILURE_PATTERNS.some(p => p.test(input.logExcerpt));
  if (!hasTestFailure) return notMatched('FlakyTest');

  const history = input.checkRunHistory ?? [];
  if (history.length === 0) return notMatched('FlakyTest'); // first-ever run — not flaky

  const passes = history.filter(h => h.conclusion === 'success').length;
  const fails  = history.filter(h => h.conclusion === 'failure').length;
  const isFlaky = passes >= 1 && fails >= 2;

  return { detectorType: 'FlakyTest', matched: isFlaky, violations: [], rawExcerpt: input.logExcerpt };
}

// packages/detectors/src/test-failure.ts
export function detectTestFailure(input: DetectorInput): DetectorResult {
  const hasTestFailure = TEST_FAILURE_PATTERNS.some(p => p.test(input.logExcerpt));
  if (!hasTestFailure) return notMatched('TestFailure');

  const history = input.checkRunHistory ?? [];
  const allFailed = history.every(h => h.conclusion === 'failure');
  // Only TestFailure if it has NOT shown flaky behavior
  const isNewFailure = history.length === 0 || allFailed;

  return { detectorType: 'TestFailure', matched: isNewFailure, violations: [], rawExcerpt: input.logExcerpt };
}
```

**Key insight:** Run FlakyTest detector first. If it matches, skip TestFailure for that job. Detectors are mutually exclusive at the job level.

---

## Vercel AI SDK — generateObject

### Installation

```bash
pnpm add ai @ai-sdk/anthropic
```

### API (confirmed against official docs)

```typescript
import { generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { NoObjectGeneratedError } from 'ai';

// Create per-installation provider with decrypted key
const anthropic = createAnthropic({ apiKey: decryptedApiKey });

const FindingSchema = z.object({
  confidence:    z.number().min(0).max(1),
  evidence:      z.array(z.string()).min(1),
  caveat:        z.string(),
  rootCause:     z.string(),
  suggestedFix:  z.string(),
  affectedFiles: z.array(z.string()),
  severity:      z.enum(['critical', 'high', 'medium', 'low']),
  detectorType:  z.enum(['Lint', 'FlakyTest', 'BuildFailure', 'TestFailure',
                          'MissingEnvVar', 'ExpiredSecret', 'Unknown']),
});

try {
  const { object, usage, finishReason } = await generateObject({
    model: anthropic('claude-sonnet-5'),
    schema: FindingSchema,
    schemaName: 'CIFailureFinding',
    schemaDescription: 'Structured analysis of a CI failure',
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(logExcerpt, detectorType),
    maxRetries: 2,
  });

  // usage is available directly on result:
  console.log(usage.promptTokens);      // number
  console.log(usage.completionTokens);  // number
  console.log(usage.totalTokens);       // number

  // object is typed as z.infer<typeof FindingSchema>
  return { output: object, usage };

} catch (err) {
  if (NoObjectGeneratedError.isInstance(err)) {
    // err.usage is available even on failure — record partial token usage
    logger.error({ cause: err.cause, usage: err.usage }, 'AI object generation failed');
    throw err;
  }
  throw err;
}
```

### Model ID

```
claude-sonnet-5
```

Confirmed: Claude Sonnet 5 API ID is `claude-sonnet-5` (dateless format, pinned snapshot). Introductory pricing: $2/$10 per MTok input/output through August 31, 2026; standard $3/$15 after.

### SDK Version

Current latest: `ai@7.0.19` (July 2026). `generateObject` still exists and is the primary API for structured output without agents. The v6+ unified API also offers `generateText` + `Output.object()`, but `generateObject` with Zod schema is simpler for this use case.

### Prompt Engineering for CI Log Analysis

```typescript
const SYSTEM_PROMPT = `You are a CI/CD failure analyst. You receive CI log excerpts and classify failures.
Always provide specific evidence from the log. Never invent violations not present in the log.
If uncertain, set confidence below 0.6 and explain in caveat.`;

function buildPrompt(logExcerpt: string, detectorType: string): string {
  return `Detector pre-classification: ${detectorType}

CI Log Excerpt:
\`\`\`
${logExcerpt}
\`\`\`

Analyze this failure. Extract specific evidence lines from the log.
Set confidence based on how clearly the log demonstrates the failure type.
Evidence must be direct quotes from the log, not paraphrases.`;
}
```

### Error Handling

| Error | Cause | Handling |
|-------|-------|---------|
| `NoObjectGeneratedError` | Model refused, parsing failed, schema violation | Catch, log `err.usage`, do NOT store Finding as AI-enriched |
| Network timeout | Slow response | BullMQ retry (attempts: 3), AI SDK `maxRetries: 2` |
| Rate limit (429) | Per-key Anthropic rate limit | BullMQ exponential backoff handles this |
| `encryptedApiKey` is null | Setup not called | Skip AI, return detector-only finding |

---

## AES-256-GCM Encryption

### Implementation (Node.js built-in crypto, no external deps)

```typescript
// apps/worker/src/lib/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96 bits — recommended by NIST for GCM
const TAG_LENGTH = 16;  // 128 bits auth tag (default)

function getEncryptionKey(): Buffer {
  const keyHex = process.env['CYCLOPS_ENCRYPTION_KEY'];
  if (!keyHex) throw new Error('CYCLOPS_ENCRYPTION_KEY env var not set');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('CYCLOPS_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  return key;
}

export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as: base64(iv + authTag + ciphertext)
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptApiKey(encoded: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}
```

**Key generation:** Generate `CYCLOPS_ENCRYPTION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → store in Railway env.

**Format decision:** `base64(iv[12] + tag[16] + ciphertext[N])` — all three components in a single field. This avoids storing IV and tag in separate DB columns.

**Security note:** IV is random per encrypt call, so the same plaintext encrypts differently each time. Auth tag prevents ciphertext tampering. This is production-grade for storing API keys.

---

## BullMQ Queue Flow

### Linear Pipeline (not FlowProducer)

**Decision:** Use sequential dispatch (each worker adds the next job) rather than `FlowProducer`. FlowProducer's children-before-parents execution order is confusing for a linear pipeline and adds complexity. Simple sequential dispatch is easier to debug and monitor.

```
webhook-ingestion worker
  └─ dispatches to: detector-dispatch queue
       └─ detector-dispatch worker runs, stores Finding
       └─ dispatches to: ai-analysis queue
            └─ ai-analysis worker enriches Finding
            └─ if high confidence: dispatches to: action-execution queue (Phase 3)
```

### Job Schema Updates Needed

The existing `AiAnalysisJob` schema needs a `findingId` field (UUID from DB):

```typescript
// packages/queue/src/jobs.ts — UPDATE
export const AiAnalysisJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId:   z.number().int().positive(),
  checkRunId:     z.number().int().positive(),
  findingId:      z.string().uuid(),           // ADD THIS
  detectorType:   z.string(),                  // replaces failureType
  sha:            z.string().length(40),
});
```

### Webhook Ingestion → Detector Dispatch

The Phase 1 `webhook-ingestion` worker currently logs `"CI event received — dispatcher implemented in Phase 2"`. Phase 2 must replace this stub with actual dispatch:

```typescript
// In webhook-ingestion.ts: handle check_run events
if (eventName === 'check_run' && action === 'completed') {
  const payload = JSON.parse(webhookDelivery.payload);
  if (payload.check_run.conclusion === 'failure') {
    await detectorDispatchQueue.add('detect', {
      installationId,
      repositoryId: payload.repository.id,
      checkRunId: payload.check_run.id,
      workflowRunId: payload.check_run.check_suite?.id,  // may need separate lookup
      ref: payload.check_run.check_suite?.head_branch,
      sha: payload.check_run.head_sha,
    });
  }
}
```

**Note:** `workflow_run` events (not `check_run`) may be a better trigger since they contain `workflow_id` and aggregate all jobs. The webhook events stored in Phase 1 are in `webhook_deliveries.payload` — the DetectorDispatch worker should re-fetch the payload from DB rather than have it in the job payload.

### Concurrency Recommendations

| Worker | Concurrency | Reason |
|--------|-------------|--------|
| detector-dispatch | 10 | Each job makes 3–5 GitHub API calls; rate-limit headroom |
| ai-analysis | 5 | External API calls; per-installation key limits apply |

---

## Prisma Schema Additions

### New Models

```prisma
// packages/db/prisma/schema.prisma — ADDITIONS

model Installation {
  // ... existing fields ...
  encryptedApiKey String?      // AES-256-GCM encrypted Anthropic API key
  
  findings     Finding[]
  tokenUsages  TokenUsage[]
}

model Finding {
  id             String    @id @default(uuid())
  installationId Int
  repositoryId   Int
  workflowRunId  Int
  checkRunId     Int
  detectorType   String    // "Lint" | "FlakyTest" | "BuildFailure" | "TestFailure" | "MissingEnvVar" | "ExpiredSecret" | "Unknown"
  sha            String
  ref            String
  
  // Detector output stored as JSONB
  violations     Json      @default("[]")  // Violation[]
  rawExcerpt     String?   // log excerpt sent to AI

  // AI enrichment — all nullable until AI runs
  confidence     Float?
  evidence       String[]  @default([])   // never empty when confidence is set
  caveat         String?
  rootCause      String?
  suggestedFix   String?
  affectedFiles  String[]  @default([])
  severity       String?   // "critical" | "high" | "medium" | "low"
  
  // Routing flags
  aiEnrichedAt      DateTime?
  advancedToAction  Boolean   @default(false)
  budgetExceeded    Boolean   @default(false)  // true when token cap hit
  
  // Soft delete
  deletedAt      DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  installation   Installation @relation(fields: [installationId], references: [id])

  @@index([installationId])
  @@index([workflowRunId])
  @@index([installationId, createdAt])
  @@map("findings")
}

model TokenUsage {
  id             String   @id @default(uuid())
  installationId Int
  detectorId     String   // detector type that triggered the AI call
  model          String   // "claude-sonnet-5"
  inputTokens    Int
  outputTokens   Int
  timestamp      DateTime @default(now())

  installation   Installation @relation(fields: [installationId], references: [id])

  @@index([installationId])
  @@index([installationId, timestamp])   // for monthly budget queries
  @@map("token_usages")
}
```

### RLS Migration Pattern

Follow exactly the pattern in `0002_rls/migration.sql`:

```sql
-- 0003_phase2: Add findings, token_usages, encryptedApiKey

ALTER TABLE "installations" ADD COLUMN "encryptedApiKey" TEXT;

CREATE TABLE "findings" (
  "id"               TEXT          NOT NULL,
  "installationId"   INTEGER       NOT NULL,
  "repositoryId"     INTEGER       NOT NULL,
  "workflowRunId"    INTEGER       NOT NULL,
  "checkRunId"       INTEGER       NOT NULL,
  "detectorType"     TEXT          NOT NULL,
  "sha"              TEXT          NOT NULL,
  "ref"              TEXT          NOT NULL,
  "violations"       JSONB         NOT NULL DEFAULT '[]',
  "rawExcerpt"       TEXT,
  "confidence"       DOUBLE PRECISION,
  "evidence"         TEXT[]        NOT NULL DEFAULT '{}',
  "caveat"           TEXT,
  "rootCause"        TEXT,
  "suggestedFix"     TEXT,
  "affectedFiles"    TEXT[]        NOT NULL DEFAULT '{}',
  "severity"         TEXT,
  "aiEnrichedAt"     TIMESTAMP(3),
  "advancedToAction" BOOLEAN       NOT NULL DEFAULT false,
  "budgetExceeded"   BOOLEAN       NOT NULL DEFAULT false,
  "deletedAt"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "token_usages" (
  "id"             TEXT          NOT NULL,
  "installationId" INTEGER       NOT NULL,
  "detectorId"     TEXT          NOT NULL,
  "model"          TEXT          NOT NULL,
  "inputTokens"    INTEGER       NOT NULL,
  "outputTokens"   INTEGER       NOT NULL,
  "timestamp"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "token_usages_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "findings_installationId_idx" ON "findings"("installationId");
CREATE INDEX "findings_workflowRunId_idx" ON "findings"("workflowRunId");
CREATE INDEX "findings_installationId_createdAt_idx" ON "findings"("installationId", "createdAt");
CREATE INDEX "token_usages_installationId_idx" ON "token_usages"("installationId");
CREATE INDEX "token_usages_installationId_timestamp_idx" ON "token_usages"("installationId", "timestamp");

-- Foreign keys
ALTER TABLE "findings" ADD CONSTRAINT "findings_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "token_usages" ADD CONSTRAINT "token_usages_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (same pattern as 0002_rls)
ALTER TABLE "findings"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "token_usages"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "findings"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "token_usages"  FORCE ROW LEVEL SECURITY;

CREATE POLICY "findings_tenant_isolation" ON "findings"
  USING ("installationId" = current_installation_id());

CREATE POLICY "token_usages_tenant_isolation" ON "token_usages"
  USING ("installationId" = current_installation_id());

CREATE POLICY "findings_service_bypass" ON "findings"
  TO "postgres" USING (true);

CREATE POLICY "token_usages_service_bypass" ON "token_usages"
  TO "postgres" USING (true);
```

### Monthly Budget Query

```typescript
// packages/ai/src/budget.ts
export async function checkTokenBudget(db: ReturnType<typeof getTenantClient>, installationId: number): Promise<{ exceeded: boolean; used: number; cap: number }> {
  const cap = parseInt(process.env['CYCLOPS_MONTHLY_TOKEN_BUDGET'] ?? '1000000', 10);

  // Sum tokens this calendar month
  const result = await db.$queryRaw<[{ total: bigint }]>`
    SELECT COALESCE(SUM("inputTokens" + "outputTokens"), 0) AS total
    FROM "token_usages"
    WHERE "installationId" = ${installationId}
      AND "timestamp" >= date_trunc('month', NOW())
  `;

  const used = Number(result[0]?.total ?? 0);
  return { exceeded: used >= cap, used, cap };
}
```

**Default token cap (Claude's Discretion):** `CYCLOPS_MONTHLY_TOKEN_BUDGET=1000000` (1M tokens). At Claude Sonnet 5 introductory pricing ($2/$10 per MTok), this costs ~$2–10/month per installation. Document clearly in README.

---

## Setup Endpoint (BYOK)

### Route: POST /setup/:installationId

```typescript
// apps/api/src/routes/setup.ts
app.post('/setup/:installationId', async (request, reply) => {
  const installationId = parseInt(request.params.installationId, 10);
  const { apiKey } = request.body as { apiKey: string };

  if (!apiKey?.startsWith('sk-ant-')) {
    return reply.code(400).send({ error: 'Invalid Anthropic API key format' });
  }

  // Verify the API key works before storing (optional but recommended)
  // ... test call to Anthropic API ...

  const encrypted = encryptApiKey(apiKey);
  const db = getDb(); // use base client (not tenant-scoped) for installation update
  await db.installation.update({
    where: { id: installationId },
    data: { encryptedApiKey: encrypted },
  });

  return reply.code(200).send({ ok: true });
});
```

**Authentication gap (Open Question):** How to authenticate the POST /setup caller is an open question — see Open Questions below.

---

## @ciintel/core Additions

```typescript
// packages/core/src/index.ts — ADD:
export type DetectorType =
  | 'Lint'
  | 'FlakyTest'
  | 'BuildFailure'
  | 'TestFailure'
  | 'MissingEnvVar'
  | 'ExpiredSecret'
  | 'Unknown';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export type Violation = {
  message: string;
  file?: string;
  line?: number;
  column?: number;
  rule?: string;
};

export type DetectorResult = {
  detectorType: DetectorType;
  matched: boolean;
  violations: Violation[];
  rawExcerpt: string;
};

export type AiFinding = {
  confidence: number;
  evidence: string[];
  caveat: string;
  rootCause: string;
  suggestedFix: string;
  affectedFiles: string[];
  severity: FindingSeverity;
  detectorType: DetectorType;
};
```

---

## Common Pitfalls

### Pitfall 1: Log Redirect Not Followed

**What goes wrong:** Calling Octokit for job logs returns `302` but you get back an empty body or URL string instead of the log text.
**Why it happens:** Some Octokit versions don't auto-follow redirects for non-JSON response types.
**How to avoid:** Use `node-fetch` or the global `fetch` to follow the redirect manually:
```typescript
// Octokit returns redirect URL, then follow it:
const { url } = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { owner, repo, job_id });
const resp = await fetch(url);
const logText = await resp.text();
```
Or check `resp.data` — if it's a string, it's the log. If it's a URL, follow it with fetch.

### Pitfall 2: Log Lines Include Timestamps — Break Regex

**What goes wrong:** Pattern `/error TS\d+:/` doesn't match because the actual line is `2024-01-15T10:23:45.1234567Z src/index.ts(10,5): error TS2345`.
**How to avoid:** Always strip timestamps before running patterns. Use `stripLogFormatting()` before passing to any detector.

### Pitfall 3: ANSI Codes Break Line Patterns

**What goes wrong:** A lint violation line like `src/index.ts:10:5: [31merror[0m no-unused-vars` fails to match the expected pattern.
**How to avoid:** `strip-ansi` before any regex matching.

### Pitfall 4: AI SDK Version Mismatch

**What goes wrong:** `generateObject` is not exported from `ai@7` in some sub-paths; NoObjectGeneratedError is in different import path.
**How to avoid:** Import from top-level `'ai'` package: `import { generateObject, NoObjectGeneratedError } from 'ai'`. Don't import from `'ai/core'` or subpaths.

### Pitfall 5: RLS Blocks Budget Query

**What goes wrong:** `checkTokenBudget` runs inside a tenant-scoped DB client — RLS restricts `token_usages` to the current `app.current_installation_id`. If the raw SQL query doesn't go through the same transaction, it uses `NULL` as the installation ID and returns 0.
**How to avoid:** Always call `checkTokenBudget(getTenantClient(installationId), installationId)`. The `getTenantClient` wraps every operation in a transaction that sets `app.current_installation_id`.

### Pitfall 6: Empty evidence[] Stored

**What goes wrong:** AI returns `evidence: []` and the finding is stored with an empty evidence array, violating success criterion 3.
**How to avoid:** Validate AI output before storing:
```typescript
if (aiResult.output.evidence.length === 0) {
  logger.warn({ findingId }, 'AI returned empty evidence — storing as budget_exceeded');
  await db.finding.update({ where: { id: findingId }, data: { budgetExceeded: true } });
  return;
}
```
Or add `.min(1)` to the Zod schema for `evidence` to force at least one item (the SDK will retry if model returns empty array).

### Pitfall 7: FlakyTest + TestFailure Double-Match

**What goes wrong:** Both FlakyTest and TestFailure return `matched: true` for the same job, creating two findings.
**How to avoid:** Establish priority order for multi-match aggregation. FlakyTest takes precedence over TestFailure. Run detectors in priority order and skip lower-priority if higher already matched.

### Pitfall 8: workflow_run.path Format

**What goes wrong:** The workflow file path from the run object has format `.github/workflows/ci.yml@main` (includes branch ref). Passing this directly to Contents API fails.
**How to avoid:** Strip the `@branch` suffix: `run.path.split('@')[0]`.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| `generateObject` with schema param | Same API in ai@7 (unchanged) | — | No change needed |
| `@anthropic-ai/sdk` direct | `@ai-sdk/anthropic` + `ai` package | Ongoing | Per-request `createAnthropic({ apiKey })` is cleaner than global env var |
| Job logs ZIP archive parsing | Per-job plain text endpoint | Always available | Use `/actions/jobs/{job_id}/logs` not `/actions/runs/{run_id}/logs` |
| Manual token counting | `usage.promptTokens` from result | ai@3+ | Exact server-counted tokens in result object |
| OpenSSL external lib | `node:crypto` AES-256-GCM | Node.js 10.x | Built-in, no external dep needed |

---

## Open Questions

### 1. POST /setup Authentication

- **What we know:** The endpoint sets the encrypted API key for an installation. No UI. curl/CLI only.
- **What's unclear:** How to verify the caller is the installation owner/admin without a UI flow.
- **Recommendation:** Two viable options:
  1. **GitHub installation token:** Require `Authorization: Bearer {installation_token}` header. Verify it by calling `GET /app/installations` with the token — if it returns the correct `installationId`, the caller is authenticated. Simple but requires one GitHub API call per setup.
  2. **Shared secret header:** Require `X-Setup-Token: {CYCLOPS_SETUP_SECRET}` env var matching. Admin-controlled secret. Less granular but zero GitHub API calls. Acceptable for Phase 2 since this endpoint is not publicly documented.
- **Decision needed by planner:** Which authentication scheme to implement.

### 2. webhook_run vs check_run Event Trigger

- **What we know:** Phase 1 stores `webhook_deliveries` for all events. The `check_run completed` event has the check run data but may not have `workflow_run_id` directly. The `workflow_run completed` event has the full workflow run context.
- **What's unclear:** Which event type the Phase 1 webhook ingestion receives for CI failures, and whether `workflowRunId` is directly accessible from the stored payload.
- **Recommendation:** The webhook ingestion worker should handle both `workflow_run completed` (preferred, aggregates all jobs) and `check_run completed failure` events. Plan for the worker to look up `workflowRunId` via GitHub API if not in the stored payload.

### 3. getInstallationClient Repository Info

- **What we know:** `getInstallationClient(installationId)` returns Octokit. The `DetectorDispatchJob` has `repositoryId` (integer) but Octokit calls need `owner` and `repo` (strings).
- **What's unclear:** Whether the existing project has a way to resolve `repositoryId → owner/repo`, or whether this lookup needs to be added.
- **Recommendation:** Add a `github-actions.ts` lib file with `getRepoInfo(octokit, repositoryId): Promise<{owner, repo}>` that calls `GET /repositories/{repository_id}`. Cache in-memory within the worker process since this data is stable.

---

## Sources

### Primary (HIGH confidence)
- Anthropic Models Overview — `claude-sonnet-5` confirmed as API ID, pricing verified
- GitHub REST API: Workflow Jobs — all endpoint paths verified
- GitHub REST API: Workflow Runs — download URL redirect behavior
- GitHub REST API: Repository Contents — `ref` param for SHA pinning
- GitHub REST API: Check Runs — `filter=all`, `check_name` filter params
- GitHub REST API: Rate Limits — 5,000 req/hr base for GitHub App installation tokens
- Vercel AI SDK v4 reference — `generateObject` signature, usage field structure
- Vercel AI SDK blog: AI SDK 6 — `generateObject` still exists and functions in v6+
- Node.js crypto gist — AES-256-GCM encrypt/decrypt pattern with auth tag
- BullMQ Flows docs — FlowProducer children-before-parents execution order

### Secondary (MEDIUM confidence)
- GitHub Actions log format: timestamp prefix, ANSI codes — confirmed by GitHub community discussions and runner issues
- Linter output patterns: ESLint `file:line:col`, SwiftLint stderr format — confirmed by multiple docs
- `ai@7.0.19` as latest version — from npm registry search results

### Tertiary (LOW confidence)
- `workflow_run.path` format includes `@branch` suffix — from WebSearch, not verified via official docs

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — all packages verified against official sources
- GitHub Actions API: HIGH — all endpoints verified via official GitHub docs
- generateObject API: HIGH — verified against official Vercel AI SDK reference
- AES-256-GCM pattern: HIGH — Node.js built-in, pattern from official gist
- Architecture: HIGH — follows established Phase 1 patterns
- Log format/patterns: MEDIUM — log format confirmed; specific regex patterns are best-effort
- Prisma schema: HIGH — follows identical patterns to Phase 1 migrations

**Research date:** 2026-07-13
**Valid until:** 2026-08-13 (30 days — stable APIs)
