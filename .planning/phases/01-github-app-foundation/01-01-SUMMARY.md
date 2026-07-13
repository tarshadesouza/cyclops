---
phase: 01-github-app-foundation
plan: 01
subsystem: monorepo
tags: [pnpm, turborepo, typescript, monorepo, ci, github-actions]
requires: []
provides:
  - pnpm workspace with apps/* and packages/* globs
  - Turborepo 2 task graph (build/dev/test/lint)
  - Strict TypeScript base config (nodenext, es2025, composite)
  - All 6 package scaffolds with stub sources
  - GitHub Actions CI workflow
affects:
  - 01-02-database-layer (packages/db scaffold ready)
  - 01-03-queue-and-github-packages (packages/queue and packages/github scaffolds ready)
  - 01-04-webhook-receiver (apps/api scaffold ready)
  - 01-05-webhook-worker (apps/worker scaffold ready)
tech-stack:
  added:
    - pnpm@9.15.0
    - turbo@2.10.4
    - typescript@5.9.3
  patterns:
    - Turborepo 2 monorepo with tasks key schema
    - TypeScript composite project references (nodenext module resolution)
    - pnpm workspace cross-package linking via workspace:*
key-files:
  created:
    - pnpm-workspace.yaml
    - turbo.json
    - tsconfig.base.json
    - package.json
    - .npmrc
    - .gitignore
    - pnpm-lock.yaml
    - apps/api/package.json
    - apps/api/tsconfig.json
    - apps/api/src/index.ts
    - apps/worker/package.json
    - apps/worker/tsconfig.json
    - apps/worker/src/index.ts
    - packages/core/package.json
    - packages/core/tsconfig.json
    - packages/core/src/index.ts
    - packages/db/package.json
    - packages/db/tsconfig.json
    - packages/db/src/index.ts
    - packages/github/package.json
    - packages/github/tsconfig.json
    - packages/github/src/index.ts
    - packages/queue/package.json
    - packages/queue/tsconfig.json
    - packages/queue/src/index.ts
    - .github/workflows/ci.yml
  modified: []
decisions:
  - key: turborepo-v2-schema
    value: "Used tasks key (not pipeline) per Turborepo 2 schema; pipeline key is deprecated and silently ignored in v2"
  - key: nodenext-module-resolution
    value: "module: nodenext + moduleResolution: nodenext required for .js extensions in ESM imports; TypeScript nodenext requires explicit .js extensions on all relative imports"
  - key: composite-true
    value: "composite: true + incremental: true in base tsconfig enables tsc --build project references for correct cross-package build ordering"
metrics:
  duration: "3m 8s"
  completed: "2026-07-13"
---

# Phase 1 Plan 1: Monorepo Scaffold Summary

**One-liner:** pnpm 9 + Turborepo 2 monorepo with 6 typed packages (api, worker, core, db, github, queue), strict nodenext TypeScript base config, and GitHub Actions CI using pnpm/action-setup@v4.

## Tasks Completed

| # | Task | Commit | Key Files |
|---|------|--------|-----------|
| 1 | Root workspace config — pnpm-workspace, turbo.json, root tsconfig, root package.json | 03da9e6 | pnpm-workspace.yaml, turbo.json, tsconfig.base.json, package.json, .npmrc, .gitignore |
| 2 | All 6 package/app scaffolds with package.json, tsconfig.json, and stub index files | d1de2eb | apps/api/*, apps/worker/*, packages/core/*, packages/db/*, packages/github/*, packages/queue/*, pnpm-lock.yaml |
| 3 | GitHub Actions CI workflow | d9e5e7a | .github/workflows/ci.yml |

## Files Created

**Root config:**
- `/Users/tsouza/Projects/ciintel/pnpm-workspace.yaml` — workspace globs (apps/*, packages/*)
- `/Users/tsouza/Projects/ciintel/turbo.json` — Turborepo 2 tasks schema with build/dev/test/lint
- `/Users/tsouza/Projects/ciintel/tsconfig.base.json` — strict TypeScript, module: nodenext, target: es2025, composite: true
- `/Users/tsouza/Projects/ciintel/package.json` — private root, pnpm@9.15.0, turbo + typescript devDeps
- `/Users/tsouza/Projects/ciintel/.npmrc` — shamefully-hoist=false
- `/Users/tsouza/Projects/ciintel/.gitignore`

**Apps:**
- `apps/api/` — @ciintel/api (Fastify webhook receiver stub)
- `apps/worker/` — @ciintel/worker (BullMQ worker process stub)

**Packages:**
- `packages/core/` — @ciintel/core (I/O-free: InstallationId, TenantContext types)
- `packages/db/` — @ciintel/db (Prisma 7 + adapter-pg stub)
- `packages/github/` — @ciintel/github (Octokit App stub)
- `packages/queue/` — @ciintel/queue (BullMQ queue definitions stub)

**CI:**
- `.github/workflows/ci.yml` — pnpm/action-setup@v4, Node.js 22, frozen lockfile install, turbo build, tsc --build --noEmit

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Turborepo 2 tasks key | v2 deprecated the pipeline key; using tasks key prevents silent failures in future turbo upgrades |
| module: nodenext + moduleResolution: nodenext | Required for full ESM correctness in Node.js 22; all downstream packages use .js extensions on relative imports |
| composite: true across all packages | Enables tsc --build project references; correct build ordering without Turborepo needing to know about TypeScript internals |
| pnpm shamefully-hoist=false | Prevents phantom dependency access; ensures all packages declare their own deps explicitly |
| packages/core I/O-free | Per architectural decision: core exports only pure types, no Octokit/Redis/Prisma imports allowed |

## Verification Results

- `pnpm install` — exits 0, 260 packages resolved
- `pnpm list --recursive --depth 0` — shows all 6 @ciintel/* packages
- `turbo.json` — uses "tasks" key (Turborepo 2 schema confirmed)
- `tsconfig.base.json` — moduleResolution: nodenext, target: es2025
- All 6 package tsconfigs extend ../../tsconfig.base.json

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

Plans 01-02 (database layer) and 01-03 (queue and github packages) can now execute in parallel since both scaffold directories and tsconfig inheritance are in place. No blockers.
