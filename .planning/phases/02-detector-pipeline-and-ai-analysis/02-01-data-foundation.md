---
phase: 02-detector-pipeline-and-ai-analysis
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/0003_phase2/migration.sql
  - packages/db/src/index.ts
  - packages/core/src/index.ts
  - packages/queue/src/jobs.ts
  - packages/queue/src/index.ts
autonomous: true

must_haves:
  truths:
    - "Finding rows can be created with detector output and later enriched with confidence/evidence/caveat"
    - "TokenUsage rows record installationId, detectorId, model, inputTokens, outputTokens per AI call"
    - "Installation can store an AES-256-GCM encrypted Anthropic API key"
    - "RLS isolates findings and token_usages per installation, with postgres service bypass"
    - "Shared detector/AI types are importable from @ciintel/core"
    - "AiAnalysisJob carries findingId (identifier only) — no log content or keys"
  artifacts:
    - path: "packages/db/prisma/schema.prisma"
      provides: "Finding + TokenUsage models, Installation.encryptedApiKey"
      contains: "model Finding"
    - path: "packages/db/prisma/migrations/0003_phase2/migration.sql"
      provides: "Tables, indexes, FKs, RLS policies for findings + token_usages"
      contains: "ENABLE ROW LEVEL SECURITY"
    - path: "packages/core/src/index.ts"
      provides: "DetectorType, Violation, DetectorResult, AiFinding, FindingSeverity types"
      contains: "DetectorType"
    - path: "packages/queue/src/jobs.ts"
      provides: "AiAnalysisJobSchema with findingId + detectorType"
      contains: "findingId"
  key_links:
    - from: "packages/db/prisma/migrations/0003_phase2/migration.sql"
      to: "current_installation_id()"
      via: "RLS USING clause"
      pattern: "current_installation_id\\(\\)"
    - from: "packages/queue/src/index.ts"
      to: "AiAnalysisJobSchema"
      via: "re-export"
      pattern: "AiAnalysisJobSchema"
---

<objective>
Establish the Phase 2 data foundation: Prisma models (Finding, TokenUsage), Installation.encryptedApiKey, an RLS migration matching the Phase 1 pattern, shared detector/AI types in @ciintel/core, and the AiAnalysisJob schema update carrying findingId.

Purpose: Everything downstream (detectors, AI package, both new workers, setup endpoint) depends on these types and tables existing. This is the single foundational wave.
Output: Migrated schema, generated Prisma client with new models, exported core types, updated queue job schema.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-CONTEXT.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-RESEARCH.md

# Existing patterns to follow exactly
@packages/db/prisma/schema.prisma
@packages/db/prisma/migrations/0002_rls/migration.sql
@packages/db/src/index.ts
@packages/core/src/index.ts
@packages/queue/src/jobs.ts
@packages/queue/src/index.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add Prisma models and generate client</name>
  <files>packages/db/prisma/schema.prisma, packages/db/src/index.ts</files>
  <action>
Edit `packages/db/prisma/schema.prisma`:

1. On the existing `Installation` model, add:
   - `encryptedApiKey String?` (AES-256-GCM encrypted Anthropic key; base64 iv+tag+ciphertext)
   - relation fields: `findings Finding[]` and `tokenUsages TokenUsage[]`

2. Add the `Finding` model exactly per RESEARCH.md "Prisma Schema Additions" (lines 773-812):
   - id String @id @default(uuid()); installationId Int; repositoryId Int; workflowRunId Int; checkRunId Int; detectorType String; sha String; ref String
   - violations Json @default("[]"); rawExcerpt String?
   - AI enrichment (all nullable/defaulted): confidence Float?; evidence String[] @default([]); caveat String?; rootCause String?; suggestedFix String?; affectedFiles String[] @default([]); severity String?
   - routing: aiEnrichedAt DateTime?; advancedToAction Boolean @default(false); budgetExceeded Boolean @default(false)
   - deletedAt DateTime?; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt
   - relation: installation Installation @relation(fields: [installationId], references: [id])
   - @@index([installationId]); @@index([workflowRunId]); @@index([installationId, createdAt]); @@map("findings")

3. Add the `TokenUsage` model per RESEARCH.md (lines 814-828):
   - id String @id @default(uuid()); installationId Int; detectorId String; model String; inputTokens Int; outputTokens Int; timestamp DateTime @default(now())
   - relation: installation Installation @relation(fields: [installationId], references: [id])
   - @@index([installationId]); @@index([installationId, timestamp]); @@map("token_usages")

4. Run `pnpm --filter @ciintel/db db:generate` to regenerate the Prisma client into ../src/generated.

5. In `packages/db/src/index.ts`, uncomment/extend the generated type re-export line to include the new models:
   `export type { Installation, WebhookDelivery, Finding, TokenUsage } from "./generated/index.js";`
   Keep existing getDb / getTenantClient exports untouched.

Do NOT use `prisma migrate dev` here (that would auto-author a migration that may diverge from the hand-written RLS migration in Task 2). Only run `db:generate`.
  </action>
  <verify>
`pnpm --filter @ciintel/db db:generate` exits 0; `grep -q "model Finding" packages/db/prisma/schema.prisma` and `grep -q "model TokenUsage" packages/db/prisma/schema.prisma` both succeed; `pnpm --filter @ciintel/db build` exits 0.
  </verify>
  <done>schema.prisma contains Finding, TokenUsage, and Installation.encryptedApiKey; generated client compiles; @ciintel/db re-exports the new types.</done>
</task>

<task type="auto">
  <name>Task 2: Write the 0003_phase2 RLS migration</name>
  <files>packages/db/prisma/migrations/0003_phase2/migration.sql</files>
  <action>
Create `packages/db/prisma/migrations/0003_phase2/migration.sql` using the exact SQL in RESEARCH.md lines 836-911. It must, in order:

1. `ALTER TABLE "installations" ADD COLUMN "encryptedApiKey" TEXT;`
2. `CREATE TABLE "findings" (...)` with all columns matching the Prisma model (TEXT[] with DEFAULT '{}' for evidence/affectedFiles, JSONB DEFAULT '[]' for violations, DOUBLE PRECISION for confidence, BOOLEAN DEFAULT false for advancedToAction/budgetExceeded, PK on id).
3. `CREATE TABLE "token_usages" (...)` with PK on id.
4. All five indexes (findings_installationId_idx, findings_workflowRunId_idx, findings_installationId_createdAt_idx, token_usages_installationId_idx, token_usages_installationId_timestamp_idx).
5. Foreign keys from both tables to installations(id) ON DELETE RESTRICT ON UPDATE CASCADE.
6. RLS block IDENTICAL in style to 0002_rls: ENABLE + FORCE ROW LEVEL SECURITY on both tables; tenant_isolation policies `USING ("installationId" = current_installation_id())`; service_bypass policies `TO "postgres" USING (true)`.

Reuse the `current_installation_id()` function already created in 0002_rls — do NOT redefine it.

Apply the migration against the dev database: `pnpm --filter @ciintel/db db:migrate` (prisma migrate deploy). If DATABASE_URL is not set in this environment, skip the apply step and note it — the SQL correctness is what matters; the verification checkpoint in plan 02-07 applies it against the real DB.
  </action>
  <verify>
File exists at `packages/db/prisma/migrations/0003_phase2/migration.sql`; `grep -c "ENABLE ROW LEVEL SECURITY" packages/db/prisma/migrations/0003_phase2/migration.sql` returns 2; `grep -q "current_installation_id()" packages/db/prisma/migrations/0003_phase2/migration.sql` succeeds; `grep -q "findings_installationId_fkey" packages/db/prisma/migrations/0003_phase2/migration.sql` succeeds.
  </verify>
  <done>Migration creates both tables with indexes, FKs, and RLS policies matching the 0002_rls pattern; encryptedApiKey column added to installations.</done>
</task>

<task type="auto">
  <name>Task 3: Add core types and update queue job schema</name>
  <files>packages/core/src/index.ts, packages/queue/src/jobs.ts, packages/queue/src/index.ts</files>
  <action>
1. In `packages/core/src/index.ts`, APPEND the shared types from RESEARCH.md lines 973-1008 (keep existing InstallationId/TenantContext):
   - `export type DetectorType = 'Lint' | 'FlakyTest' | 'BuildFailure' | 'TestFailure' | 'MissingEnvVar' | 'ExpiredSecret' | 'Unknown';`
   - `export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';`
   - `export type Violation = { message: string; file?: string; line?: number; column?: number; rule?: string; };`
   - `export type DetectorResult = { detectorType: DetectorType; matched: boolean; violations: Violation[]; rawExcerpt: string; };`
   - `export type AiFinding = { confidence: number; evidence: string[]; caveat: string; rootCause: string; suggestedFix: string; affectedFiles: string[]; severity: FindingSeverity; detectorType: DetectorType; };`
   CONSTRAINT: core must stay I/O-free — do NOT import Octokit, Redis, or Prisma. These are pure types only.

2. In `packages/queue/src/jobs.ts`, REPLACE the existing `AiAnalysisJobSchema` with the RESEARCH.md version (lines 716-723):
   ```
   export const AiAnalysisJobSchema = z.object({
     installationId: z.number().int().positive(),
     repositoryId:   z.number().int().positive(),
     checkRunId:     z.number().int().positive(),
     findingId:      z.string().uuid(),
     detectorType:   z.string(),
     sha:            z.string().length(40),
   });
   ```
   (Removes `failureType`, adds `findingId` + `detectorType`.) Leave the other three job schemas unchanged. CONSTRAINT: identifiers only — do not add fields for log content or API keys.

3. `packages/queue/src/index.ts` already re-exports AiAnalysisJob/AiAnalysisJobSchema — confirm no change needed (the names are unchanged).

4. Build both packages to confirm type correctness.
  </action>
  <verify>
`grep -q "export type DetectorType" packages/core/src/index.ts` and `grep -q "export type AiFinding" packages/core/src/index.ts` succeed; `grep -q "findingId" packages/queue/src/jobs.ts` succeeds; `pnpm --filter @ciintel/core build` and `pnpm --filter @ciintel/queue build` both exit 0.
  </verify>
  <done>@ciintel/core exports DetectorType, Violation, DetectorResult, AiFinding, FindingSeverity; AiAnalysisJobSchema carries findingId + detectorType; both packages compile.</done>
</task>

</tasks>

<verification>
- `pnpm --filter @ciintel/db build && pnpm --filter @ciintel/core build && pnpm --filter @ciintel/queue build` all exit 0
- Prisma schema contains Finding, TokenUsage, encryptedApiKey
- Migration 0003_phase2 has both tables with RLS + FKs + indexes
- AiAnalysisJobSchema requires a UUID findingId
</verification>

<success_criteria>
- New models generate a compiling Prisma client
- RLS migration matches 0002_rls conventions exactly (tenant isolation + postgres bypass)
- Shared types available from @ciintel/core with no I/O imports
- Queue job schema carries findingId (identifier only)
</success_criteria>

<output>
After completion, create `.planning/phases/02-detector-pipeline-and-ai-analysis/02-01-SUMMARY.md`
</output>
