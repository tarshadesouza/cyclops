---
phase: 02-detector-pipeline-and-ai-analysis
plan: "03"
subsystem: ai
tags: [anthropic, claude, vercel-ai-sdk, zod, generateObject, token-budget, byok]

# Dependency graph
requires:
  - phase: 02-01
    provides: DetectorType and FindingSeverity types from @ciintel/core; Finding + TokenUsage Prisma models
provides:
  - "@ciintel/ai package: FindingSchema (Zod, evidence.min(1)), analyzeFailure (generateObject + Claude Sonnet 5), checkTokenBudget (monthly cap via date_trunc), createAnthropicForInstallation (per-request BYOK factory)"
affects:
  - 02-detector-pipeline-and-ai-analysis (worker plans that call analyzeFailure and checkTokenBudget)
  - 03-github-app-and-comment-engine (needs FindingOutput to render PR comments)

# Tech tracking
tech-stack:
  added:
    - "ai@7.0.18 (Vercel AI SDK v7)"
    - "@ai-sdk/anthropic@4.0.10"
    - "zod@^3.25.76 (upgraded from plan's ^3.24.0 to satisfy ai@7 peer dep)"
  patterns:
    - "Per-request BYOK: createAnthropicForInstallation(apiKey) — never read process.env for API key in @ciintel/ai"
    - "Loose db interface: checkTokenBudget accepts {$queryRaw} duck type — @ciintel/ai stays decoupled from @ciintel/db"
    - "Token field mapping: ai@7 inputTokens/outputTokens mapped to promptTokens/completionTokens in AnalyzeResult"

key-files:
  created:
    - packages/ai/package.json
    - packages/ai/tsconfig.json
    - packages/ai/src/schema.ts
    - packages/ai/src/client.ts
    - packages/ai/src/analyze.ts
    - packages/ai/src/budget.ts
    - packages/ai/src/index.ts
  modified:
    - pnpm-lock.yaml

key-decisions:
  - "ai@7.0.18 + @ai-sdk/anthropic@4.0.10 — plan specified ^7.0.19 (non-existent) and ^2.0.0 (incompatible); both resolved to latest compatible versions"
  - "zod@^3.25.76 — ai@7 peer dep requires >=3.25.76; plan's ^3.24.0 would fail peer dependency resolution"
  - "ai@7 renamed promptTokens→inputTokens, completionTokens→outputTokens — mapped back in AnalyzeResult with comment for callers"
  - "NoObjectGeneratedError.usage is LanguageModelUsage|undefined in ai@7 — confirmed type-safe re-throw pattern"

patterns-established:
  - "BYOK factory: createAnthropicForInstallation called per-request, never singleton — allows rotation without restart"
  - "Budget isolation: @ciintel/ai takes a duck-typed db client, never imports Prisma directly"

# Metrics
duration: 5min
completed: 2026-07-13
---

# Phase 2 Plan 03: @ciintel/ai Package Summary

**Zod-enforced AI enrichment layer: generateObject with Claude Sonnet 5, per-installation BYOK factory, and monthly token budget cap via date_trunc — fully decoupled from @ciintel/db**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-07-13T11:20:44Z
- **Completed:** 2026-07-13T11:25:29Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- FindingSchema with `evidence.min(1)` guarantees structured AI output always carries at least one evidence quote
- `analyzeFailure` wraps `generateObject` (Claude Sonnet 5, maxRetries=2) and surfaces exact token counts as `{ promptTokens, completionTokens, totalTokens }`
- `checkTokenBudget` queries the current calendar month via `date_trunc('month', NOW())` and reports exceeded/used/cap
- `createAnthropicForInstallation(apiKey)` creates a per-request Anthropic client — no global env key, supports BYOK rotation

## Task Commits

1. **Task 1: Scaffold package + schema + client** - `d5e7082` (feat)
2. **Task 2: analyzeFailure wrapper** - `4a64b64` (feat)
3. **Task 3: Token budget check + package index** - `891a78c` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified
- `packages/ai/package.json` - @ciintel/ai module definition with ai@7.0.18, @ai-sdk/anthropic@4.0.10, zod@^3.25.76
- `packages/ai/tsconfig.json` - Composite tsconfig with ../core project reference
- `packages/ai/src/schema.ts` - FindingSchema (confidence 0..1, evidence.min(1), severity enum, detectorType enum)
- `packages/ai/src/client.ts` - createAnthropicForInstallation(apiKey), CLAUDE_MODEL='claude-sonnet-5'
- `packages/ai/src/analyze.ts` - analyzeFailure(input) → { output, usage }; maps ai@7 field names
- `packages/ai/src/budget.ts` - checkTokenBudget(db, installationId) with date_trunc month window
- `packages/ai/src/index.ts` - Re-exports full @ciintel/ai surface
- `pnpm-lock.yaml` - Updated with new ai/anthropic/zod dependencies

## Decisions Made

- **ai@7.0.18 used instead of plan's ^7.0.19**: 7.0.19 does not exist in npm registry; 7.0.18 is the latest stable.
- **@ai-sdk/anthropic@4.0.10 used instead of plan's ^2.0.0**: @ai-sdk/anthropic is now on major version 4 (not 2); provider packages follow ai@7 compatibility matrix independently.
- **zod@^3.25.76 used instead of plan's ^3.24.0**: ai@7 declares peer dependency `zod: '^3.25.76 || ^4.1.8'`; ^3.24.0 would fail peer resolution.
- **Token field mapping**: ai@7's `LanguageModelUsage` uses `inputTokens`/`outputTokens`/`totalTokens` (not `promptTokens`/`completionTokens`); AnalyzeResult normalizes to the plan-specified names for stable caller API.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected package versions to match npm registry and ai@7 peer deps**
- **Found during:** Task 1 (package.json creation)
- **Issue:** Plan specified `ai: ^7.0.19` (non-existent), `@ai-sdk/anthropic: ^2.0.0` (now major version 4), `zod: ^3.24.0` (fails ai@7 peer dep `^3.25.76`)
- **Fix:** Used `ai@^7.0.18`, `@ai-sdk/anthropic@^4.0.10`, `zod@^3.25.76` — all verified compatible via npm show and peerDependencies inspection
- **Files modified:** packages/ai/package.json
- **Verification:** `pnpm install` resolved cleanly; `pnpm --filter @ciintel/ai build` exits 0
- **Committed in:** d5e7082 (Task 1 commit)

**2. [Rule 1 - Bug] Mapped ai@7 renamed usage fields to plan's expected field names**
- **Found during:** Task 2 (analyze.ts implementation)
- **Issue:** ai@7 renamed `promptTokens` → `inputTokens` and `completionTokens` → `outputTokens` in `LanguageModelUsage`; using plan's names directly would cause TypeScript errors
- **Fix:** Mapped `usage.inputTokens ?? 0` → `promptTokens`, `usage.outputTokens ?? 0` → `completionTokens` in AnalyzeResult; added explanatory comment in source
- **Files modified:** packages/ai/src/analyze.ts
- **Verification:** TypeScript compilation succeeds; no `any` casts needed
- **Committed in:** 4a64b64 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking version mismatch, 1 API rename bug)
**Impact on plan:** Both fixes required for compilation and correct dependency resolution. No scope creep — all plan requirements satisfied exactly.

## Issues Encountered

None beyond the version/field-name deviations documented above.

## User Setup Required

None — no external service configuration required for this package itself.
Set `CYCLOPS_MONTHLY_TOKEN_BUDGET` env var to override the default 1,000,000 token monthly cap.

## Next Phase Readiness

- `@ciintel/ai` compiles cleanly and exports the full AI surface
- Worker plans can import `analyzeFailure` (pass decrypted apiKey + DetectorType + logExcerpt)
- Worker plans can import `checkTokenBudget` (pass tenant-scoped Prisma client + installationId)
- Token field names in AnalyzeResult (`promptTokens`, `completionTokens`, `totalTokens`) are stable for TokenUsage recording
- No blockers for proceeding to the AI worker integration plan

---
*Phase: 02-detector-pipeline-and-ai-analysis*
*Completed: 2026-07-13*
