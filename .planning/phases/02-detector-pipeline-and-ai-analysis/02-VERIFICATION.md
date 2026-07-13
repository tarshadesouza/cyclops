---
phase: 02-detector-pipeline-and-ai-analysis
verified: 2026-07-13T14:18:32Z
status: passed
score: 5/5 must-haves verified
---

# Phase 2: Detector Pipeline and AI Analysis — Verification Report

**Phase Goal:** All 6 detectors classify CI failures from real GitHub Actions events, and the AI analysis layer enriches each finding with structured output including confidence, evidence, and caveat fields — no actions are executed yet.
**Verified:** 2026-07-13T14:18:32Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | ESLint/Prettier log yields a DetectorResult with violated files and rule names | VERIFIED | `lint.ts:31–37` extracts `file=match[1]`, `rule=match[6]` for ESLint; Prettier extracts `file` only (no rule — by design, Prettier has no rule system; `Violation.rule` is `?` optional) |
| 2 | Previously-passing test classified FlakyTest; first-time failure is not | VERIFIED | `flaky-test.ts:21` returns `notMatched` when `history.length === 0`; `isFlaky = passes >= 1 && fails >= 2` at line 25 |
| 3 | Every AI finding stored contains confidence, evidence[], caveat with evidence.min(1) | VERIFIED | `schema.ts:4–12` enforces `z.array(z.string()).min(1)` on evidence; worker writes all three fields at `ai-analysis.ts:113–118` |
| 4 | Auto-action workers receive no jobs when confidence < 0.85 | VERIFIED | `ai-analysis.ts:125` gate: `confidence >= 0.85 && evidence.length > 0` before `actionExecutionQueue.add` |
| 5 | Token usage records tagged with installationId, detectorId, model; monthly cap hard-stops further AI calls | VERIFIED | `ai-analysis.ts:93–101` writes all three tags; `checkTokenBudget` gate at line 54–65 returns `skipped` before the AI call |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/detectors/src/lint.ts` | ESLint/Prettier violation extraction | VERIFIED | 87 lines; exports `detectLint`; per-linter branch with file+rule extraction |
| `packages/detectors/src/flaky-test.ts` | Flaky vs first-time failure classification | VERIFIED | 28 lines; exports `detectFlakyTest`; empty-history guard on line 21 |
| `packages/detectors/src/build-failure.ts` | Build failure classification | VERIFIED | 34 lines; exports `detectBuildFailure` |
| `packages/detectors/src/missing-env-var.ts` | Missing env var classification | VERIFIED | 40 lines; exports `detectMissingEnvVar` |
| `packages/detectors/src/expired-secret.ts` | Expired secret classification | VERIFIED | 41 lines; exports `detectExpiredSecret` |
| `packages/detectors/src/test-failure.ts` | Test failure (non-flaky) classification | VERIFIED | 15 lines; exports `detectTestFailure` |
| `packages/detectors/src/index.ts` | `runAllDetectors` orchestrator | VERIFIED | FlakyTest runs before TestFailure, mutually exclusive; Unknown fallback for unmatched |
| `packages/ai/src/schema.ts` | `FindingSchema` with evidence.min(1) | VERIFIED | `z.array(z.string()).min(1)` on evidence; confidence, caveat all present |
| `packages/ai/src/analyze.ts` | `analyzeFailure` calling Anthropic API | VERIFIED | 64 lines; uses `generateObject` with `FindingSchema`; extracts usage tokens |
| `packages/ai/src/budget.ts` | `checkTokenBudget` per-installation monthly gate | VERIFIED | Raw SQL sums inputTokens+outputTokens for current month; returns `exceeded: used >= cap` |
| `apps/worker/src/workers/ai-analysis.ts` | AiAnalysisWorker — enriches findings, gates actions | VERIFIED | 178 lines; budget gate before AI call; writes all AI fields; 0.85 threshold gate before queue dispatch |
| `apps/worker/src/workers/detector-dispatch.ts` | DetectorDispatchWorker — runs detectors, creates findings | VERIFIED | 178 lines; fetches check run history; calls `runAllDetectors`; creates Finding; dispatches ai-analysis job |
| `packages/db/prisma/schema.prisma` | `Finding` model with confidence/evidence/caveat; `TokenUsage` with installationId/detectorId/model | VERIFIED | Finding has `confidence Float?`, `evidence String[]`, `caveat String?`; TokenUsage has `installationId Int`, `detectorId String`, `model String` |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `detector-dispatch.ts` | `runAllDetectors` | import from `@ciintel/detectors` | WIRED | Lines 11–12 import; called at line 87 with logExcerpt + workflowYaml + checkRunHistory |
| `detector-dispatch.ts` | `db.finding.create` | tenant-scoped Prisma client | WIRED | Lines 113–125; violations + rawExcerpt written from DetectorResult |
| `detector-dispatch.ts` | `aiAnalysisQueue.add` | BullMQ queue | WIRED | Lines 130–137; identifiers-only payload dispatched after Finding created |
| `ai-analysis.ts` | `checkTokenBudget` | import from `@ciintel/ai` | WIRED | Line 11 import; called at line 54; `budget.exceeded` hard-stops before AI call |
| `ai-analysis.ts` | `analyzeFailure` | import from `@ciintel/ai` | WIRED | Line 11 import; called at line 82 with logExcerpt + detectorType + apiKey |
| `ai-analysis.ts` | `db.tokenUsage.create` | tenant-scoped Prisma client | WIRED | Lines 93–101; writes installationId, detectorId, model, inputTokens, outputTokens |
| `ai-analysis.ts` | `db.finding.update` (enrich) | tenant-scoped Prisma client | WIRED | Lines 112–122; writes confidence, evidence, caveat, rootCause, suggestedFix, affectedFiles, severity |
| `ai-analysis.ts` | `actionExecutionQueue.add` | BullMQ queue | WIRED | Lines 131–138; only reached when `confidence >= 0.85 && evidence.length > 0` |
| `detectLint` | ESLint violation extraction | regex match[1] (file) + match[6] (rule) | WIRED | Lines 31–37; file and rule both extracted for ESLint |
| `detectFlakyTest` | `checkRunHistory` cross-reference | `input.checkRunHistory` | WIRED | Lines 22–25; passes/fails counts computed from history; `isFlaky = passes >= 1 && fails >= 2` |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/worker/src/workers/ai-analysis.ts` | 135 | `actionType: "phase3-placeholder"` | Info | Intentional — phase 2 goal explicitly states no actions executed yet; placeholder marks the phase 3 extension point |

No blockers or warnings found in core detector, AI, or worker logic.

---

### Observations (Non-Blocking)

**Prettier rule names:** The `detectLint` function for Prettier extracts `file` from `[warn] <filename>` log lines but does not populate `rule` — Prettier is a formatter with no rule system, making `rule` undefined. The `Violation.rule` field is typed `?` optional in `@ciintel/core`, so this is architecturally correct. The must-have specifies "ESLint or Prettier"; ESLint fully satisfies the file+rule requirement.

**FlakyTest violations array is always empty:** The DetectorResult for FlakyTest carries `violations: []` by design (specified in the plan). The historical pass/fail counts are used internally to compute `isFlaky` but are not stored in the result. Downstream AI analysis receives only the log excerpt for evidence extraction. This is the designed behavior per the plan spec.

**`fails >= 2` threshold:** The flaky classification requires at least 2 historical failures in addition to 1 historical pass. A test that has passed previously and fails for the first time (0 historical failures) is NOT classified as flaky. This is consistent with the plan's explicit spec (`passes >= 1 && fails >= 2`) and prevents false positives on newly broken tests.

---

## Summary

All 5 must-haves are verified against actual code. The 6 detectors are all substantive and wired into `runAllDetectors`. The `FindingSchema` enforces `evidence.min(1)`. The `AiAnalysisWorker` correctly gates on 0.85 confidence before dispatching to `actionExecutionQueue`, writes all AI fields to the Finding, and records token usage with all three required tags. The monthly budget gate in `checkTokenBudget` hard-stops AI calls when the per-installation cap is exceeded. No actions are executed in phase 2 — the `actionType: "phase3-placeholder"` in the action queue dispatch is the designed extension point.

---

_Verified: 2026-07-13T14:18:32Z_
_Verifier: Claude (gsd-verifier)_
