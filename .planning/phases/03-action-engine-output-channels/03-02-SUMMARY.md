---
phase: 03-action-engine-output-channels
plan: "02"
subsystem: config
tags: [zod, js-yaml, ttl-cache, kill-switches, cyclops-config, esm]

# Dependency graph
requires:
  - phase: 03-action-engine-output-channels/03-01
    provides: Phase 3 queue schema with strict ACTION_TYPES enum and ActionExecutionJobSchema
provides:
  - "@ciintel/config package: CyclopsConfigSchema (Zod, I/O-free) with all defaults"
  - "fetchConfig loader: fetches .cyclops.yml from GitHub, parses with js-yaml, TTL-caches 60s per (repositoryId, ref)"
  - "Zero-config support: CyclopsConfigSchema.parse({}) returns all defaults without throwing"
  - "Kill-switch flags for Phase 3 action handlers: autofix, checkRuns, prComments, githubIssues, detectors.*"
affects:
  - 03-action-engine-output-channels/03-03
  - 03-action-engine-output-channels/03-04
  - 03-action-engine-output-channels/03-05
  - 03-action-engine-output-channels/03-06
  - 03-action-engine-output-channels/03-07

# Tech tracking
tech-stack:
  added:
    - js-yaml@^4.1.0 (YAML parsing in @ciintel/config)
    - "@types/js-yaml@^4.0.9 (dev dep)"
  patterns:
    - "Dependency-injection for octokit in fetchConfig — accepts duck-typed interface, no direct @ciintel/github import"
    - "TTL cache pattern: Map<string, {value, expiresAt}> keyed by 'repositoryId:ref'"
    - "Zero-config defaults via Zod .default({}) chain on nested objects"

key-files:
  created:
    - packages/config/package.json
    - packages/config/tsconfig.json
    - packages/config/src/schema.ts
    - packages/config/src/loader.ts
    - packages/config/src/index.ts
  modified:
    - apps/worker/package.json
    - apps/worker/tsconfig.json
    - apps/worker/src/workers/ai-analysis.ts

key-decisions:
  - "fetchConfig uses duck-typed octokit interface — no direct @ciintel/github dep in loader.ts; caller passes octokit instance"
  - "yaml.load() used (not yaml.safeLoad()) — js-yaml v4 removed safeLoad; yaml.load() is the v4 API"
  - "On any fetch/parse error, fall back to CyclopsConfigSchema.parse({}) — zero-config CFG-04 requirement"
  - "detectorType→actionType mapping in ai-analysis.ts: lint→create-autofix-pr-lint, else→update-check-run"

patterns-established:
  - "Config schema is I/O-free: schema.ts imports only zod, never @ciintel/github or fs"
  - "Config fetched once per job, cached 60s per (repositoryId:ref) key for kill-switch reads"

# Metrics
duration: 4m 22s
completed: 2026-07-13
---

# Phase 3 Plan 02: Config Package Summary

**Zod-validated .cyclops.yml schema with 60s TTL cache loader — zero-config defaults (parse({}) never throws), yaml.load() safe fallback on 404/invalid YAML, importable by apps/worker**

## Performance

- **Duration:** 4m 22s
- **Started:** 2026-07-13T15:12:33Z
- **Completed:** 2026-07-13T15:16:55Z
- **Tasks:** 2 completed
- **Files modified:** 8

## Accomplishments

- Created `@ciintel/config` package: I/O-free Zod schema + TTL-cached fetchConfig loader
- `CyclopsConfigSchema.parse({})` returns all defaults (autofix, checkRuns, prComments, githubIssues, all detectors enabled) without throwing
- fetchConfig falls back to defaults on any error (404, invalid YAML, schema mismatch) per CFG-04
- 60s TTL cache keyed by `repositoryId:ref` prevents redundant GitHub API calls per job
- apps/worker updated with `@ciintel/config` workspace dep and tsconfig reference

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold packages/config with Zod schema** - `66a4bd6` (feat)
2. **Task 2: Config loader with TTL cache and wire into worker** - `7126df5` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `packages/config/package.json` - ESM package, js-yaml + zod deps
- `packages/config/tsconfig.json` - extends tsconfig.base.json, composite
- `packages/config/src/schema.ts` - CyclopsConfigSchema with all defaults (I/O-free)
- `packages/config/src/loader.ts` - fetchConfig with 60s TTL cache, yaml.load(), fallback to defaults
- `packages/config/src/index.ts` - re-exports schema and loader
- `apps/worker/package.json` - added @ciintel/config workspace dep
- `apps/worker/tsconfig.json` - added packages/config tsconfig reference
- `apps/worker/src/workers/ai-analysis.ts` - bug fixes (see deviations)

## Decisions Made

- fetchConfig accepts a duck-typed octokit parameter `{ request: ... }` rather than importing `@ciintel/github` — keeps config package's octokit dependency as an optional peer that callers provide, enabling unit testing without GitHub credentials
- On any catch in fetchConfig (network, 404, invalid YAML, Zod validation failure), return `CyclopsConfigSchema.parse({})` defaults — this satisfies CFG-04 zero-config and makes config robust to misconfigured repos

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ai-analysis.ts broken by Phase 3 queue schema strict actionType enum**

- **Found during:** Task 2 (building apps/worker)
- **Issue:** Phase 3 plan 03-01 changed `ActionExecutionJobSchema.actionType` from `z.string()` to `z.enum(ACTION_TYPES)`, but ai-analysis.ts still used `"phase3-placeholder"` (not in enum). Also `actionParams: { findingId }` was passed but ActionExecutionJobSchema has no `actionParams` field — findingId is a direct schema field.
- **Fix:** Destructured `detectorType` from parsed job data; added mapping `lint → 'create-autofix-pr-lint'`, else `→ 'update-check-run'`; replaced `actionParams: { findingId }` with direct `findingId` field
- **Files modified:** `apps/worker/src/workers/ai-analysis.ts`
- **Verification:** `pnpm --filter @ciintel/worker build` exits 0
- **Committed in:** `7126df5` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Essential fix — worker build was broken by Phase 3 queue schema upgrade. No scope creep; routing logic (detectorType → actionType) is exactly what Phase 3 action handlers require.

## Issues Encountered

None beyond the auto-fixed deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@ciintel/config` package is complete and importable by all Phase 3 action handlers
- Kill-switch flags (`autofix`, `checkRuns`, `prComments`, `githubIssues`, `detectors.*`) available for all output channel handlers in plans 03-03 through 03-07
- apps/worker builds cleanly with the config package linked
- Action handlers should call `fetchConfig(octokit, owner, repo, ref, repositoryId)` at job start, before any output action

---
*Phase: 03-action-engine-output-channels*
*Completed: 2026-07-13*
