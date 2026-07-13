---
phase: 02-detector-pipeline-and-ai-analysis
plan: 03
type: execute
wave: 2
depends_on: ["02-01"]
files_modified:
  - packages/ai/package.json
  - packages/ai/tsconfig.json
  - packages/ai/src/schema.ts
  - packages/ai/src/client.ts
  - packages/ai/src/analyze.ts
  - packages/ai/src/budget.ts
  - packages/ai/src/index.ts
  - pnpm-workspace.yaml
  - tsconfig.json

must_haves:
  truths:
    - "analyzeFailure returns a structured finding with confidence, evidence[] (min 1), caveat, rootCause, suggestedFix, affectedFiles, severity, detectorType"
    - "Token usage (promptTokens, completionTokens) is returned from the AI call for recording"
    - "checkTokenBudget sums the current calendar month's tokens and reports exceeded vs cap"
    - "A per-installation decrypted API key is used per request (createAnthropic), never a global env key"
    - "NoObjectGeneratedError is caught and surfaces usage without persisting an enriched finding"
  artifacts:
    - path: "packages/ai/src/schema.ts"
      provides: "Zod FindingSchema with evidence.min(1)"
      contains: "evidence"
    - path: "packages/ai/src/analyze.ts"
      provides: "analyzeFailure(input) -> { output, usage }"
      contains: "generateObject"
    - path: "packages/ai/src/budget.ts"
      provides: "checkTokenBudget(db, installationId)"
      contains: "date_trunc"
    - path: "packages/ai/src/client.ts"
      provides: "createAnthropicForInstallation(apiKey)"
      contains: "createAnthropic"
  key_links:
    - from: "packages/ai/src/analyze.ts"
      to: "@ai-sdk/anthropic + ai generateObject"
      via: "model = anthropic('claude-sonnet-5')"
      pattern: "claude-sonnet-5"
    - from: "packages/ai/src/budget.ts"
      to: "token_usages monthly sum"
      via: "$queryRaw with date_trunc('month', NOW())"
      pattern: "date_trunc\\('month'"
---

<objective>
Create the new `packages/ai` package: Zod finding schema, per-installation Anthropic client factory, `analyzeFailure` wrapper around `generateObject` (Claude Sonnet 5), and `checkTokenBudget` monthly-cap logic.

Purpose: This is the AI enrichment layer. It guarantees structured output (non-empty evidence via schema), exposes exact token usage, and provides the hard-stop budget check — satisfying success criteria 3 and 5.
Output: A compiling @ciintel/ai package. It performs the Anthropic call but takes the decrypted key and a db client as parameters (no encryption, no direct Prisma import).
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-RESEARCH.md
@packages/core/package.json
</context>

<user_setup>
  - service: anthropic
    why: "AI enrichment of CI findings (BYOK — key supplied per installation via POST /setup)"
    env_vars: []
    dashboard_config: []
</user_setup>

<tasks>

<task type="auto">
  <name>Task 1: Scaffold package + schema + client</name>
  <files>packages/ai/package.json, packages/ai/tsconfig.json, packages/ai/src/schema.ts, packages/ai/src/client.ts, pnpm-workspace.yaml, tsconfig.json</files>
  <action>
1. Create `packages/ai/package.json` (name `@ciintel/ai`, type module, exports ./dist/index.js + types, build/clean scripts). Dependencies: `@ciintel/core: workspace:*`, `ai: ^7.0.19`, `@ai-sdk/anthropic: ^2.0.0` (latest compatible with ai@7 — let pnpm resolve), `zod: ^3.24.0`. devDependencies: typescript ^5.8.0, @types/node ^22.0.0.

2. Create `packages/ai/tsconfig.json` extending ../../tsconfig.base.json with composite + a project reference to ../core. Add `{ "path": "packages/ai" }` to the root tsconfig references if present.

3. Create `packages/ai/src/schema.ts` per RESEARCH.md lines 560-570:
   - `import { z } from 'zod';`
   - `export const FindingSchema = z.object({ confidence: z.number().min(0).max(1), evidence: z.array(z.string()).min(1), caveat: z.string(), rootCause: z.string(), suggestedFix: z.string(), affectedFiles: z.array(z.string()), severity: z.enum(['critical','high','medium','low']), detectorType: z.enum(['Lint','FlakyTest','BuildFailure','TestFailure','MissingEnvVar','ExpiredSecret','Unknown']) });`
   - `export type FindingOutput = z.infer<typeof FindingSchema>;`
   NOTE the `.min(1)` on evidence — this forces the model (with maxRetries) to return at least one evidence item, protecting success criterion 3.

4. Create `packages/ai/src/client.ts`:
   - `import { createAnthropic } from '@ai-sdk/anthropic';`
   - `export function createAnthropicForInstallation(apiKey: string) { return createAnthropic({ apiKey }); }`
   - `export const CLAUDE_MODEL = 'claude-sonnet-5';`
   Per-request key only — never read process.env for the key here.

Run `pnpm install` then `pnpm --filter @ciintel/ai build`.
  </action>
  <verify>
`pnpm --filter @ciintel/ai build` exits 0; `grep -q "evidence: z.array(z.string()).min(1)" packages/ai/src/schema.ts` succeeds; `grep -q "createAnthropic" packages/ai/src/client.ts` succeeds.
  </verify>
  <done>@ciintel/ai compiles; FindingSchema enforces evidence.min(1); client factory takes a per-installation apiKey.</done>
</task>

<task type="auto">
  <name>Task 2: analyzeFailure wrapper</name>
  <files>packages/ai/src/analyze.ts</files>
  <action>
Create `packages/ai/src/analyze.ts` per RESEARCH.md lines 552-631:

- Imports: `import { generateObject, NoObjectGeneratedError } from 'ai';` (top-level 'ai' only — NOT subpaths, per pitfall 4). `import { FindingSchema, type FindingOutput } from './schema.js';` `import { createAnthropicForInstallation, CLAUDE_MODEL } from './client.js';` `import type { DetectorType } from '@ciintel/core';`
- Define `SYSTEM_PROMPT` (lines 616-618) and `buildPrompt(logExcerpt, detectorType)` (lines 620-631). Evidence must be direct quotes from the log.
- `export type AnalyzeInput = { logExcerpt: string; detectorType: DetectorType; apiKey: string; };`
- `export type AnalyzeResult = { output: FindingOutput; usage: { promptTokens: number; completionTokens: number; totalTokens: number } };`
- `export async function analyzeFailure(input: AnalyzeInput): Promise<AnalyzeResult>`:
   - `const anthropic = createAnthropicForInstallation(input.apiKey);`
   - Call `generateObject({ model: anthropic(CLAUDE_MODEL), schema: FindingSchema, schemaName: 'CIFailureFinding', schemaDescription: 'Structured analysis of a CI failure', system: SYSTEM_PROMPT, prompt: buildPrompt(input.logExcerpt, input.detectorType), maxRetries: 2 })`.
   - Return `{ output: object, usage }` mapping the SDK usage fields to promptTokens/completionTokens/totalTokens. (If the ai@7 usage field names differ, e.g. inputTokens/outputTokens, map accordingly and add a short comment — the caller relies on promptTokens/completionTokens.)
   - Wrap in try/catch: if `NoObjectGeneratedError.isInstance(err)`, rethrow after attaching err.usage to the error message/log context (do NOT swallow). Otherwise rethrow.

CONSTRAINT: no logging of the apiKey; no Prisma/Octokit imports.
  </action>
  <verify>
`pnpm --filter @ciintel/ai build` exits 0; `grep -q "generateObject" packages/ai/src/analyze.ts`; `grep -q "claude-sonnet-5" packages/ai/src/client.ts`; `grep -q "NoObjectGeneratedError" packages/ai/src/analyze.ts`.
  </verify>
  <done>analyzeFailure calls generateObject with the FindingSchema and Sonnet 5, returns typed output + token usage, and handles NoObjectGeneratedError without persisting.</done>
</task>

<task type="auto">
  <name>Task 3: Token budget check + package index</name>
  <files>packages/ai/src/budget.ts, packages/ai/src/index.ts</files>
  <action>
1. Create `packages/ai/src/budget.ts` per RESEARCH.md lines 917-930:
   - `export type BudgetStatus = { exceeded: boolean; used: number; cap: number };`
   - `export async function checkTokenBudget(db: { $queryRaw: <T = unknown>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T> }, installationId: number): Promise<BudgetStatus>`:
     - `const cap = parseInt(process.env['CYCLOPS_MONTHLY_TOKEN_BUDGET'] ?? '1000000', 10);`
     - Run the tagged-template `$queryRaw` summing `inputTokens + outputTokens` from `token_usages` WHERE installationId matches AND `timestamp >= date_trunc('month', NOW())`. Result typed as `[{ total: bigint }]`.
     - `const used = Number(result[0]?.total ?? 0);` return `{ exceeded: used >= cap, used, cap }`.
   - Accept the db client as a loosely-typed parameter (structural type above) so @ciintel/ai does NOT import @ciintel/db — the worker passes its getTenantClient(installationId). This preserves package decoupling. Add a comment: caller MUST pass a tenant-scoped client so RLS + the WHERE both resolve correctly (pitfall 5).

2. Create `packages/ai/src/index.ts` re-exporting: FindingSchema + FindingOutput (schema.js), createAnthropicForInstallation + CLAUDE_MODEL (client.js), analyzeFailure + AnalyzeInput + AnalyzeResult (analyze.js), checkTokenBudget + BudgetStatus (budget.js).

Build the package.
  </action>
  <verify>
`pnpm --filter @ciintel/ai build` exits 0; `grep -q "date_trunc('month', NOW())" packages/ai/src/budget.ts`; `grep -q "checkTokenBudget" packages/ai/src/index.ts` and `grep -q "analyzeFailure" packages/ai/src/index.ts`; package.json has NO @ciintel/db dependency.
  </verify>
  <done>checkTokenBudget sums the current month's tokens against CYCLOPS_MONTHLY_TOKEN_BUDGET; index exports the full AI surface; @ciintel/ai stays decoupled from @ciintel/db.</done>
</task>

</tasks>

<verification>
- `pnpm --filter @ciintel/ai build` exits 0
- FindingSchema enforces evidence.min(1) and confidence 0..1
- analyzeFailure returns { output, usage } with token counts
- checkTokenBudget uses date_trunc month window; package does not import Prisma directly
</verification>

<success_criteria>
- Structured AI output guaranteed to carry confidence, evidence[], caveat (criterion 3)
- Exact token usage returned for TokenUsage recording (criterion 5)
- Monthly budget check reports exceeded when used >= cap (criterion 5)
- Per-installation BYOK key used per request; no global env key
</success_criteria>

<output>
After completion, create `.planning/phases/02-detector-pipeline-and-ai-analysis/02-03-SUMMARY.md`
</output>
