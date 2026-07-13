# CyclOps — Research Summary

**Project:** CyclOps (ciintel)
**Domain:** GitHub App SaaS — AI-powered CI failure classification and automated remediation
**Researched:** 2026-07-13
**Overall Confidence:** HIGH

---

## Executive Summary

CyclOps is a multi-tenant GitHub App SaaS that sits above the CI execution layer — it does not run CI, it interprets CI failures. The correct architecture is a split-process monorepo: a Fastify webhook receiver that does nothing except verify HMAC signatures and enqueue to Redis, plus a separate BullMQ worker process that runs the detection and action pipeline. This separation is non-negotiable because GitHub retries webhooks after 10 seconds and AI analysis takes 2–30 seconds; coupling them in one process causes webhook delivery failures under any meaningful load.

The detection model follows a deliberate ordering: cheap heuristic detectors (regexp, log pattern, duration thresholds, DB lookups) run first and in parallel; the LLM receives their structured output as grounding evidence, not raw log bytes. This is both cheaper and more accurate than sending logs directly to an LLM. The 6 planned detectors (Lint, Snapshot, Expired Secret, Flaky Test, Hanging Workflow, Workflow Drift) cover the right surface for MVP. The two features that differentiate CyclOps from every competitor are automated fix PRs (nobody auto-fixes, they only classify) and cross-repo workflow drift detection (no competitor covers this).

The dominant risk category is trust destruction through over-automation. Engineers are deeply skeptical of AI acting in CI pipelines — 78% don't use AI in CI/CD and the stated barrier is trust. One duplicate PR, one spurious bot comment, one auto-merged commit that breaks main — any of these events will cause uninstalls. Every action the bot takes must be bounded by confidence thresholds, action deduplication, per-repo rate limits, and explicit kill switches. The progression: Observe → Classify → Comment is always safe; Create PR is safe with human review; Auto-merge is off by default and may never ship.

---

## Recommended Stack

| Layer | Technology | Version | Critical Note |
|-------|-----------|---------|---------------|
| Runtime | Node.js | 22 LTS | Native ESM, built-in fetch |
| Language | TypeScript | 7.0.2 | No `ts.CompilerAPI` until 7.1; removes `target: es5`, `moduleResolution: node` as hard errors |
| Package manager | pnpm | 11.10.0 | First-class workspace support |
| HTTP | Fastify | 5.10.0 | Plugin encapsulation required for webhook vs. API route separation |
| Raw body | fastify-raw-body | latest | Mandatory for HMAC verification — capture bytes before JSON parsing |
| GitHub App | @octokit/app | 16.1.2 | Do not use Probot — forces Express model, blocks webhook→queue handoff |
| Auth | @octokit/auth-app | 8.2.0 | Handles token caching (up to 15K tokens) and refresh automatically |
| Webhook verification | @octokit/webhooks | 14.2.0 | HMAC-SHA256 via `verify()` |
| Job queue | BullMQ | 5.79.3 | Flow producers for DAG; built-in OpenTelemetry |
| Redis client | ioredis | 5.11.1 | `maxRetriesPerRequest: null` required; Redis must have `maxmemory-policy noeviction` |
| ORM | Prisma | 7.8.0 | Connection config moved to `prisma.config.ts`; TypeScript runtime replaces Rust engine |
| Database | PostgreSQL | 16 | RLS for tenant isolation; jsonb for detector output |
| AI abstraction | Vercel AI SDK | 7.0.18 | 20+ providers; Zod 4 native for tool schemas |
| Validation | Zod | 4.4.3 | Import from `zod/v4` subpath |
| SDK build | tsup | 8.5.1 | Dual ESM/CJS output with `.mjs`/`.cjs` extensions |
| Monorepo | Turbo | 2.10.4 | `^build` enforces layer ordering |
| Deploy | Railway | — | First-class pnpm monorepo; selective redeploys per service |

---

## Table Stakes Features

- **Single consolidated PR comment per workflow run, edited in-place** — multiple bot comments is the top complaint across all competitors
- **GitHub Check Run with pass/fail status** — merge gate; every competitor provides this
- **Inline Check annotations for file-level failures** — Lint and Snapshot only; do not annotate infrastructure failures
- **Failure classification by category with evidence shown** — "build failed" is not actionable
- **Confidence score per finding** — suppress sub-threshold findings from PR comments; log-only below threshold
- **Auto-retry for transient/flaky failures with reason shown** — accepted when classification evidence is displayed
- **Zero-SDK setup** — no changes to existing workflows; any friction beyond installing the GitHub App kills adoption
- **Multi-repo from single org-level install** — standard GitHub App capability
- **Per-repo `.cyclops.yml` config** — detector toggles, confidence thresholds, notification routing

**Anti-features (build these exclusions explicitly):**
- Never post multiple comments per workflow run
- Never comment on successful runs
- Never auto-merge any PR in MVP
- Never push directly to workflow YAML files
- Never default to email notifications

---

## Key Differentiators

**Primary (unique to CyclOps in current market):**

1. **Automated fix PR creation** — Trunk, Datadog, BuildPulse classify failures; nobody creates the fix. For Lint (ESLint autofix) and Snapshot (stale snapshot regen), CyclOps creates a reviewable PR. Bounded by high-confidence threshold; no auto-merge in MVP.

2. **Cross-repo workflow drift detection** — no competitor detects divergence between `.github/workflows/` files across repos in an org. Output is a PR proposing the diff; never a direct push.

**Secondary:**
- Hanging workflow auto-cancel with configurable duration threshold
- Expired secret classification with stakeholder routing (not just committer notification)
- AI root cause narrative with required evidence citations
- `@cyclops/core` public SDK for self-hosting enterprises

**Deliberately out of scope:**
- Build/compilation error analysis (developer's bug, not infrastructure failure)
- Security scan routing (separate buyer, Snyk/CodeClimate own this)
- Code coverage gating (Codecov owns this)
- Email notifications

---

## Architecture Highlights

**Split-process is the central structural decision.** `apps/api` (Fastify webhook receiver) and `apps/worker` (BullMQ analysis pipeline) are separate Railway services that scale independently.

**Five-worker pipeline in `apps/worker`:**
1. `WebhookIngestionWorker` — validates event, checks tenant status, fans out via `addBulk()`
2. `DetectorDispatchWorker` — builds `DetectorContext` (one batched GitHub API call), runs all detectors in `Promise.all()`
3. `AIAnalysisWorker` — receives `DetectorResult[]` as grounding, calls `generateObject()`, produces structured `Finding`
4. `ActionExecutionWorker` — executes action plan via `packages/github` factory; all actions idempotent
5. `DLQWorker` — consumes exhausted retries, marks DB record terminal

**`packages/core` must be I/O-free.** Detectors are pure functions: `DetectorContext → DetectorResult`. No Octokit, no Redis, no Prisma inside `packages/core`. Required for unit testability and `@cyclops/core` SDK publishability.

**Multi-tenant isolation is two-layered:** Prisma extension injects `WHERE installationId = ?` + PostgreSQL RLS as backstop. Redis keys namespaced as `installation:{id}:{resource_type}:{resource_id}`.

**Webhook idempotency is two-layered:** Redis `SET NX EX 259200` on `X-GitHub-Delivery` (3-day TTL) + PostgreSQL unique index on `delivery_id` as backstop.

**Four queues separated by blast radius:** `webhook-ingestion` (concurrency 20), `detector-dispatch` (concurrency 50), `ai-analysis` (concurrency 10, 60s timeout), `action-execution` (concurrency 20, idempotency key in job data).

---

## Top Pitfalls to Avoid

| # | Severity | Pitfall | Prevention |
|---|----------|---------|------------|
| 1 | CRITICAL | Webhook HMAC broken by body parsing | Register `fastify-raw-body` before routes; verify in `preHandler` |
| 2 | CRITICAL | Installation tokens stored in job payloads (expire after 1hr) | Store only `installationId` in jobs; mint token at worker start via `@octokit/auth-app` |
| 3 | CRITICAL | Multi-tenant data leakage | Prisma extension + PostgreSQL RLS from Phase 1 |
| 4 | CRITICAL | App JWT vs installation token confusion | Two factory functions: `getAppClient()` and `getInstallationClient(installationId)` |
| 5 | HIGH | Action Engine over-automation — PR spam destroys trust | Deduplication, per-repo rate limits, confidence gating, kill switches before any auto-action |
| 6 | HIGH | Log truncation causing wrong AI analysis | Tail-first extraction; step-level log fetching for failed step only |
| 7 | HIGH | LLM hallucinated root cause with false confidence | `generateObject()` with required `confidence + evidence + caveat` fields; path verification |
| 8 | HIGH | Redis memory blowout from log payloads | Identifiers only in job payloads; fetch logs at processing time; `maxmemory-policy noeviction` |

---

## Phase Recommendations

| Phase | Name | Key Deliverables | Research Needed |
|-------|------|-----------------|-----------------|
| 1 | GitHub App Foundation | Webhook receiver, auth contexts, queue architecture, DB schema + RLS, installation lifecycle | No — standard patterns |
| 2 | Detector Pipeline + AI | 6 detectors, step-level log fetching, AI analysis worker with structured output | Yes — prompt engineering spike |
| 3 | Action Engine + Output | PR comments, Check Runs, fix PRs, auto-retry, kill switches + deduplication | No — standard patterns |
| 4 | Public SDK | `@cyclops/core` npm publish, dual ESM/CJS, semver policy | No — standard patterns |
| 5 | Slack + Marketplace + Billing | Slack integration, `marketplace_purchase` handling, billing state machine | Yes — billing edge cases |

**Ordering rationale:** Phase 1 auth/data model prerequisites everything. Phase 2 detection accuracy must be validated before Phase 3 actions ship. Phase 4 SDK stabilizes after detector APIs freeze. Phase 5 is a process gate requiring install count.

---

## Open Questions

1. **Permission scope lock-in** — must decide before Phase 1 ships; adding permissions post-launch requires all installations to re-authorize. Request `contents: write`, `issues: write`, `actions: write` upfront.
2. **LLM provider default and BYOK model** — platform default key with token caps, or every installation provides their own key?
3. **Confidence threshold defaults** — starting values (0.7 for PR comment, 0.9 for fix PR) need empirical calibration
4. **`.cyclops.yml` schema freeze** — define and freeze before Phase 1 ships even if fields are unused until Phase 3
5. **Fix PR authorship** — authored by `cyclops[bot]`; requires dedicated bot account or committer identity resolution
6. **PgBouncer deployment** — Railway managed Postgres does not include PgBouncer; decide: sidecar vs Supabase vs external
7. **Zod 4 import path** — verify Vercel AI SDK 7 resolves `zod` to v4 semantics; run `pnpm why zod` after install

---

*Research completed: 2026-07-13*
