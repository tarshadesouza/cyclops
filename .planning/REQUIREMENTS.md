# Requirements: CyclOps

**Defined:** 2026-07-13
**Core Value:** When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time across the organization.

---

## v1 Requirements

### GitHub App & Installation

- [ ] **APP-01**: GitHub App installable via GitHub Marketplace or direct install link with org/repo scope selection
- [ ] **APP-02**: Installation lifecycle handled: created, deleted, suspended, unsuspended, repositories added/removed
- [ ] **APP-03**: Bot identity appears as `cyclops[bot]` on all GitHub output (comments, PRs, check runs)
- [ ] **APP-04**: GitHub App permissions declared upfront: `checks: write`, `contents: write`, `pull_requests: write`, `issues: write`, `actions: write`, `metadata: read`
- [ ] **APP-05**: App JWT vs installation token handled via two distinct factory functions (`getAppClient()` and `getInstallationClient(installationId)`)
- [ ] **APP-06**: Installation tokens minted at worker job-start via `@octokit/auth-app`; never stored in job payloads

### Webhook Infrastructure

- [ ] **WHK-01**: HMAC-SHA256 webhook signature verification using raw body captured before JSON parsing
- [ ] **WHK-02**: Webhook receiver returns 202 immediately; all processing is asynchronous
- [ ] **WHK-03**: Idempotent delivery via two-layer dedup: Redis `SET NX EX 259200` on `X-GitHub-Delivery` + PostgreSQL unique constraint on `delivery_id`
- [ ] **WHK-04**: BullMQ 4-queue architecture: `webhook-ingestion`, `detector-dispatch`, `ai-analysis`, `action-execution`
- [ ] **WHK-05**: Redis configured with `maxmemory-policy noeviction` and `appendonly yes`
- [ ] **WHK-06**: Job payloads contain identifiers only (no log content, no tokens)

### Multi-Tenancy & Data

- [ ] **TEN-01**: PostgreSQL Row-Level Security on all tenant tables enforced at database layer
- [ ] **TEN-02**: Prisma client extension injects `WHERE installationId = ?` on every query at application layer
- [ ] **TEN-03**: Redis cache keys namespaced as `installation:{id}:{resource_type}:{resource_id}`
- [ ] **TEN-04**: Suspended and deleted installations drop all queued jobs without processing
- [ ] **TEN-05**: PgBouncer connection pooling for worker concurrency (sidecar or Supabase managed)

### Detector Pipeline

- [ ] **DET-01**: Lint Detector classifies ESLint and Prettier failures; extracts violated files and rules
- [ ] **DET-02**: Snapshot Detector classifies Jest and Storybook snapshot failures; identifies stale snapshot files
- [ ] **DET-03**: Expired Secret Detector classifies authentication failures, expired tokens, and missing credentials
- [ ] **DET-04**: Flaky Test Detector identifies intermittent failures by cross-referencing historical pass/fail patterns
- [ ] **DET-05**: Hanging Workflow Detector identifies jobs with no log activity beyond a configurable duration threshold
- [ ] **DET-06**: Workflow Drift Detector flags divergence in `.github/workflows/` files across repos in an org against a golden template
- [ ] **DET-07**: All detectors run in parallel (`Promise.all()`) as pure functions: `DetectorContext → DetectorResult`
- [ ] **DET-08**: Step-level log fetching for the failed step only; tail-first extraction (last 500 lines); `[LOG TRUNCATED]` marker included in prompts when truncated
- [ ] **DET-09**: Heuristic detectors (regexp, log patterns, duration thresholds) run before AI analysis

### AI Analysis

- [ ] **AI-01**: AI analysis layer implemented via Vercel AI SDK with support for OpenAI, Anthropic, and Gemini providers
- [ ] **AI-02**: Structured output via `generateObject()` with required fields: `confidence: "high"|"medium"|"low"`, `evidence: string[]`, `caveat: string`
- [ ] **AI-03**: AI receives structured `DetectorResult[]` as grounding context, never raw log bytes
- [ ] **AI-04**: Auto-actions (PR creation, rerun) blocked unless `confidence === "high"` with non-empty evidence
- [ ] **AI-05**: Per-request token usage tracked and tagged with `installation_id`, `detector_id`, and model
- [ ] **AI-06**: Per-installation monthly token cap configurable; soft-warn at 80%, hard-stop at 100%

### Action Engine

- [ ] **ACT-01**: Single consolidated PR comment per workflow run, created on first failure and edited in-place on subsequent updates (never multiple comments)
- [ ] **ACT-02**: PR comment only posted on failures; silent on successful runs
- [ ] **ACT-03**: GitHub Check Run created with pass/fail status and markdown summary
- [ ] **ACT-04**: Inline Check annotations for file-level failures (Lint, Snapshot); max 50 annotations per `update_check_run` call
- [ ] **ACT-05**: Autofix PR created for Lint failures (ESLint `--fix`) at `confidence === "high"` only; no auto-merge
- [ ] **ACT-06**: Autofix PR created for Snapshot failures (snapshot regeneration) at `confidence === "high"` only; no auto-merge
- [ ] **ACT-07**: Flaky Test auto-rerun triggered with evidence shown in PR comment
- [ ] **ACT-08**: Hanging Workflow auto-cancel triggered after configurable inactivity duration
- [ ] **ACT-09**: Slack alert sent for Expired Secret failures; routes to team channel (not committer only)
- [ ] **ACT-10**: GitHub Issue created for persistent tracking of unresolved repeat failures
- [ ] **ACT-11**: Action deduplication: no duplicate action for the same `(installation_id, repo_id, detector_id, branch)` within a 24-hour window
- [ ] **ACT-12**: Per-repo PR creation rate limit: 3 per hour by default, configurable via `.cyclops.yml`
- [ ] **ACT-13**: All auto-actions are idempotent (check-before-create on every GitHub API write)
- [ ] **ACT-14**: Per-repo kill switches in `.cyclops.yml` ship before any auto-action is enabled

### Configuration

- [ ] **CFG-01**: Optional `.cyclops.yml` in repo root for per-repo configuration
- [ ] **CFG-02**: `.cyclops.yml` schema covers: detector enable/disable, confidence thresholds, auto-action toggles, notification routing, rate limits
- [ ] **CFG-03**: `.cyclops.yml` schema frozen and published before first public installation
- [ ] **CFG-04**: Sensible defaults for all config fields; zero-config installation works out of the box

### Public SDK

- [ ] **SDK-01**: `@cyclops/core` published to npm with dual ESM/CJS output (`.mjs`/`.cjs` extensions via tsup)
- [ ] **SDK-02**: Public `IDetector` interface and `DetectorContext`/`DetectorResult` types exported
- [ ] **SDK-03**: `packages/core` contains zero I/O dependencies (no Octokit, Redis, or Prisma)
- [ ] **SDK-04**: `publint` and `@arethetypeswrong/cli` validation runs in CI before every npm publish
- [ ] **SDK-05**: Strict semver policy: breaking changes in `IDetector` interface require major version bump

---

## v2 Requirements

### Dashboard

- **DASH-01**: Web dashboard showing org-level CI health trends over time
- **DASH-02**: Per-repo failure category breakdown and recurring pattern analysis
- **DASH-03**: Configuration management UI (alternative to `.cyclops.yml`)
- **DASH-04**: Team-level CI productivity metrics

### Additional Detectors

- **DET-V2-01**: Dependency Resolution Detector (npm/yarn lockfile conflicts, missing packages)
- **DET-V2-02**: Resource Exhaustion Detector (OOM, disk full, runner capacity)
- **DET-V2-03**: Permission Denied Detector (OIDC misconfiguration, missing role bindings)

### Advanced Features

- **ADV-01**: Snooze/Acknowledge for repeat failures (suppress notifications for known issues)
- **ADV-02**: CI health scoring per repo and org
- **ADV-03**: Secret expiration forecasting (predict expiry before failure)
- **ADV-04**: Custom detector support via `@cyclops/core` plugin interface
- **ADV-05**: Multi-CI support: GitLab CI, CircleCI, Jenkins

### Integrations

- **INT-01**: Jira ticket creation for Expired Secret failures
- **INT-02**: Linear ticket creation for persistent failures
- **INT-03**: Microsoft Teams notification support
- **INT-04**: PagerDuty escalation for Hanging Workflow failures

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Build/compilation error analysis | Developer's bug, not infrastructure failure; different root cause model; scope creep |
| Security scan routing | Separate buyer (security team vs. engineering team); Snyk/CodeClimate own this |
| Code coverage gating | Codecov owns this space; not a CI reliability problem |
| Email notifications | Dead channel for developer tooling; Slack is the standard |
| Auto-merge of fix PRs | Trust threshold too high for MVP; engineers must review all automated fixes |
| Direct pushes to workflow YAML | Highest blast-radius automation possible; always create reviewable PRs |
| Custom/self-hosted AI model support | API-based providers sufficient for MVP; BYOK enterprise feature for v2 |
| Real-time CI log streaming | Requires persistent WebSocket connections; adds infrastructure complexity without proportional value |

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| APP-01–06 | Phase 1 | Pending |
| WHK-01–06 | Phase 1 | Pending |
| TEN-01–05 | Phase 1 | Pending |
| DET-01–09 | Phase 2 | Pending |
| AI-01–06 | Phase 2 | Pending |
| ACT-01–14 | Phase 3 | Pending |
| CFG-01–04 | Phase 3 | Pending |
| SDK-01–05 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 54 total
- Mapped to phases: 54
- Unmapped: 0 ✓

---

*Requirements defined: 2026-07-13*
*Last updated: 2026-07-13 after initial definition*
