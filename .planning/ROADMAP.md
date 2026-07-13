# Roadmap: CyclOps

## Overview

CyclOps ships as a GitHub App that installs in under 30 seconds and immediately begins classifying CI failures, explaining root causes, and executing safe auto-remediations. The build progresses from a reliable multi-tenant ingestion pipeline (Phase 1), through AI-enriched detection (Phase 2), to the full action engine and output channels (Phase 3), then stabilizes the public SDK for self-hosters (Phase 4), and finally completes the marketplace listing and Slack workspace integration needed for paid distribution (Phase 5).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: GitHub App Foundation** - Reliable multi-tenant webhook ingestion pipeline; GitHub App installable and receiving events
- [ ] **Phase 2: Detector Pipeline & AI Analysis** - All 6 detectors running end-to-end with AI-enriched structured findings; no actions yet
- [ ] **Phase 3: Action Engine & Output Channels** - cyclops[bot] posts consolidated PR comments, creates Check Runs, and executes safe auto-actions with full deduplication and kill switches
- [ ] **Phase 4: Public SDK** - @cyclops/core published on npm; self-hosters can install and extend CyclOps detectors
- [ ] **Phase 5: Slack Integration & Marketplace** - CyclOps listed on GitHub Marketplace with paid tiers; Slack integration live

---

## Phase Details

### Phase 1: GitHub App Foundation

**Goal**: A GitHub App that any org can install in under 30 seconds, receives webhook events from GitHub, enqueues them for async processing, and maintains strict per-tenant data isolation.

**Depends on**: Nothing (first phase)

**Requirements**: APP-01, APP-02, APP-03, APP-04, APP-05, APP-06, WHK-01, WHK-02, WHK-03, WHK-04, WHK-05, WHK-06, TEN-01, TEN-02, TEN-03, TEN-04, TEN-05

**Success Criteria** (what must be TRUE when this phase completes):
  1. A developer can install cyclops[bot] from a GitHub URL in under 30 seconds and see it appear as an authorized app in their org's GitHub settings
  2. Webhook deliveries from GitHub show 202 responses observable in the GitHub App delivery log, with all processing happening asynchronously via BullMQ
  3. Installing on one org cannot read or write any data belonging to another org — tenant isolation holds at both the Prisma query layer (injected `installationId` filter) and the PostgreSQL RLS layer
  4. Deleting or suspending a GitHub App installation stops all queued jobs for that tenant without processing them
  5. Four BullMQ queues (`webhook-ingestion`, `detector-dispatch`, `ai-analysis`, `action-execution`) exist in Redis with correct concurrency and retention settings

**Plans**: 6 plans

Plans:
- [x] 01-01-monorepo-scaffold.md — pnpm + Turborepo 2 workspace, root tsconfig, all 6 package scaffolds, CI workflow
- [x] 01-02-database-layer.md — Prisma 7 schema, RLS migrations, adapter-pg client factory, tenant extension
- [x] 01-03-queue-and-github-packages.md — BullMQ 4-queue definitions, typed job payloads, Octokit App singleton and factory functions
- [x] 01-04-webhook-receiver.md — Fastify 5 webhook receiver, HMAC verification, Redis dedup, BullMQ enqueue
- [x] 01-05-webhook-worker.md — WebhookIngestionWorker with installation lifecycle handling, TEN-04 gate, DLQ worker
- [x] 01-06-railway-deployment.md — railway.toml for api and worker, env var docs, end-to-end test script

---

### Phase 2: Detector Pipeline & AI Analysis

**Goal**: All 6 detectors classify CI failures from real GitHub Actions events, and the AI analysis layer enriches each finding with structured output including confidence, evidence, and caveat fields — no actions are executed yet.

**Depends on**: Phase 1

**Requirements**: DET-01, DET-02, DET-03, DET-04, DET-05, DET-06, DET-07, DET-08, DET-09, AI-01, AI-02, AI-03, AI-04, AI-05, AI-06

**Success Criteria** (what must be TRUE when this phase completes):
  1. A failing ESLint or Prettier workflow run produces a `DetectorResult` containing violated files and rule names within 60 seconds of the webhook delivery
  2. A test failure that has previously passed is classified as `FlakyTest` with cross-referenced historical pass/fail evidence; a first-time failure is not classified as flaky
  3. Every AI finding stored in the database contains `confidence`, `evidence[]`, and `caveat` fields — no finding is persisted with a null evidence array
  4. Auto-action workers receive no jobs when AI confidence is `medium` or `low` — only `high` confidence findings with non-empty evidence advance to Phase 3 workers
  5. Token usage records tagged with `installation_id`, `detector_id`, and model name are written to the database for every AI call; a per-installation monthly cap of 100% hard-stops further AI calls when reached

---

**Plans**: 7 plans

Plans:
- [ ] 02-01-PLAN.md — Data foundation: Finding + TokenUsage models, encryptedApiKey, RLS migration, core types, AiAnalysisJob schema
- [ ] 02-02-PLAN.md — packages/detectors: all 6 pure detectors + log-utils + runAllDetectors
- [ ] 02-03-PLAN.md — packages/ai: FindingSchema, Anthropic client, analyzeFailure, checkTokenBudget
- [ ] 02-04-PLAN.md — AES-256-GCM encryption in core + POST /setup/:installationId (BYOK)
- [ ] 02-05-PLAN.md — DetectorDispatchWorker + GitHub Actions API lib + webhook-ingestion dispatch
- [ ] 02-06-PLAN.md — AiAnalysisWorker: budget gate, decrypt, enrich, high-confidence routing
- [ ] 02-07-PLAN.md — Env var docs + end-to-end verification checkpoint

---

### Phase 3: Action Engine & Output Channels

**Goal**: cyclops[bot] delivers consolidated, deduplicated output on every failing workflow run — exactly one PR comment edited in place, a GitHub Check Run on every commit, autofix PRs for high-confidence Lint and Snapshot failures, and per-repo kill switches that immediately suppress any action.

**Depends on**: Phase 2

**Requirements**: ACT-01, ACT-02, ACT-03, ACT-04, ACT-05, ACT-06, ACT-07, ACT-08, ACT-09, ACT-10, ACT-11, ACT-12, ACT-13, ACT-14, CFG-01, CFG-02, CFG-03, CFG-04

**Success Criteria** (what must be TRUE when this phase completes):
  1. A PR with a failing workflow shows exactly one PR comment from cyclops[bot]; subsequent failures on the same PR edit the existing comment and never create a second one; a successful run produces no comment
  2. Every analyzed commit has a GitHub Check Run with pass/fail status and a markdown summary visible in the PR Checks tab
  3. A high-confidence Lint failure on a PR generates a fix PR from cyclops[bot] within 2 minutes; running the same failure again within 24 hours produces no duplicate PR
  4. Adding `autofix: false` to a repo's `.cyclops.yml` and pushing immediately suppresses all fix PR creation on the next webhook delivery — no restart required
  5. A zero-config installation (no `.cyclops.yml`) works out of the box with sensible defaults across all 6 detectors

---

**Plans**: TBD

Plans:
- [ ] 03-01: TBD

---

### Phase 4: Public SDK

**Goal**: `@cyclops/core` is published to npm as a stable, I/O-free package that self-hosting engineers can install to build custom detectors implementing the `IDetector` interface.

**Depends on**: Phase 3

**Requirements**: SDK-01, SDK-02, SDK-03, SDK-04, SDK-05

**Success Criteria** (what must be TRUE when this phase completes):
  1. `npm install @cyclops/core` succeeds and TypeScript consumers can import `IDetector`, `DetectorContext`, and `DetectorResult` types without any additional type stubs
  2. A custom detector that `implements IDetector` runs as a pure function from `DetectorContext` to `DetectorResult` without importing Octokit, Redis, Prisma, or any I/O library
  3. Both `import { IDetector } from '@cyclops/core'` (ESM) and `const { IDetector } = require('@cyclops/core')` (CJS) resolve without runtime errors in Node.js 22
  4. `publint` and `@arethetypeswrong/cli` produce zero errors in CI on every publish candidate

---

**Plans**: TBD

Plans:
- [ ] 04-01: TBD

---

### Phase 5: Slack Integration & Marketplace

**Goal**: CyclOps is publicly listed on GitHub Marketplace with at least two paid tiers, handles billing lifecycle events correctly, exposes a public status page, and delivers Slack alerts to configurable workspace channels for Expired Secret and repeat failure events.

**Depends on**: Phase 4

**Requirements**: MKT-01, MKT-02, MKT-03, SLK-01, SLK-02

**Success Criteria** (what must be TRUE when this phase completes):
  1. CyclOps appears on the GitHub Marketplace at a public URL with at least two paid plans; any engineer can initiate an installation directly from the marketplace listing
  2. A new marketplace purchase triggers the billing state machine and transitions the installation to `trial` or `active` state in the database within one webhook processing cycle
  3. Cancelling a marketplace subscription suspends all bot actions for that installation and the installation transitions to `cancelled` state within one state machine tick — no further PR comments or fix PRs are created
  4. An Expired Secret failure delivers a Slack message to the team channel configured for the installation, not just the committer — the message appears in the correct workspace channel within 60 seconds of the failure
  5. The public `/status` endpoint returns real-time health for the API and worker processes and is accessible without authentication

---

**Plans**: TBD

Plans:
- [ ] 05-01: TBD

---

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. GitHub App Foundation | 6/6 | Complete | 2026-07-13 |
| 2. Detector Pipeline & AI Analysis | 0/TBD | Not started | - |
| 3. Action Engine & Output Channels | 0/TBD | Not started | - |
| 4. Public SDK | 0/TBD | Not started | - |
| 5. Slack Integration & Marketplace | 0/TBD | Not started | - |

---

*Roadmap created: 2026-07-13*
*Requirements coverage: 60/60 v1 requirements mapped across 5 phases*
