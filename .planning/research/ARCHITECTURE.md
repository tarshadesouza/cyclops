# Architecture Patterns: CyclOps GitHub App SaaS

**Domain:** Multi-tenant GitHub App SaaS — CI intelligence platform
**Researched:** 2026-07-13
**Overall confidence:** HIGH (core patterns from official docs + verified sources)

---

## Recommended Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GitHub Platform                             │
│   Webhooks ──────────────────────────────────────────────────────►  │
│   Check Runs API  ◄──────────────────────────────────────────────   │
│   PR Comments API ◄──────────────────────────────────────────────   │
│   Installation Tokens (per-install, cached)                         │
└──────────────┬──────────────────────────────────▲───────────────────┘
               │ HTTPS POST                       │ REST API
               ▼                                  │
┌─────────────────────────┐           ┌───────────────────────────────┐
│    apps/api (Fastify)   │           │   packages/github             │
│                         │           │                               │
│  POST /webhooks/github  │           │  - Octokit client factory     │
│    1. Verify HMAC-256   │           │  - Installation token cache   │
│    2. Store dedup key   │           │    (Redis, TTL=50min)         │
│    3. Enqueue job       │           │  - Rate limit middleware      │
│    4. Return 202        │           │  - Check Run builder          │
│                         │           │  - Webhook signature verify   │
│  POST /installations    │           │                               │
│    (lifecycle events)   │           └───────────────────────────────┘
└───────────┬─────────────┘                        ▲
            │ BullMQ add()                         │ used by
            ▼                                      │
┌─────────────────────────┐           ┌────────────┴──────────────────┐
│  Redis (BullMQ queues)  │           │   packages/core               │
│                         │           │                               │
│  webhook-ingestion      │──────────►│  - DetectorContext type       │
│  detector-dispatch      │           │  - IDetector interface        │
│  action-execution       │           │  - DetectorResult type        │
│  dlq (failed jobs)      │           │  - Pipeline orchestrator      │
│                         │           │  - AI analysis layer          │
│  Token cache (string)   │           │  - Action engine interface    │
│  Dedup keys (string,NX) │           │                               │
└─────────────────────────┘           └───────────────────────────────┘
            │                                      ▲
            │ BullMQ Worker picks up               │ imports
            ▼                                      │
┌─────────────────────────────────────────────────────────────────────┐
│                       apps/worker                                   │
│                                                                     │
│  WebhookIngestionWorker                                             │
│    - Validates event type (workflow_run, check_run, etc.)           │
│    - Loads tenant (installation) from DB                            │
│    - Fans out → N detector jobs on detector-dispatch queue          │
│                                                                     │
│  DetectorDispatchWorker                                             │
│    - Builds DetectorContext from webhook payload + DB state         │
│    - Runs applicable detectors in parallel (Promise.all)            │
│    - Aggregates DetectorResult[]                                    │
│    - Enqueues AI analysis job (if any detector fires)               │
│    - Enqueues action jobs for deterministic findings                │
│                                                                     │
│  AIAnalysisWorker                                                   │
│    - Receives structured DetectorResult[] as context                │
│    - Calls Vercel AI SDK (generateObject / generateText)            │
│    - Produces classified finding: category, confidence,             │
│      root cause, fix suggestion                                     │
│    - Enqueues output job on action-execution queue                  │
│                                                                     │
│  ActionExecutionWorker                                              │
│    - Reads action plan (create_pr, rerun, slack_alert, issue)       │
│    - Executes via packages/github Octokit factory                   │
│    - Writes outcome to DB                                           │
│                                                                     │
│  DLQWorker                                                          │
│    - Consumes jobs that exhausted retries                           │
│    - Logs structured error, alerts on-call (Slack)                  │
│    - Marks job as permanently failed in DB                          │
└─────────────────────────────────────────────────────────────────────┘
            │ read/write
            ▼
┌─────────────────────────┐
│   PostgreSQL + Prisma   │
│                         │
│  tenants                │
│  installations          │
│  webhook_events         │
│  detector_runs          │
│  findings               │
│  actions                │
└─────────────────────────┘
```

---

## Data Flow

```
GitHub sends webhook
        │
        ▼
apps/api receives POST /webhooks/github
        │
        ├─ 1. Verify HMAC-256 signature (WEBHOOK_SECRET)
        │      Reject 401 immediately on failure — no queue entry
        │
        ├─ 2. Dedup check: SET redis "dedup:{delivery_id}" NX EX 259200
        │      (TTL = 3 days; covers GitHub's full retry window)
        │      Return 200 immediately if key already exists (duplicate)
        │
        ├─ 3. Enqueue to webhook-ingestion queue
        │      job data: { installationId, event, action, payload, deliveryId }
        │
        └─ 4. Return 202 Accepted (do not block on worker processing)
                │
                ▼
        WebhookIngestionWorker (apps/worker)
                │
                ├─ Load tenant record from DB (by installationId)
                │   If tenant.status == SUSPENDED → drop job, return
                │   If tenant not found → log warning, dead-letter
                │
                └─ Fan out: enqueue one job per applicable detector
                    on detector-dispatch queue
                    Each job: { tenantId, installationId, detectorId,
                                workflowRunId, contextPayload }
                │
                ▼
        DetectorDispatchWorker (apps/worker, N concurrent workers)
                │
                ├─ Build DetectorContext (fetch CI logs, annotations,
                │   git diff, repo config .cyclops.yml via GitHub API)
                │
                ├─ Run applicable detectors in parallel (Promise.all)
                │   Each detector: pure function, returns DetectorResult
                │   { fired: bool, category, evidence, confidence, ... }
                │
                ├─ Write DetectorRun records to DB
                │
                ├─ If any detector.fired == true AND requires AI:
                │     Enqueue ai-analysis job with DetectorResult[]
                │
                └─ If any detector.fired == true AND deterministic:
                      Enqueue action-execution job directly
                                │
                                ▼
                        AIAnalysisWorker
                                │
                                ├─ Receives { detectorResults[], ciContext }
                                ├─ Calls generateObject() via Vercel AI SDK
                                │   with structured schema for Finding
                                ├─ Returns: { category, confidence,
                                │            rootCause, fixSuggestion }
                                └─ Enqueues action-execution job
                                │
                                ▼
                        ActionExecutionWorker
                                │
                                ├─ Creates/updates GitHub Check Run
                                │   (PR-scoped: status=completed,
                                │    conclusion per confidence level)
                                ├─ Posts PR comment (rich markdown)
                                ├─ Creates autofix PR if applicable
                                ├─ Sends Slack alert if configured
                                ├─ Creates GitHub issue if configured
                                └─ Writes Finding + Actions to DB
```

---

## Multi-Tenant Data Isolation

### Recommendation: Row-Level Security (RLS) on PostgreSQL

**Verdict:** Use shared tables with PostgreSQL Row-Level Security enforced at the database layer. Do not use schema-per-tenant.

**Rationale:**

CyclOps is isolated by `installation_id` (GitHub's unique per-org/repo identifier). This maps cleanly to a `tenant_id` foreign key column on every data table. RLS policies enforced at the DB layer provide:

- A single migration path (one schema, one migration run)
- Linear operational overhead regardless of tenant count
- Protection against application-level bugs leaking cross-tenant data
- Practical scale to millions of tenants with no architectural change

**Scale thresholds (verified against PostgreSQL benchmarks):**

| Strategy | Practical Limit | Migration | Compliance |
|----------|----------------|-----------|------------|
| Shared tables + RLS | Millions of tenants | Single migration run | Satisfies most auditors |
| Schema-per-tenant | ~1,000–10,000 tenants | Parallel migration per schema, catalog slowdowns | Good for most |
| Database-per-tenant | ~100–500 tenants | Migration against every DB, partial failure risk | Easiest to certify |

**Implementation pattern:**

```sql
-- Every data table carries tenant_id
ALTER TABLE findings ADD COLUMN installation_id BIGINT NOT NULL;

-- RLS policy (set role per connection via SET LOCAL)
CREATE POLICY tenant_isolation ON findings
  USING (installation_id = current_setting('app.current_installation_id')::BIGINT);

-- Worker sets context before any query
SET LOCAL app.current_installation_id = '12345678';
```

**Prisma note:** Use Prisma's `$executeRaw` to set the session variable before every transaction in the worker. Wrap in a Prisma middleware or explicit helper to guarantee it cannot be skipped.

---

## Webhook Reliability: At-Least-Once Delivery

GitHub guarantees at-least-once webhook delivery. Processing must be idempotent.

### Two-Layer Defense

**Layer 1: Redis dedup at ingestion (fast path)**
```
SET "dedup:{X-GitHub-Delivery}" "1" NX EX 259200
```
- `NX` (set-if-not-exists) is atomic — not a race condition
- TTL = 259,200 seconds (3 days) covers GitHub's full retry window
- On duplicate: return 200 immediately, never enqueue

**Layer 2: Postgres unique constraint (slow path)**
```sql
CREATE UNIQUE INDEX idx_webhook_delivery ON webhook_events(delivery_id);
```
- Catches duplicates that slipped through after Redis key expiry
- Use `INSERT ... ON CONFLICT DO NOTHING` — no application-level try/catch needed

**Idempotent side effects:**

All downstream actions must be idempotent:
- GitHub Check Runs: use `external_id` to find existing run before creating; update if exists
- PR comments: store comment `node_id` in DB; edit if exists rather than duplicate
- Autofix PRs: check for open PR with matching branch name before creating

---

## BullMQ Queue Architecture

### Queue Topology

```
webhook-ingestion    (priority: none, FIFO)
    ├── concurrency: 20
    ├── attempts: 3, backoff: exponential 2s, jitter: 0.3
    └── removeOnComplete: 100, removeOnFail: 500

detector-dispatch    (priority: numeric, 1=urgent)
    ├── concurrency: 50 (stateless work, I/O-bound)
    ├── attempts: 5, backoff: exponential 3s, jitter: 0.3
    └── Priority: user-facing repos = 1, batch = 100

ai-analysis          (priority: numeric)
    ├── concurrency: 10 (rate-limited by AI provider)
    ├── attempts: 3, backoff: fixed 10s (LLM errors are often transient)
    └── timeout: 60000ms per job

action-execution     (priority: numeric)
    ├── concurrency: 20
    ├── attempts: 5, backoff: exponential 5s
    └── Idempotency key stored in job data

dlq                  (dead letter queue — manual retry / alert only)
    ├── Populated by failed event handlers on all queues
    └── DLQWorker: log, alert, mark DB record terminal
```

### Fan-Out Pattern

BullMQ has no native fan-out broadcast. The correct pattern for CyclOps:

```
One webhook-ingestion job
        │
        ▼
WebhookIngestionWorker
        │
        ├─ queue.addBulk([
        │     { name: 'detector', data: { detectorId: 'lint', ... } },
        │     { name: 'detector', data: { detectorId: 'flaky-test', ... } },
        │     { name: 'detector', data: { detectorId: 'hanging', ... } },
        │  ])
        └─ Each job runs independently on detector-dispatch queue
```

`addBulk()` is a single Redis round-trip and atomic under BullMQ's Lua scripting. This is the recommended fan-out mechanism.

### BullMQ Flow Producers (for ordered dependency chains)

Use BullMQ's Flow Producer when outputs are dependent:

```
ai-analysis job (parent)
    └── action-execution job (child)
          └── output-delivery job (child)
```

Children cannot run until parent completes. Parent failure propagates to children.

### Dead Letter Queue Implementation

BullMQ has no built-in DLQ. Implement via the `failed` event:

```typescript
worker.on('failed', (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    dlqQueue.add('dead-letter', {
      originalQueue: queueName,
      jobData: job.data,
      error: err.message,
      failedAt: Date.now(),
    });
  }
});
```

---

## Detector Pipeline Ordering

### Ordering Rule: Heuristic Detectors First, AI Last

```
CI event arrives
      │
      ▼
Stage 1: Selector (O(1) per detector)
  - Each detector declares which events and failure signatures it handles
  - Filter: which detectors are applicable to this workflow run?
  - Result: active_detectors[] (typically 2-4 of 6 total)

Stage 2: Context Hydration (one GitHub API call batch)
  - Fetch: workflow run logs, annotations, commit diff, .cyclops.yml
  - Cache in job data so all detectors share one fetch

Stage 3: Heuristic Detectors (parallel, pure functions)
  - LintDetector     — regexp on log output (instantaneous)
  - SnapshotDetector — log pattern + changed file heuristics
  - SecretDetector   — log pattern + known expiry messages
  - FlakyTestDetector — historical failure rate from DB
  - HangingDetector  — duration + last-log timestamp
  - DriftDetector    — cross-repo workflow diff from DB
  All run in Promise.all(), no inter-detector dependencies

Stage 4: AI Analysis (only if detectors fired OR confidence < threshold)
  - Input: DetectorResult[] + raw ciContext
  - Purpose: classification confidence boost, root cause narrative,
             fix suggestion generation
  - AI does NOT run if: no detectors fired (skip entirely)
  - AI ALWAYS runs if: detector fired with confidence < 0.7
  - AI is OPTIONAL if: all detectors fired with confidence >= 0.7
    (still enqueued for narrative generation)

Stage 5: Action Engine
  - Reads final Finding (post-AI)
  - Executes action plan based on finding.category + tenant.config
```

**Rationale for this ordering:**

Heuristic detectors are cheap (microseconds, regexp-based) and deterministic. They provide structured signal to the AI layer. Feeding structured `DetectorResult[]` to the LLM gives it grounding — it classifies from evidence rather than hallucinating from raw logs. This reduces token usage, latency, and hallucination risk compared to sending raw CI logs directly to the AI.

The AI layer is a confidence amplifier and narrative generator, not the primary detection mechanism.

---

## GitHub App Installation Lifecycle

### Events to Handle

| Event | Action | Database Change |
|-------|--------|----------------|
| `installation.created` | Create tenant record, set status=ACTIVE | INSERT tenants |
| `installation.deleted` | Mark tenant DELETED, revoke cached tokens | UPDATE status=DELETED |
| `installation.suspend` | Mark tenant SUSPENDED, revoke cached tokens | UPDATE status=SUSPENDED |
| `installation.unsuspend` | Mark tenant ACTIVE, invalidate token cache | UPDATE status=ACTIVE |
| `installation_repositories.added` | Update repo scope in tenant config | UPDATE scoped_repos |
| `installation_repositories.removed` | Narrow repo scope in tenant config | UPDATE scoped_repos |

**Critical:** When a webhook arrives for a SUSPENDED or DELETED installation, the WebhookIngestionWorker must drop it immediately after loading tenant state from DB. Never process CI events for suspended tenants.

### Installation Token Caching

GitHub App installation tokens expire after 1 hour. Token generation adds latency and consumes a GitHub API call.

**Recommended pattern:**

```typescript
// packages/github/src/token-cache.ts
async function getInstallationToken(installationId: number): Promise<string> {
  const cacheKey = `gh:token:${installationId}`;

  // Try cache first (no lock needed for reads)
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  // Distributed lock prevents thundering herd on token generation
  const lock = await redlock.acquire(`gh:token:lock:${installationId}`, 5000);
  try {
    // Re-check after acquiring lock (another worker may have populated)
    const refreshed = await redis.get(cacheKey);
    if (refreshed) return refreshed;

    const token = await octokit.apps.createInstallationAccessToken({
      installation_id: installationId,
    });

    // Cache for 50 minutes (10 min buffer before 1hr expiry)
    await redis.setex(cacheKey, 3000, token.data.token);
    return token.data.token;
  } finally {
    await lock.release();
  }
}
```

On `installation.deleted` or `installation.suspend`, call `redis.del(cacheKey)` to invalidate immediately.

---

## GitHub API Rate Limit Handling

### Limits (HIGH confidence — official docs verified July 2026)

| Scope | Limit |
|-------|-------|
| Installation token, base | 5,000 req/hr |
| Installation token, max scaling | 12,500 req/hr (50 req/hr per repo over 20, 50 per user over 20) |
| GitHub Enterprise Cloud installation | 15,000 req/hr |
| Concurrent REST requests | 100 simultaneous |
| Content-creating requests (issues, PRs, comments) | 80/min, 500/hr |
| REST endpoint throughput | 900 points/min |

### Handling Strategy

**1. Per-installation rate limit isolation**

Each tenant's Octokit instance is rate-limited independently. Never share an Octokit instance across installations. The `packages/github` factory must instantiate a separate Octokit per `installationId`.

**2. Respect response headers before hitting limits**

```typescript
// Check headers on every response
const remaining = parseInt(response.headers['x-ratelimit-remaining']);
const reset = parseInt(response.headers['x-ratelimit-reset']);

if (remaining < 100) {
  // Back off proactively — delay next job for this installation
  await queue.rateLimit(reset * 1000 - Date.now());
  throw new DelayedError('Rate limit headroom low');
}
```

**3. Handle 429 and 403 (secondary rate limit)**

```typescript
if (response.status === 429 || response.status === 403) {
  const retryAfter = response.headers['retry-after'];
  await queue.rateLimit(parseInt(retryAfter) * 1000);
  throw new DelayedError('GitHub secondary rate limit');
}
```

**4. BullMQ per-installation rate limiting (Pro feature)**

With BullMQ Pro, assign each job a group key of `installationId` and configure per-group rate limits. Without Pro, implement application-level rate limiting via Bottleneck or token-bucket per installation.

**5. Prefer webhooks over polling**

Webhooks consume no REST API quota. Never poll workflow run status — always react to `workflow_run` webhook events. This preserves the API budget for actions (Check Runs, PR comments, PR creation).

**6. Burst webhook traffic**

GitHub may deliver many webhooks simultaneously during a large push or rerun event. The `apps/api` receiver returns 202 immediately without touching the GitHub API — it only writes to Redis. This completely insulates the rate limit budget from ingestion spikes. Rate-limited API calls only happen in `apps/worker`, which processes at controlled concurrency.

---

## Output Channel Selection

| Output | When to Use | Notes |
|--------|------------|-------|
| **GitHub Check Run** | Primary output for all CI analysis results | Only GitHub Apps can write (not OAuth). Status + conclusion lifecycle. Up to 50 annotations per `update_check_run` call (appended, not replaced). Link `details_url` to CyclOps dashboard (future). |
| **PR Comment** | Rich remediation narrative, one-click autofix links | Use for human-readable root cause + fix suggestion. Update existing comment (store node_id in DB) — never spam with duplicates. |
| **GitHub Issue** | Persistent tracking of un-auto-fixed problems (e.g., expired secrets, workflow drift) | Creates organizational visibility. Assign to team. Close issue when Finding resolved. |
| **Slack Alert** | Time-sensitive failures (hanging workflows, expired secrets) | Configured per-tenant in .cyclops.yml. Send via Slack Incoming Webhook, not Bot Token (simpler). |
| **Autofix PR** | When fix is deterministic and low-risk (snapshot regen, lint autofix) | Create from a bot branch. Request review from original committer. Do NOT auto-merge in MVP. |

**Check Run annotation limit:** Each `update_check_run` call accepts up to 50 annotations. For findings with more annotations, batch across multiple update calls before setting `status: completed`. Annotations are appended on each call.

**Check Run vs. Commit Status:** Check Runs are richer (annotations, markdown summary, action buttons) and must be used for CyclOps. Commit Statuses are the legacy alternative for non-GitHub Apps. CyclOps must use Check Runs.

---

## Monorepo Package Boundaries

### Recommended Structure

```
cyclops/
├── apps/
│   ├── api/                    # Fastify HTTP server
│   │   ├── src/routes/         # /webhooks/github, /health, /installations
│   │   ├── src/middleware/     # HMAC verification, request logging
│   │   └── src/server.ts
│   │
│   └── worker/                 # BullMQ worker processes
│       ├── src/workers/        # WebhookIngestion, DetectorDispatch,
│       │                       # AIAnalysis, ActionExecution, DLQ
│       └── src/index.ts        # Worker process entrypoint
│
├── packages/
│   ├── core/                   # Domain logic — no I/O dependencies
│   │   ├── src/detectors/      # LintDetector, FlakyTestDetector, etc.
│   │   ├── src/pipeline/       # Detector orchestration, selector, context
│   │   ├── src/types/          # DetectorContext, DetectorResult, Finding
│   │   └── src/actions/        # Action plan builder (pure, no execution)
│   │
│   ├── github/                 # GitHub API client, rate limiting, token cache
│   │   ├── src/client.ts       # Octokit factory (per installation)
│   │   ├── src/token-cache.ts  # Redis-backed installation token cache
│   │   ├── src/rate-limit.ts   # Rate limit middleware and budget tracker
│   │   ├── src/check-runs.ts   # Check Run builder and updater
│   │   └── src/webhooks.ts     # Webhook signature verification
│   │
│   ├── ai/                     # Vercel AI SDK wrappers
│   │   ├── src/analyze.ts      # generateObject() with Finding schema
│   │   ├── src/prompts/        # System + user prompt templates
│   │   └── src/providers.ts    # OpenAI / Anthropic / Gemini config
│   │
│   ├── db/                     # Prisma schema + generated client
│   │   ├── prisma/schema.prisma
│   │   ├── src/client.ts       # Prisma client singleton with RLS helper
│   │   └── src/rls.ts          # SET LOCAL app.current_installation_id
│   │
│   └── queue/                  # BullMQ queue definitions + job types
│       ├── src/queues.ts        # Queue instances (shared config)
│       ├── src/jobs.ts          # Job data type definitions (TypeScript)
│       └── src/flow.ts          # Flow producer definitions
│
└── turbo.json
```

### Package Dependency Rules

```
apps/api       → packages/github, packages/queue, packages/db
apps/worker    → packages/core, packages/github, packages/ai,
                 packages/queue, packages/db

packages/core  → (NO external I/O deps — pure functions only)
packages/ai    → packages/core (uses Finding types)
packages/github → packages/db (token persistence), packages/queue
packages/db    → (no internal deps)
packages/queue → (no internal deps)
```

**Critical rule:** `packages/core` must have zero I/O dependencies. Detectors are pure functions that receive a `DetectorContext` object and return `DetectorResult`. This makes them unit-testable without mocking and publishable as `@cyclops/core` for self-hosters.

---

## Build Order (Dependency Graph)

```
Layer 0 (no deps, build first):
  packages/db
  packages/queue

Layer 1 (depends only on Layer 0):
  packages/core        (depends on nothing internal)
  packages/github      (depends on packages/db, packages/queue)

Layer 2 (depends on Layer 1):
  packages/ai          (depends on packages/core)

Layer 3 (depends on Layer 2):
  apps/api             (depends on packages/github, packages/queue, packages/db)
  apps/worker          (depends on packages/core, packages/github,
                        packages/ai, packages/queue, packages/db)
```

Turborepo's `dependsOn` configuration enforces this. No circular dependencies are possible in this graph.

---

## Architecture Anti-Patterns to Avoid

### Anti-Pattern 1: Synchronous GitHub API calls in the webhook receiver

**What:** Calling GitHub API (token generation, Check Run creation) inside the Fastify route handler before returning 202.

**Why bad:** GitHub retries webhooks after 10 seconds of no response. Any I/O in the receiver creates timeout risk and ties the GitHub API rate limit to webhook burst volume.

**Instead:** Return 202 immediately after HMAC verification + Redis enqueue. All GitHub API calls happen in workers.

### Anti-Pattern 2: AI as primary detector

**What:** Sending raw CI logs directly to the LLM and asking it to classify the failure.

**Why bad:** High latency, high token cost, high hallucination rate. The LLM has no grounding in CyclOps-specific patterns. CI logs are noisy; important signal is buried.

**Instead:** Heuristic detectors extract structured evidence first. The AI receives `DetectorResult[]` with pre-identified signals and produces classification + narrative from grounded evidence.

### Anti-Pattern 3: One Octokit instance shared across tenants

**What:** Creating a single Octokit instance at startup and passing `installationId` per-request.

**Why bad:** Rate limits are per-installation. A misbehaving tenant's rate limit affects all others. Token rotation becomes complex.

**Instead:** `packages/github` factory creates an Octokit instance per `installationId`, each with its own rate limit budget tracker.

### Anti-Pattern 4: Application-level tenant filtering without RLS

**What:** Relying only on `WHERE installation_id = $tenantId` in Prisma queries with no database-level enforcement.

**Why bad:** Any query that forgets the WHERE clause leaks all tenant data. This is a structural security failure that cannot be caught by code review.

**Instead:** RLS policies at the PostgreSQL level are the backstop. Application-level filtering is still used (for performance), but RLS catches any bypass.

### Anti-Pattern 5: Processing webhooks for suspended installations

**What:** Enqueueing detector jobs without checking tenant status first.

**Why bad:** Suspended installations revoke the GitHub App's API access. All subsequent GitHub API calls will fail with 403. This generates noise in the DLQ and may produce incorrect findings.

**Instead:** `WebhookIngestionWorker` checks `tenant.status` before fanning out. Drop silently for SUSPENDED; log warning for DELETED.

---

## Scalability Considerations

| Concern | MVP (Railway) | Growth (~100 installs) | Scale (~1K+ installs) |
|---------|--------------|------------------------|----------------------|
| Webhook throughput | Single Fastify instance | Horizontal scale, load balancer | Rate limit per-IP at edge |
| Worker concurrency | Single worker process | Multiple worker replicas | Separate deployments per queue |
| DB connections | Single Prisma pool | PgBouncer in transaction mode | PgBouncer + read replicas |
| Redis | Single instance | Redis Sentinel | Redis Cluster or Upstash |
| Rate limits | Per-installation cache in Redis | Same | Per-installation BullMQ groups |
| AI costs | Single provider key | Cost tracking per tenant | Per-tenant provider key option |

---

## Sources

- GitHub Check Runs API: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks (HIGH confidence — official docs)
- GitHub Rate Limits for REST API: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api (HIGH confidence — official docs)
- GitHub Rate Limits for Apps: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps (HIGH confidence — official docs)
- BullMQ Retrying Failing Jobs: https://docs.bullmq.io/guide/retrying-failing-jobs (HIGH confidence — official docs)
- BullMQ Production Guide: https://docs.bullmq.io/guide/going-to-production (HIGH confidence — official docs)
- PostgreSQL Multi-Tenancy Patterns: https://www.adiagr.com/blog/07-saas-postgres-multitenancy-patterns/ (MEDIUM confidence — verified against multiple sources)
- Webhook Idempotency/Deduplication: https://www.hooklistener.com/learn/webhook-idempotency-and-deduplication (MEDIUM confidence — verified against Redis docs)
- Redis Idempotent Message Processing: https://redis.io/docs/latest/develop/data-types/streams/idempotency/ (HIGH confidence — official docs)
- GitHub App Installation Scaling: https://github.com/orgs/community/discussions/196652 (MEDIUM confidence — GitHub community)
- Turborepo Repository Structure: https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository (HIGH confidence — official docs)
- Webhook Fan-Out / DLQ Patterns: https://medium.com/@bhagyarana80/scaling-webhooks-fan-out-dlqs-idempotency-ebe412ae55d1 (LOW confidence — single blog; patterns verified independently)
