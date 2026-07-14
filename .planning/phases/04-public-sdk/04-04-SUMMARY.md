---
phase: 04-public-sdk
plan: "04"
subsystem: infra
tags: [publint, attw, arethetypeswrong, ci, sdk-validation, esm, cjs, dual-format]

# Dependency graph
requires:
  - phase: 04-03
    provides: tsup dual ESM/CJS build for @cyclops/core with exports map
provides:
  - publint --strict passes against @cyclops/core dist
  - attw --pack reports all resolutions green (node10/node16/bundler)
  - validate-sdk CI job blocking gate on every push/PR to main
affects:
  - 04-05
  - publish workflow

# Tech tracking
tech-stack:
  added:
    - publint@^0.3.0 (pkg publish linting)
    - "@arethetypeswrong/cli@^0.18.5 (type resolution validation)"
  patterns:
    - lint:publish script in package.json invoking both tools
    - validate-sdk CI job chained with needs: build

key-files:
  created: []
  modified:
    - packages/core/package.json
    - .github/workflows/ci.yml

key-decisions:
  - "attw@^0.18.5 required — 0.17.x and below crash on Node.js v25 due to fflate Gunzip streaming incompatibility in @andrewbranch/untar.js"
  - "engines.node >= 22 added — required for publint --strict to suppress missing-engines suggestion"
  - "repository.url uses git+ prefix — required for publint --strict to suppress url-format suggestion"
  - "validate-sdk job has no continue-on-error — hard gate; any publint/attw error fails the workflow"

patterns-established:
  - "lint:publish = publint --strict && attw --pack . (run in order; publint first for fast feedback)"

# Metrics
duration: 19min
completed: 2026-07-14
---

# Phase 4 Plan 04: SDK Validation Gate Summary

**publint + attw wired into @cyclops/core as lint:publish script and validate-sdk CI hard gate; all four export resolutions green**

## Performance

- **Duration:** 19 min
- **Started:** 2026-07-14T07:36:27Z
- **Completed:** 2026-07-14T07:55:18Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- `publint --strict` reports "All good!" against the current @cyclops/core dist
- `attw --pack` reports no problems (node10, node16 CJS, node16 ESM, bundler all green)
- `validate-sdk` CI job added to ci.yml with `needs: build` as a hard blocking gate
- Gate runs on every push and PR targeting `main`

## Task Commits

Each task was committed atomically:

1. **Task 1: Add publint + attw scripts to @cyclops/core** - `36f5f8e` (feat)
2. **Task 2: Wire validate-sdk gate into ci.yml** - `133dac3` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `packages/core/package.json` - Added `lint:publish` script, `publint`/`@arethetypeswrong/cli` devDependencies, `engines.node >= 22`, `git+` repository URL prefix
- `.github/workflows/ci.yml` - Added `validate-sdk` job (needs: build) with 5 steps: checkout, pnpm, node 22, install, build core, lint:publish

## Decisions Made

- **attw@^0.18.5 pinned:** attw 0.17.x and 0.15.x both crash on Node.js v25 (`Cannot read properties of undefined (reading 'filename')`). Root cause: fflate Gunzip streaming API behavior changed in Node.js v25, causing `unzipped` to be undefined when `@andrewbranch/untar.js` attempts to extract it. 0.18.5 resolves this.
- **engines.node >= 22 added:** Without this field, `publint --strict` elevates "missing engines field" to an error. Node 22 chosen as the floor (matches CI and tsup target).
- **repository.url git+ prefix:** `publint --strict` requires the full git URL protocol prefix (`git+https://`). The original `https://` format passes in non-strict mode but fails strict.
- **No continue-on-error:** Per plan spec — validate-sdk is a hard gate. Workflow fails on any error.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Upgraded attw from ^0.17.0 to ^0.18.5 due to Node.js v25 incompatibility**

- **Found during:** Task 1 (running lint:publish)
- **Issue:** `attw --pack .` crashes with `Cannot read properties of undefined (reading 'filename')` on Node.js v25 for all versions 0.15.1–0.17.4. The fflate `Gunzip` streaming callback behavior changed in Node.js v25, leaving `unzipped` undefined when `untar.js` is called.
- **Fix:** Updated `@arethetypeswrong/cli` version spec from `^0.17.0` to `^0.18.5` (latest release). Version 0.18.5 resolves the issue.
- **Files modified:** `packages/core/package.json`, `pnpm-lock.yaml`
- **Verification:** `attw --pack .` exits 0 and prints "No problems found" with all four resolution rows green
- **Committed in:** `36f5f8e` (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added engines.node and fixed repository.url for publint --strict compliance**

- **Found during:** Task 1 (first lint:publish run)
- **Issue:** `publint --strict` elevated two suggestions to errors: (a) missing `engines.node` field, (b) `repository.url` missing `git+` protocol prefix
- **Fix:** Added `"engines": { "node": ">=22" }` and changed `repository.url` from `https://...` to `git+https://...`
- **Files modified:** `packages/core/package.json`
- **Verification:** `publint --strict` reports "All good!" after fixes
- **Committed in:** `36f5f8e` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 version pin fix, 1 metadata compliance fix)
**Impact on plan:** Both fixes necessary to achieve the zero-error requirement. No scope creep.

## Issues Encountered

- Node.js v25 incompatibility in attw 0.17.x was the primary blocker. Tested versions 0.17.4, 0.15.1, and 0.18.5 before finding a working release. No issue with the package structure itself — all errors were tooling-side.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- @cyclops/core is fully validated: ESM+CJS dual build, correct exports map, zero publint/attw errors
- CI will block any future publish candidate that introduces type resolution regressions
- Ready for 04-05 (npm publish pipeline / OIDC trusted publisher setup)

---
*Phase: 04-public-sdk*
*Completed: 2026-07-14*
