---
phase: 04-public-sdk
plan: 02
subsystem: sdk
tags: [typescript, sdk, crypto, aes-256-gcm, idetector, detector-context, monorepo, turborepo, pnpm]

# Dependency graph
requires:
  - phase: 04-01
    provides: "@cyclops/* workspace packages after scope rename from @ciintel/*"
provides:
  - "@cyclops/internal private package holding AES-256-GCM encryptApiKey/decryptApiKey"
  - "@cyclops/core I/O-free: no node:crypto, no process.env, no octokit/redis/prisma"
  - "IDetector interface and DetectorContext type in @cyclops/core/src/detector.ts"
  - "DetectorInput = DetectorContext alias in @cyclops/detectors so 6 detector files compile unchanged"
affects:
  - 04-public-sdk (remaining plans depend on I/O-free core and IDetector interface)
  - apps/api and apps/worker (now depend on @cyclops/internal for crypto)

# Tech tracking
tech-stack:
  added: ["@cyclops/internal (new private workspace package)"]
  patterns:
    - "Private-package pattern: crypto utilities behind private:true package, never publishable"
    - "I/O-free SDK pattern: packages/core has zero node:crypto/process.env/octokit/redis/prisma"
    - "Type alias bridge: DetectorInput = DetectorContext allows consumer files to remain untouched during SDK extraction"

key-files:
  created:
    - packages/internal/package.json
    - packages/internal/tsconfig.json
    - packages/internal/src/crypto.ts
    - packages/internal/src/index.ts
    - packages/core/src/detector.ts
  modified:
    - packages/core/src/index.ts
    - packages/detectors/src/types.ts
    - apps/api/package.json
    - apps/api/tsconfig.json
    - apps/api/src/routes/setup.ts
    - apps/worker/package.json
    - apps/worker/tsconfig.json
    - apps/worker/src/workers/ai-analysis.ts

key-decisions:
  - "crypto moved to @cyclops/internal (private:true, never published) — node:crypto + process.env disqualify it from a publishable SDK package"
  - "DetectorType/Violation/DetectorResult relocated to detector.ts alongside IDetector/DetectorContext — avoids circular imports if detector.ts were to import from index.ts"
  - "DetectorInput kept as a type alias (not removed) — six detector implementation files reference DetectorInput; alias satisfies zero-change requirement"

patterns-established:
  - "SDK boundary rule: anything importing node:crypto or reading process.env belongs in @cyclops/internal, not @cyclops/core"
  - "IDetector contract: readonly detectorType + detect(context: DetectorContext): DetectorResult — pure function, no I/O"

# Metrics
duration: 3m 23s
completed: 2026-07-14
---

# Phase 4 Plan 02: Public SDK Type Surface Summary

**AES-256-GCM crypto extracted to private @cyclops/internal; @cyclops/core gains IDetector interface and DetectorContext type with zero I/O (no node:crypto, no process.env)**

## Performance

- **Duration:** 3m 23s
- **Started:** 2026-07-14T07:22:08Z
- **Completed:** 2026-07-14T07:25:31Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- Created `packages/internal` (private: true, never published) and moved AES-256-GCM encrypt/decrypt out of @cyclops/core — satisfies SDK-03 I/O-free guarantee
- Added `packages/core/src/detector.ts` with `IDetector` interface, `DetectorContext` type, and relocated `DetectorType`/`DetectorResult`/`Violation` — satisfies SDK-02 public detector contract
- Kept `DetectorInput` as a type alias for `DetectorContext` in @cyclops/detectors so all 6 detector implementation files compile with zero modifications

## Task Commits

Each task was committed atomically:

1. **Task 1: Create packages/internal and move crypto out of core** - `7ecddd8` (feat)
2. **Task 2: Add IDetector + DetectorContext to core and alias in detectors** - `fc436aa` (feat)

**Plan metadata:** (following this commit) (docs: complete plan)

## Files Created/Modified
- `packages/internal/package.json` - New private package manifest (private: true, @cyclops/internal)
- `packages/internal/tsconfig.json` - Composite TS config extending tsconfig.base.json
- `packages/internal/src/crypto.ts` - AES-256-GCM encrypt/decrypt (moved verbatim from core)
- `packages/internal/src/index.ts` - Barrel re-exporting encryptApiKey/decryptApiKey
- `packages/core/src/detector.ts` - IDetector interface, DetectorContext, DetectorResult, DetectorType, Violation
- `packages/core/src/index.ts` - Removed crypto export + DetectorType/Result/Violation definitions; re-exports ./detector.js
- `packages/detectors/src/types.ts` - DetectorInput now a type alias for DetectorContext from @cyclops/core
- `apps/api/src/routes/setup.ts` - Import encryptApiKey from @cyclops/internal (was @cyclops/core)
- `apps/worker/src/workers/ai-analysis.ts` - Import decryptApiKey from @cyclops/internal (was @cyclops/core)
- `apps/api/package.json` - Added @cyclops/internal workspace:* dependency
- `apps/api/tsconfig.json` - Added packages/internal reference
- `apps/worker/package.json` - Added @cyclops/internal workspace:* dependency
- `apps/worker/tsconfig.json` - Added packages/internal reference

## Decisions Made
- **crypto moved to @cyclops/internal (private: true):** `node:crypto` and `process.env` are I/O; they cannot live in a publishable SDK package. A dedicated private package is the cleanest boundary.
- **DetectorType/Violation/DetectorResult relocated to detector.ts:** Collocating all detector contract types in one file avoids circular import risk and makes the public API surface self-contained.
- **DetectorInput kept as alias, not removed:** Changing 6 detector files was explicitly out of scope per SDK-02 goal. A type alias satisfies structural compatibility with zero churn.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `pnpm exec tsc --build --noEmit` at the repo root fails with TS5083 (no root tsconfig.json) — this is pre-existing; per-package `tsc --build --noEmit` passes cleanly. Turborepo build serves as the canonical verification.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- @cyclops/core is now I/O-free and exports IDetector/DetectorContext/DetectorResult/DetectorType/Violation
- @cyclops/internal holds crypto utilities and is wired into both apps
- pnpm build passes across all 10 packages
- Ready for 04-03 (SDK entry point polish / README / publish config)

---
*Phase: 04-public-sdk*
*Completed: 2026-07-14*
