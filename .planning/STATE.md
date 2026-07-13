# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-13)

**Core value:** When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time across the organization.
**Current focus:** Phase 1 — GitHub App Foundation

## Current Position

Phase: 1 of 5 (GitHub App Foundation)
Plan: 1 of 6 in current phase
Status: In progress
Last activity: 2026-07-13 — Completed 01-01-PLAN.md (monorepo scaffold)

Progress: [█░░░░░░░░░] 4% (1/26 estimated plans)

## Performance Metrics

**Velocity:**
- Total plans completed: 1
- Average duration: 3m 8s
- Total execution time: ~3 minutes

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. GitHub App Foundation | 1/6 | ~3m | 3m |

**Recent Trend:**
- Last 5 plans: 01-01 (3m 8s)
- Trend: Baseline established

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Init]: TypeScript monorepo (Turborepo + pnpm), Fastify, BullMQ + Redis, PostgreSQL + Prisma, Vercel AI SDK
- [Init]: No dashboard in MVP — all user output via GitHub (PR comments, check runs) and Slack
- [Init]: Split-process architecture — `apps/api` (webhook receiver) and `apps/worker` (BullMQ pipeline) are separate Railway services
- [Init]: `packages/core` must be I/O-free — no Octokit, Redis, or Prisma; required for SDK publishability
- [Init]: Permission scope locked before Phase 1 ships — `checks:write`, `contents:write`, `pull_requests:write`, `issues:write`, `actions:write`, `metadata:read`
- [01-01]: Turborepo 2 tasks key schema (not pipeline) — v2 deprecated pipeline; tasks key required
- [01-01]: module: nodenext + moduleResolution: nodenext — full ESM correctness in Node.js 22
- [01-01]: composite: true across all packages — enables tsc --build project references for correct build ordering

### Pending Todos

None yet.

### Blockers/Concerns

- [Research]: PgBouncer deployment model undecided — Railway managed Postgres does not include PgBouncer; decide sidecar vs Supabase vs external before Phase 1 data model work
- [Research]: LLM provider default and BYOK model undecided — platform default key with token caps vs. every installation provides own key
- [Research]: Confidence threshold starting values (0.7 for PR comment, 0.9 for fix PR) need empirical calibration in Phase 2

## Session Continuity

Last session: 2026-07-13T09:12Z
Stopped at: Completed 01-01-PLAN.md — pnpm+Turborepo 2 monorepo scaffold, all 6 packages, CI workflow
Resume file: None
