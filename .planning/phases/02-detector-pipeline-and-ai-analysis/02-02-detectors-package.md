---
phase: 02-detector-pipeline-and-ai-analysis
plan: 02
type: execute
wave: 2
depends_on: ["02-01"]
files_modified:
  - packages/detectors/package.json
  - packages/detectors/tsconfig.json
  - packages/detectors/src/types.ts
  - packages/detectors/src/log-utils.ts
  - packages/detectors/src/lint.ts
  - packages/detectors/src/build-failure.ts
  - packages/detectors/src/missing-env-var.ts
  - packages/detectors/src/expired-secret.ts
  - packages/detectors/src/flaky-test.ts
  - packages/detectors/src/test-failure.ts
  - packages/detectors/src/index.ts
  - pnpm-workspace.yaml
  - tsconfig.json

must_haves:
  truths:
    - "A failing ESLint/Prettier log yields a Lint DetectorResult with violated files and rule names"
    - "A previously-passing test now failing is classified FlakyTest (>=1 pass, >=2 fails); a first-time failure is not flaky"
    - "runAllDetectors runs FlakyTest before TestFailure and treats them as mutually exclusive"
    - "Unmatched failures produce no false-positive matches (Unknown is chosen by the caller)"
    - "All detectors are pure functions — no network, Octokit, Redis, or Prisma imports"
  artifacts:
    - path: "packages/detectors/src/index.ts"
      provides: "runAllDetectors + all 6 detector exports + log-utils"
      contains: "runAllDetectors"
    - path: "packages/detectors/src/lint.ts"
      provides: "detectLint + linter inference + violation extraction"
      contains: "detectLint"
    - path: "packages/detectors/src/flaky-test.ts"
      provides: "detectFlakyTest history threshold logic"
      contains: "detectFlakyTest"
    - path: "packages/detectors/src/log-utils.ts"
      provides: "stripLogFormatting, extractExcerpt, inferLinterFromWorkflow"
      contains: "stripLogFormatting"
  key_links:
    - from: "packages/detectors/src/index.ts"
      to: "@ciintel/core"
      via: "import DetectorType/DetectorResult/Violation types"
      pattern: "@ciintel/core"
    - from: "packages/detectors/src/index.ts"
      to: "detectFlakyTest before detectTestFailure"
      via: "priority-ordered runAllDetectors"
      pattern: "FlakyTest"
---

<objective>
Create the new `packages/detectors` package: pure functions for all 6 detectors plus log utilities and a priority-ordered `runAllDetectors` orchestrator. Detectors accept pre-fetched strings and return typed DetectorResult — no I/O whatsoever.

Purpose: This is the classification core. It must be unit-testable without mocking, satisfying success criteria 1 (Lint) and 2 (FlakyTest vs first-time failure).
Output: A compiling @ciintel/detectors package exporting runAllDetectors and each detector.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-RESEARCH.md

# Scaffold reference (mirror an existing pure package)
@packages/core/package.json
@packages/queue/package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Scaffold package + types + log-utils</name>
  <files>packages/detectors/package.json, packages/detectors/tsconfig.json, packages/detectors/src/types.ts, packages/detectors/src/log-utils.ts, pnpm-workspace.yaml, tsconfig.json</files>
  <action>
1. Create `packages/detectors/package.json` mirroring @ciintel/core's shape (name `@ciintel/detectors`, type module, exports ./dist/index.js + types, build/clean scripts). Dependencies: `@ciintel/core: workspace:*`, `js-yaml: ^4.1.0`, `strip-ansi: ^7.1.0`, `zod: ^3.24.0`. devDependencies: typescript ^5.8.0, @types/node ^22.0.0, `@types/js-yaml: ^4.0.9`.

2. Create `packages/detectors/tsconfig.json` extending ../../tsconfig.base.json (composite, project reference to ../core), matching the pattern of packages/queue/tsconfig.json (add a references entry for ../core).

3. Confirm `pnpm-workspace.yaml` globs already cover `packages/*` (they do) — no change needed unless it lists packages explicitly. If root `tsconfig.json` lists project references, add `{ "path": "packages/detectors" }`.

4. Create `packages/detectors/src/types.ts` re-exporting the shared shapes from @ciintel/core and adding the detector-input types from RESEARCH.md lines 113-134:
   - re-export DetectorType, DetectorResult, Violation from `@ciintel/core`
   - `export type CheckRunHistoryEntry = { conclusion: string | null };`
   - `export type DetectorInput = { logExcerpt: string; workflowYaml: string; jobName: string; checkRunHistory?: CheckRunHistoryEntry[]; };`
   - helper: `export function notMatched(detectorType: DetectorType): DetectorResult { return { detectorType, matched: false, violations: [], rawExcerpt: '' }; }`
   All relative imports use `.js` extensions.

5. Create `packages/detectors/src/log-utils.ts` per RESEARCH.md lines 397-436:
   - `import stripAnsi from 'strip-ansi';` and `import jsYaml from 'js-yaml';`
   - `stripLogFormatting(log)` → strip ISO timestamps `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm` then stripAnsi.
   - `extractExcerpt(log, anchorPattern, windowLines = 75)` → find first anchor line, slice ±window, fallback first 150 lines (cap total ~150 lines).
   - `inferLinterFromWorkflow(yaml)` → parse with jsYaml.load, recurse jobs[].steps[].run into a flat command list via `extractAllRunCommands`, test each LINTER_PATTERNS entry (ESLint, SwiftLint, ktlint, Rubocop, Prettier, Flake8, Pylint, Golangci, Detekt per lines 417-427). Return linter name or null. Guard against malformed YAML with try/catch returning null.

Run `pnpm install` at root so the workspace links, then `pnpm --filter @ciintel/detectors build`.
  </action>
  <verify>
`pnpm --filter @ciintel/detectors build` exits 0; `grep -q "stripLogFormatting" packages/detectors/src/log-utils.ts` and `grep -q "inferLinterFromWorkflow" packages/detectors/src/log-utils.ts` succeed; package.json has no dependency on Prisma/Octokit/ioredis.
  </verify>
  <done>@ciintel/detectors compiles; log-utils exposes stripLogFormatting, extractExcerpt, inferLinterFromWorkflow; types.ts defines DetectorInput + notMatched.</done>
</task>

<task type="auto">
  <name>Task 2: Pattern-based detectors (Lint, BuildFailure, MissingEnvVar, ExpiredSecret)</name>
  <files>packages/detectors/src/lint.ts, packages/detectors/src/build-failure.ts, packages/detectors/src/missing-env-var.ts, packages/detectors/src/expired-secret.ts</files>
  <action>
Create four pure detector files. Each imports DetectorInput/DetectorResult/notMatched from `./types.js` and log-utils from `./log-utils.js`.

1. `lint.ts` — `detectLint(input)`:
   - `inferLinterFromWorkflow(input.workflowYaml)`; if null → notMatched('Lint').
   - Use LINTER_VIOLATION_PATTERNS (RESEARCH.md lines 442-449) for the inferred linter. Run the pattern globally over input.logExcerpt, building Violation[] with { file, line, column, rule, message } from capture groups (fields present depend on linter; message always set).
   - Return { detectorType: 'Lint', matched: violations.length > 0, violations, rawExcerpt: input.logExcerpt }.
   Success criterion 1 requires ESLint/Prettier results to include violated files and rule names — ensure the ESLint pattern captures file + rule.

2. `build-failure.ts` — `detectBuildFailure(input)`:
   - Test input.logExcerpt against BUILD_FAILURE_ANCHORS (RESEARCH.md lines 492-500). matched if any anchor matches.
   - violations: collect the matching anchor lines as { message: line }.
   - rawExcerpt: input.logExcerpt.

3. `missing-env-var.ts` — `detectMissingEnvVar(input)`:
   - Scan every line of input.logExcerpt against MISSING_ENV_VAR_PATTERNS (RESEARCH.md lines 455-463). For each match, push Violation { message: line, rule: capturedVarName }.
   - matched if violations.length > 0.

4. `expired-secret.ts` — `detectExpiredSecret(input)`:
   - Scan lines against EXPIRED_SECRET_PATTERNS (RESEARCH.md lines 469-486). matched if any line matches; violations = matching lines as { message }.

Keep each detector under ~50 lines. No I/O, no async. Define the pattern constants locally in each file.
  </action>
  <verify>
`pnpm --filter @ciintel/detectors build` exits 0; each file exports its detect* function (`grep -l "export function detect" packages/detectors/src/{lint,build-failure,missing-env-var,expired-secret}.ts` lists all four).
  </verify>
  <done>Four pattern detectors compile; Lint returns file+rule violations; each returns a typed DetectorResult and performs no I/O.</done>
</task>

<task type="auto">
  <name>Task 3: History detectors + runAllDetectors orchestrator</name>
  <files>packages/detectors/src/flaky-test.ts, packages/detectors/src/test-failure.ts, packages/detectors/src/index.ts</files>
  <action>
1. `flaky-test.ts` — `detectFlakyTest(input)` per RESEARCH.md lines 509-521:
   - Define TEST_FAILURE_PATTERNS (test-runner failure markers: `/\d+ failing/i`, `/FAIL /, /✕/, /● .+ ›/, /AssertionError/i, /Test Suite.*failed/i` — a reasonable cross-framework set).
   - If no test-failure pattern in logExcerpt → notMatched('FlakyTest').
   - history = input.checkRunHistory ?? []; if history.length === 0 → notMatched (first-ever run is NOT flaky, per success criterion 2).
   - passes = history where conclusion === 'success'; fails = conclusion === 'failure'. `isFlaky = passes >= 1 && fails >= 2`.
   - Return { detectorType: 'FlakyTest', matched: isFlaky, violations: [], rawExcerpt: input.logExcerpt }.

2. `test-failure.ts` — `detectTestFailure(input)` per RESEARCH.md lines 524-534:
   - Same TEST_FAILURE_PATTERNS gate (export the constant from flaky-test.ts and import it, to keep one source of truth).
   - history = input.checkRunHistory ?? []; `isNewFailure = history.length === 0 || history.every(h => h.conclusion === 'failure')`.
   - Return { detectorType: 'TestFailure', matched: isNewFailure, ... }.

3. `index.ts` — the public surface:
   - Re-export all types from `./types.js` and utils from `./log-utils.js`.
   - Re-export each detect* function.
   - `export function runAllDetectors(input: DetectorInput): DetectorResult[]` — run detectors in PRIORITY ORDER and enforce FlakyTest/TestFailure mutual exclusivity:
     order = [detectLint, detectBuildFailure, detectMissingEnvVar, detectExpiredSecret, detectFlakyTest, detectTestFailure].
     Collect matched results. If a FlakyTest result matched, drop any TestFailure result (skip detectTestFailure entirely, or filter it out). This implements CONSTRAINT 5: FlakyTest checked before TestFailure, mutually exclusive.
     Return the array of matched results (may be empty — caller substitutes an 'Unknown' result).
  </action>
  <verify>
`pnpm --filter @ciintel/detectors build` exits 0; `grep -q "runAllDetectors" packages/detectors/src/index.ts` succeeds; `grep -q "detectFlakyTest" packages/detectors/src/index.ts` and the ordering places FlakyTest before TestFailure. Quick sanity: `node --input-type=module -e "import('@ciintel/detectors/dist/index.js').then(m=>console.log(typeof m.runAllDetectors))"` prints `function` (run from packages/detectors after build).
  </verify>
  <done>runAllDetectors runs the 6 detectors in priority order with FlakyTest-before-TestFailure exclusivity; first-time failures are not flaky; package compiles and exports the full surface.</done>
</task>

</tasks>

<verification>
- `pnpm --filter @ciintel/detectors build` exits 0
- Package has zero I/O dependencies (no Prisma, Octokit, ioredis in package.json)
- runAllDetectors exported; FlakyTest precedes TestFailure
- Lint detector surfaces file + rule for ESLint/Prettier
</verification>

<success_criteria>
- All 6 detectors implemented as pure functions returning DetectorResult
- FlakyTest requires >=1 pass and >=2 fails; empty history is never flaky (criterion 2)
- Lint returns violated files and rule names (criterion 1)
- runAllDetectors enforces mutual exclusivity and priority order
</success_criteria>

<output>
After completion, create `.planning/phases/02-detector-pipeline-and-ai-analysis/02-02-SUMMARY.md`
</output>
