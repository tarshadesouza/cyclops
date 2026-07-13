---
phase: "02"
plan: "02"
name: "detectors-package"
subsystem: "classification"
tags: ["detectors", "pure-functions", "lint", "flaky-test", "build-failure", "log-parsing"]
status: "complete"

dependency_graph:
  requires: ["02-01"]
  provides: ["@ciintel/detectors package", "runAllDetectors orchestrator", "6 detector pure functions", "log-utils"]
  affects: ["02-03", "02-04"]

tech_stack:
  added:
    - "strip-ansi@^7.1.0 — ANSI escape code removal from CI logs"
    - "js-yaml@^4.1.0 — workflow YAML parsing for linter inference"
  patterns:
    - "Pure function detectors — no I/O, fully unit-testable without mocking"
    - "Priority-ordered orchestrator with mutual exclusivity (FlakyTest before TestFailure)"
    - "Single source of truth — TEST_FAILURE_PATTERNS shared between flaky and test-failure detectors"
    - "Composite tsconfig with project reference to ../core"

key_files:
  created:
    - "packages/detectors/package.json"
    - "packages/detectors/tsconfig.json"
    - "packages/detectors/src/types.ts"
    - "packages/detectors/src/log-utils.ts"
    - "packages/detectors/src/lint.ts"
    - "packages/detectors/src/build-failure.ts"
    - "packages/detectors/src/missing-env-var.ts"
    - "packages/detectors/src/expired-secret.ts"
    - "packages/detectors/src/flaky-test.ts"
    - "packages/detectors/src/test-failure.ts"
    - "packages/detectors/src/index.ts"
  modified:
    - "pnpm-lock.yaml"

decisions:
  - id: "02-02-a"
    decision: "TEST_FAILURE_PATTERNS exported from flaky-test.ts and imported by test-failure.ts"
    rationale: "Single source of truth avoids pattern drift between the two mutually exclusive detectors"
  - id: "02-02-b"
    decision: "detectLint returns matched: false when no linter inferred from workflow YAML"
    rationale: "Prevents false positives — if no linter command found in workflow, cannot classify as Lint"
  - id: "02-02-c"
    decision: "FlakyTest empty history returns notMatched (not flaky)"
    rationale: "First-ever run has no history to compare against — cannot be classified as flaky by definition"

metrics:
  tasks_completed: 3
  tasks_total: 3
  deviations: 0
  duration: "3m 1s"
  completed: "2026-07-13"
---

# Phase 02 Plan 02: Detectors Package Summary

**One-liner:** Pure-function @ciintel/detectors package with 6 pattern/history detectors, log-utils, and priority-ordered runAllDetectors orchestrator — zero I/O dependencies.

## What Was Built

The `@ciintel/detectors` package provides the classification core for the CyclOps pipeline. All detectors are pure functions that accept pre-fetched strings and return typed `DetectorResult` — no network, database, or Redis calls.

### Package structure

```
packages/detectors/
  src/
    types.ts          — re-exports from @ciintel/core + DetectorInput + notMatched helper
    log-utils.ts      — stripLogFormatting, extractExcerpt, inferLinterFromWorkflow
    lint.ts           — detectLint (infers linter from workflow YAML, extracts file+rule violations)
    build-failure.ts  — detectBuildFailure (TS errors, BUILD FAILED, go load errors)
    missing-env-var.ts — detectMissingEnvVar (captures var name as violation rule)
    expired-secret.ts — detectExpiredSecret (cert/token/API key expiry patterns)
    flaky-test.ts     — detectFlakyTest (>=1 pass + >=2 fails in history required)
    test-failure.ts   — detectTestFailure (shares TEST_FAILURE_PATTERNS from flaky-test)
    index.ts          — full public surface + runAllDetectors orchestrator
```

### runAllDetectors priority order

1. detectLint
2. detectBuildFailure
3. detectMissingEnvVar
4. detectExpiredSecret
5. detectFlakyTest (checked first in test group)
6. detectTestFailure (only if FlakyTest did not match — mutually exclusive)

Empty result means Unknown — the caller substitutes that classification.

## Success Criteria Met

- All 6 detectors implemented as pure functions returning DetectorResult
- FlakyTest requires >=1 pass and >=2 fails; empty history returns notMatched (criterion 2)
- Lint returns violated files and rule names for ESLint, SwiftLint, ktlint, Rubocop, Prettier, Golangci (criterion 1)
- runAllDetectors enforces mutual exclusivity and priority order
- Zero I/O dependencies (no Prisma, Octokit, or ioredis in package.json)

## Commits

| Hash    | Message |
|---------|---------|
| 96b90f8 | feat(02-02): scaffold @ciintel/detectors package with types and log-utils |
| d6dddd2 | feat(02-02): add pattern-based detectors (Lint, BuildFailure, MissingEnvVar, ExpiredSecret) |
| cc4d3d3 | feat(02-02): add history detectors and runAllDetectors orchestrator |

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

The `@ciintel/detectors` package is ready to be consumed by:
- `02-03`: AI analysis worker (imports runAllDetectors to classify before sending to LLM)
- `02-04`: Any unit test suite (pure functions need no mocking infrastructure)

No blockers or concerns.
