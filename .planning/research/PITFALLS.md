# Domain Pitfalls: CI Intelligence Platform (GitHub App SaaS)

**Domain:** GitHub App SaaS / AI-powered CI analysis / Multi-tenant webhook processing
**Project:** CyclOps (cyclops[bot]) — TypeScript monorepo, Fastify + BullMQ + Redis + PostgreSQL + Prisma
**Researched:** 2026-07-13
**Confidence:** HIGH (all critical items verified against GitHub official docs or primary sources)

---

## Critical Pitfalls

Mistakes that cause data breaches, production outages, or require significant rewrites.

---

### CRITICAL-1: Installation Token Used After Expiry in Queued Jobs

**What goes wrong:**
GitHub App installation access tokens expire after exactly 1 hour with no extension option. A BullMQ job queued at T=0 that picks up a stored token at T=55m will succeed. The same job pattern at T=65m (e.g., delayed retry after a transient failure) will get 401s on every GitHub API call mid-execution. The job appears to "run" but all API calls silently fail or throw, and the token is already gone.

**Why it happens:**
Teams cache the token at webhook-receive time and pass it in job data. By the time the worker processes a backlogged or retried job, the token is expired. There is no GitHub mechanism to extend a token; you must re-request it.

**Consequences:**
- API calls return 401; jobs fail or produce incomplete results
- Retry storms: BullMQ retries → each retry fails with 401 → exhausts retry budget
- If error handling is loose, jobs are silently dropped

**Prevention (specific to this stack):**

1. **Never store installation tokens in job payloads.** Store only the `installation_id`.
2. **In the BullMQ worker's `process()` function, mint a fresh token at job start** using the App's private key JWT → `/app/installations/{installation_id}/access_tokens`. This adds ~200ms but guarantees freshness.
3. **For long-running workers** (e.g., log download + AI analysis exceeding 45 min): proactively refresh the token at the 45-minute mark using a background interval within the job, or split the job into a pipeline of smaller jobs each minting their own token.
4. **Cache tokens with TTL = 55 minutes** (not 60) in Redis, keyed by `installation_id`. Workers check cache first; if within 5 minutes of expiry, force-refresh.
5. Use `@octokit/auth-app` which handles JWT generation and token caching automatically — do not re-implement this.

**Warning signs:**
- Spike in 401 errors correlated with job queue depth increasing
- Jobs succeeding in low-load periods but failing under backlog
- Error logs showing `HttpError: Bad credentials` from Octokit

**Phase:** Phase 1 (GitHub App foundation) — must be solved before any queued API work.

---

### CRITICAL-2: App-Level JWT vs. Installation Token Confusion

**What goes wrong:**
GitHub Apps have two distinct auth contexts: the App JWT (signed with your private key, used only for App-level endpoints like listing installations or minting tokens) and the Installation Access Token (used for repo-level operations). Using the App JWT to call repo APIs returns 403 with a cryptic error. Using an installation token to call App-level endpoints similarly fails. Teams under time pressure conflate these two.

**Why it happens:**
The GitHub docs for each endpoint do not always prominently label which auth context is required. Octokit will accept either token type without warning — it only fails at the HTTP layer.

**Consequences:**
- Intermittent 403 errors that are hard to distinguish from permission scope issues
- Wasted debugging time chasing permission scopes when the real issue is token type

**Prevention:**
- Create two distinct Octokit instances: `appOctokit` (authenticated with App JWT via `@octokit/auth-app`) and `installationOctokit(installationId)` (authenticated with installation token). Never pass one where the other is expected.
- Codify this in a factory function: `getAppClient()` vs. `getInstallationClient(installationId)`. Type the return differently if possible.
- Add an integration test that calls a repo-level endpoint with `appOctokit` and expects a 403, as a regression guard.

**Warning signs:**
- 403 errors on endpoints that definitely have correct permission scopes configured
- Works in development (small queue, fresh tokens) but fails in staging under load

**Phase:** Phase 1.

---

### CRITICAL-3: Multi-Tenant Data Leakage via Missing installation_id Scoping

**What goes wrong:**
Every database query, cache key, and job that touches tenant-specific data must be scoped by `installation_id`. A single query missing a `WHERE installation_id = ?` clause can return another tenant's workflow runs, secrets, or analysis results. In a SaaS with GitHub Org-level installations, this is a serious security incident.

**Why it happens:**
Developers add new queries quickly, omitting the tenant scope under deadline pressure. ORM queries look correct syntactically but are missing the filter. Cache keys using just `repo_id` or `workflow_id` (which are not globally unique across GitHub orgs) collide between tenants.

**Consequences:**
- Tenant A sees Tenant B's CI analysis data — security incident requiring disclosure
- Redis cache poisoning: Tenant A's stale analysis overwrites Tenant B's live result

**Prevention:**
1. **PostgreSQL Row-Level Security (RLS):** Enable RLS on all tenant-scoped tables. Set a session variable `SET LOCAL app.current_installation_id = ?` at the start of every transaction. RLS policies enforce `installation_id = current_setting('app.current_installation_id')::bigint`. This makes it impossible to query another tenant's data even if application code omits the filter.
2. **Prisma middleware:** Add a Prisma middleware that injects `where: { installationId: ctx.installationId }` on all read operations for tenant-scoped models. This catches ORM-level omissions.
3. **Redis key namespacing:** All cache keys must follow `installation:{id}:{resource_type}:{resource_id}` — never use bare `repo_id` or `workflow_id` as keys.
4. **BullMQ queues:** Include `installationId` in every job payload and validate it matches the Octokit client being used at job start.
5. **Note on PgBouncer + RLS:** If using PgBouncer in transaction pooling mode, `SET LOCAL` is lost between statements. Use `SET` within an explicit transaction wrapper, or use session pooling. PgBouncer 1.21+ supports prepared statements in transaction mode, but Prisma requires its `pgbouncer=true` flag off on 1.21+ — use separate pooled vs. direct connection URLs.

**Warning signs:**
- Queries returning results for `installationId = null` or 0
- Cache hit rates suspiciously high (may indicate cross-tenant hits)
- Test suite passes but integration tests share a single `installation_id`

**Phase:** Phase 1 (data model) and Phase 2 (all feature queries must be reviewed).

---

### CRITICAL-4: Webhook Signature Verification Bypassed by Body Parsing

**What goes wrong:**
Fastify (and most Node.js frameworks) parse the request body before your route handler runs. HMAC-SHA256 signature verification requires the **raw bytes** of the body exactly as GitHub sent them. If your middleware has parsed and re-serialized the JSON body before verification, even minor differences (key ordering, whitespace normalization) cause every webhook to fail verification. Teams "fix" this by disabling signature verification — which allows any actor to forge webhooks.

**Why it happens:**
Fastify's default `Content-Type: application/json` handling parses the body automatically. If verification middleware runs after body parsing, it only has access to the re-serialized object, not the original bytes.

**Consequences:**
- All legitimate webhooks fail verification → service is broken
- Teams disable verification as a "temporary" fix → permanent security hole
- Forged webhooks can trigger CI reruns, PR creation, or Slack notifications

**Prevention:**
1. **Register a `rawBody` plugin** (e.g., `fastify-raw-body`) before any route handler. Verification middleware must use `req.rawBody` (the Buffer), not `req.body`.
2. **Verify before any other processing.** Make signature verification a Fastify preHandler hook that runs before business logic, not a middleware that runs after parsing.
3. **Use constant-time comparison** (`crypto.timingSafeEqual`) not `===` for the HMAC digest comparison.
4. Use `sha256=` prefix stripping correctly: the header value is `sha256=<hex>`, not just `<hex>`.
5. **Return 200 OK immediately after verification** (even if you can't process yet) — GitHub times out webhook delivery and retries if it doesn't get a 2xx within ~10 seconds.

**Warning signs:**
- All webhook deliveries showing as failed in GitHub App settings
- `X-Hub-Signature-256` verification always returning false
- 500 errors on the webhook endpoint

**Phase:** Phase 1.

---

## High Pitfalls

Mistakes that cause feature failures, cost blowout, or significant technical debt.

---

### HIGH-1: Duplicate Webhook Processing (At-Least-Once Delivery)

**What goes wrong:**
GitHub delivers webhooks at-least-once. In practice, network issues, GitHub infrastructure retries, and manual redeliveries from the GitHub App settings page all cause the same event to be delivered multiple times. Without idempotency, a single `workflow_run.completed` event can enqueue multiple BullMQ jobs, trigger multiple AI analyses, and create multiple PRs or Jira tickets.

**Why it happens:**
Each GitHub webhook delivery has a unique `X-GitHub-Delivery` GUID. Redeliveries of the same event share the same GUID. Teams process events without checking this GUID.

**Consequences:**
- Duplicate PRs created by the Action Engine
- Duplicate Slack/Jira notifications sent for the same CI failure
- Wasted LLM token spend on duplicate analysis
- AI analysis results overwriting each other with race conditions

**Prevention:**
1. **Idempotency table:** On webhook receipt, attempt `INSERT INTO webhook_events (delivery_id, received_at) VALUES (?, NOW())` with a unique constraint on `delivery_id`. If the insert fails (duplicate key), return `200 OK` immediately without processing.
2. **Use the `X-GitHub-Delivery` header** as the deduplication key, not the event payload contents (which may differ slightly between retries).
3. **BullMQ job IDs:** Use `jobId: deliveryId` when adding jobs. BullMQ silently discards jobs with duplicate IDs that are already in the queue, providing a second layer of deduplication.
4. **Action Engine idempotency:** Before creating a PR or sending a notification, check whether one already exists for this `(installation_id, workflow_run_id, detector_id)` tuple.

**Warning signs:**
- Duplicate Slack messages for the same failure
- Multiple open PRs with identical titles in the same repo
- Job counts in BullMQ much higher than webhook delivery counts

**Phase:** Phase 1 (webhook ingestion layer).

---

### HIGH-2: GitHub API Rate Limit Exhaustion in Worker Pools

**What goes wrong:**
GitHub Apps get 5,000 requests/hour per installation (primary), but workers can also hit secondary limits: 100 concurrent requests max, 900 REST API points/minute, 80 content-generating requests/minute (PRs, comments, issues). A BullMQ concurrency setting of 20 workers, each making 10 GitHub API calls, can hit secondary limits within minutes of a CI failure spike — without hitting the primary 5,000/hr limit at all.

**Why it happens:**
Teams configure BullMQ concurrency based on CPU capacity, not API rate budget. Secondary limits are less documented than the primary 5,000/hr limit. Content-generating limits (80/min) are easy to hit when auto-creating PRs.

**Consequences:**
- GitHub returns 429 with `Retry-After` header; workers that ignore this header immediately retry and get banned for longer
- Secondary rate limit abuse can result in temporary App suspension by GitHub
- Log downloads and analysis jobs get starved by Action Engine PR creation jobs

**Prevention:**
1. **Per-queue concurrency budgets:** Separate BullMQ queues for different job types (webhook ingestion, log analysis, action engine). Set concurrency limits that keep total concurrent GitHub API calls under 80.
2. **Respect `Retry-After`:** Octokit's `@octokit/plugin-throttling` handles 429 responses automatically with exponential backoff — install this plugin on all Octokit instances.
3. **Action Engine rate tracking:** Before creating a PR or comment, check remaining rate limit via `GET /rate_limit`. Cache this result with a 30-second TTL to avoid burning requests checking the limit.
4. **Primary limit math:** Log analysis requires: 1 token mint + 1 workflow run GET + 1 log download = 3 req per job. At 5,000/hr, that's ~1,666 log analysis jobs per installation per hour — plenty, but 80 concurrent PR creations exhaust the content-generating limit in 1 minute.
5. **Job priority:** Make action engine jobs lower priority than analysis jobs in BullMQ; an unprocessed analysis is better than a failed PR creation.

**Warning signs:**
- `SecondaryRateLimitError` in worker logs
- Sudden spike in job failures correlated with burst CI activity
- `X-RateLimit-Remaining` near 0 while `X-RateLimit-Limit` shows 5000

**Phase:** Phase 2 (worker architecture) and Phase 3 (Action Engine).

---

### HIGH-3: LLM Hallucination in Root Cause Analysis (False Confidence)

**What goes wrong:**
LLMs analyzing CI failure logs will confidently assert incorrect root causes. Given a flaky test output, the model may identify a specific line of application code as the cause when the actual failure is a network timeout in the test harness. The model's output reads as authoritative and actionable. Developers follow the suggestion, waste time, and lose trust in the tool.

**Why it happens:**
- Models are rewarded in training for producing confident, coherent-sounding answers
- CI logs contain ambiguous signals; the model pattern-matches to its training data rather than reasoning from the specific log content
- Truncated logs (see HIGH-4) mean the model is reasoning from incomplete evidence but doesn't know it

**Consequences:**
- Developer trust destroyed after one or two false root cause claims
- If Action Engine auto-creates PRs based on AI analysis, false positives create incorrect code changes
- Hallucinated file paths or error messages sent to Jira look unprofessional

**Prevention:**
1. **Structured output with confidence score:** Use Vercel AI SDK's `generateObject` with a Zod schema that requires the model to produce: `{ rootCause: string, confidence: "high"|"medium"|"low", evidence: string[], caveat: string }`. A required `caveat` field forces the model to articulate what it doesn't know.
2. **Confidence gating for actions:** Action Engine must not auto-create PRs or make code changes unless confidence is `"high"`. For `"medium"`, create a draft PR or send a notification with explicit uncertainty. For `"low"`, send an informational Slack message only.
3. **Evidence grounding:** Prompt must instruct the model to only cite specific log lines as evidence. Include the evidence in the structured output. If no specific log lines support the claim, confidence must be `"low"`.
4. **No hallucinated file paths:** Post-process AI output to verify any file paths mentioned exist in the repository (use GitHub API to check). Discard or flag claims about files that don't exist.
5. **Detector pre-filtering:** Run deterministic pattern-matching detectors first. Only invoke AI analysis when detectors produce a match. AI is an amplifier of a signal, not the signal itself.

**Warning signs:**
- AI analysis citing file paths that don't exist in the repo
- Root cause claims that don't match any text in the log excerpt provided
- Identical root cause analysis for different types of failures

**Phase:** Phase 2 (detector + AI analysis layer).

---

### HIGH-4: Log Truncation Causing Silent Analysis Gaps

**What goes wrong:**
GitHub Actions streaming logs are truncated at ~4MB. Compressed log archives downloaded via `GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs` can be hundreds of megabytes for large monorepo workflows. Sending a raw log to an LLM context window is impossible at scale — GPT-4o has a 128k token limit (~96k words). Sending only the first N characters means the actual failure (which is often at the end of the log) is never seen by the model. The model then analyzes the non-failure portion and produces a confident but wrong analysis.

**Why it happens:**
- Teams naively pass `log.substring(0, MAX_CHARS)` to the prompt
- The failure stack trace is at the bottom; the truncated portion is at the top (setup/install steps)
- No indicator in the prompt that the log was truncated

**Consequences:**
- AI analysis of setup steps (npm install, docker pull) rather than the actual failure
- Model produces confident analysis of a red herring
- LLM token costs for analyzing irrelevant content

**Prevention:**
1. **Tail-first extraction:** Extract the last N lines of the log (configurable, default 500 lines) rather than the first N. Failures appear at the end; setup noise is at the beginning.
2. **Step-level log fetching:** Use `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` to fetch per-step logs. Identify the failed step first (from the workflow run's job steps array), then fetch only that step's log. Dramatically reduces token consumption.
3. **Error pattern pre-extraction:** Run regex patterns (exit code lines, `Error:`, `FAILED`, stack traces) to extract candidate failure snippets before sending to the LLM. Send the candidates plus surrounding context (±20 lines), not the full log.
4. **Explicit truncation marker in prompt:** If log must be truncated, include `[LOG TRUNCATED — showing last 500 of 12,450 lines]` in the prompt. Instruct the model to flag if truncation may have removed relevant context.
5. **Token budget pre-check:** Before calling the LLM, estimate token count (rough: 1 token ≈ 4 chars). If the prepared log excerpt exceeds 80k tokens, apply further reduction with a second extraction pass.

**Warning signs:**
- AI analysis descriptions that only mention dependency installation issues
- Model citing line numbers that are very low (early in the log) for all analyses
- High token usage per analysis ($0.10+) with mediocre accuracy

**Phase:** Phase 2 (log processing pipeline).

---

### HIGH-5: Action Engine Over-Automation and PR Spam

**What goes wrong:**
The Action Engine creates PRs, reruns workflows, or sends notifications automatically. Without confidence thresholds and circuit breakers, a flaky test that fails every 30 minutes for 4 hours creates 8 PRs, 8 workflow reruns, and 8 Slack messages — all for the same underlying issue. This destroys developer trust and makes the tool feel worse than no tool.

**Why it happens:**
- Each `workflow_run.completed` event is processed independently
- No deduplication of actions across events for the same underlying issue
- Confidence thresholds set too low or not implemented
- No rate limiting per repo/installation for action creation

**Consequences:**
- GitHub repos flooded with bot PRs; team disables the app
- Slack channels spammed; notifications muted
- GitHub secondary rate limits hit from content creation (80 PRs/min limit)
- Negative user reviews on GitHub Marketplace

**Prevention:**
1. **Action deduplication:** Before creating a PR, check `(installation_id, repo_id, detector_id, branch)` for an existing open PR created by cyclops[bot] within the last 24 hours. If one exists, add a comment to the existing PR rather than creating a new one.
2. **Per-repo action rate limits:** Enforce a maximum of N actions per repo per hour (configurable, default: 3 PR creations, 5 reruns, 10 notifications). Track in Redis with a sliding window counter.
3. **Confidence minimum for PRs:** Only auto-create PRs with high confidence AND a specific, actionable fix. For everything else, use a comment on the commit or a Slack message.
4. **Cooldown period:** After taking an action on a workflow run failure, suppress further actions for the same `(repo, workflow_name, failure_pattern)` tuple for a configurable cooldown (default: 30 minutes).
5. **User control:** Ship an `Actions` settings page before or alongside the Action Engine. Users must be able to disable specific action types per repo. No auto-actions without a kill switch.

**Warning signs:**
- Multiple open PRs from cyclops[bot] with identical or near-identical content
- User feedback about notification spam before you've even noticed it
- GitHub secondary rate limit errors specifically on PR creation endpoints

**Phase:** Phase 3 (Action Engine) — must be solved before any auto-action ships.

---

### HIGH-6: Redis Memory Blowout from Log Payloads in Job Data

**What goes wrong:**
BullMQ stores all job data serialized in Redis. If log content is embedded in the job payload (e.g., to avoid re-fetching from GitHub), a single large workflow run log (50-200MB compressed, 200-500MB uncompressed) stored in Redis will exhaust memory quickly. With 10 concurrent jobs each with 100MB payloads, that is 1GB of Redis memory from job data alone — in addition to BullMQ's own operational keys.

**Why it happens:**
- Convenient to download the log in the webhook handler and pass it through the job
- Redis memory limits not set; `maxmemory-policy` left as default (`noeviction` not configured)
- BullMQ does not enforce a job payload size limit by default

**Consequences:**
- Redis OOM → BullMQ stops functioning entirely → all queue processing halts
- If `maxmemory-policy` is not `noeviction`, Redis silently evicts BullMQ operational keys → jobs disappear, workers stall

**Prevention:**
1. **Never store log content in BullMQ job payloads.** Job payloads must contain only identifiers: `installationId`, `workflowRunId`, `jobId`, `repoFullName`. Workers fetch logs from GitHub at processing time.
2. **Redis configuration:** Set `maxmemory-policy noeviction`. BullMQ docs explicitly require this. Set an appropriate `maxmemory` limit (e.g., 2GB for a dedicated Redis instance).
3. **Job payload size limit:** Implement an application-level check before `queue.add()`. If payload JSON exceeds 10KB, log a warning and strip the oversized fields.
4. **Tiered storage for large intermediates:** If log content must be cached between pipeline stages (e.g., download once, analyze in two passes), store it in S3 or a temp file and pass only the S3 key in the job payload.
5. **Monitor Redis memory:** Set an alert at 75% of `maxmemory`. Use `INFO memory` to track `used_memory_human` per environment.

**Warning signs:**
- Redis memory growing linearly with job volume, not queue depth
- BullMQ workers stalling with no error (Redis evicted operational keys)
- `OOM command not allowed` errors in logs

**Phase:** Phase 2 (job architecture, before log analysis ships).

---

## Moderate Pitfalls

Mistakes that cause delays, user frustration, or growing technical debt.

---

### MOD-1: Installation Suspension and Deletion Without Cleanup

**What goes wrong:**
When a user uninstalls or suspends CyclOps, GitHub sends `installation.deleted` or `installation.suspended` webhook events. If the platform doesn't handle these events, the installation's data remains in PostgreSQL, pending jobs for that installation continue to run (and fail with 401), and Redis may continue to accumulate state for the installation. The next log analysis for that installation creates confusing ghost data.

**Prevention:**
1. Handle `installation.deleted` and `installation.suspended` webhook events explicitly.
2. On `deleted`: mark the installation as deleted in PostgreSQL, cancel all pending BullMQ jobs for that `installation_id`, and schedule a cleanup task for personal data (GDPR/SOC2 consideration).
3. On `suspended`: mark as suspended; reject new job enqueuing for that `installation_id`; return early in workers after checking installation status before minting a new token.
4. Implement a `validateInstallation()` helper that workers call at job start, before any API call.

**Phase:** Phase 1 (lifecycle events alongside installation).

---

### MOD-2: Permission Scope Changes Require Re-Authorization

**What goes wrong:**
Adding new permission scopes to the GitHub App (e.g., adding `issues: write` for Jira-like issue creation) requires every existing installation to re-authorize. GitHub sends an email to org owners and sets the installation to a "pending permissions" state. Until re-authorized, API calls for the new scope return 403. The app appears broken for existing installations until they take action.

**Prevention:**
1. **Plan permissions upfront.** Before Phase 1 ships, enumerate all permissions needed across all planned phases. Request the full set from the start, even if some permissions are not used until Phase 3.
2. **Document the re-authorization impact** in the roadmap. Any mid-roadmap permission addition is a breaking change for existing users.
3. **Handle 403 gracefully:** In the Action Engine, catch 403 on new-scope operations. Surface a clear in-app message ("CyclOps needs additional permissions — click here to approve") rather than a generic error.
4. **Monitor re-authorization rate** after a permission change. If < 80% of installations re-authorize within 72 hours, send a proactive notification.

**Phase:** Phase 1 (design) — the permission list must be finalized before the app is submitted to Marketplace.

---

### MOD-3: PostgreSQL Connection Pool Exhaustion in BullMQ Workers

**What goes wrong:**
BullMQ workers run as separate Node.js processes (or high-concurrency threads). Each Prisma Client instance opens a connection pool (default: `min=2, max=10`). With 5 worker processes each at concurrency=10 and `max=10` pool connections, that is 50+ database connections. PostgreSQL's default `max_connections` is 100; Railway's managed Postgres instances often default to 25. Under load, workers fail with `Too many clients` and begin failing at the Prisma layer, not the GitHub API layer.

**Prevention:**
1. **Use PgBouncer in front of PostgreSQL.** All workers connect through PgBouncer, which multiplexes to a smaller number of actual DB connections.
2. **Prisma configuration for BullMQ workers:** Use `connection_limit=2` in the Prisma database URL for worker processes. Workers do short, non-overlapping transactions; they don't need large pools.
3. **Separate Prisma instances for workers vs. API server.** The API server (Fastify) can use a larger pool; workers should use minimal connections.
4. **PgBouncer + Prisma caveat:** Use a `DATABASE_URL` with PgBouncer (pooled) for runtime queries and a `DIRECT_URL` without PgBouncer for Prisma migrations. Set `directUrl` in `schema.prisma`.

**Phase:** Phase 2 (worker infrastructure).

---

### MOD-4: npm SDK Dual ESM/CJS Output Pitfalls

**What goes wrong:**
If CyclOps ships a public SDK (e.g., a detector API or webhook client), dual ESM/CJS publishing is still painful in 2025. TypeScript's `tsc` cannot emit `.cjs` and `.d.cts` files from a single source — it requires separate build configurations. Without correct `exports` field in `package.json`, consumers may get "Cannot use import statement in a module that uses require()" or "require() of ES module is not supported" depending on their project setup.

**Prevention:**
1. **Use `tsup` for SDK builds**, not `tsc` directly. `tsup` handles dual output (`.js`/`.cjs`, `.d.ts`/`.d.cts`) from a single command.
2. **`package.json` exports field must be correct:**
   ```json
   "exports": {
     ".": {
       "import": "./dist/index.js",
       "require": "./dist/index.cjs",
       "types": "./dist/index.d.ts"
     }
   }
   ```
3. **Set `moduleResolution: "bundler"` or `"nodenext"` in `tsconfig.json`** for the SDK package. `"node"` (legacy) will produce subtle ESM incompatibilities.
4. **Pin major versions in the SDK.** Any breaking API change in a minor version version breaks consumers who use `"^"` ranges. Adopt semantic versioning strictly.
5. **Test with both `import` and `require`** in CI using separate test fixtures.

**Phase:** Phase 4 (SDK/public API — if it ships).

---

### MOD-5: GitHub Marketplace Approval Process Gotchas

**What goes wrong:**
Teams build the full product and then discover at Marketplace submission time that they are blocked on requirements they didn't anticipate: no verified publisher org, app not transferred from personal account, or the review process taking 2-4 weeks for paid apps.

**Verified findings from GitHub docs:**
- **100 installation minimum** before a paid listing can be approved. Free listings have no installation minimum.
- **Organization ownership required:** App must be owned by an organization, not a personal GitHub account.
- **Marketplace webhook handling required:** The app must handle `marketplace_purchase` events (new purchase, upgrade, downgrade, cancellation, free trial). These are separate from standard GitHub App webhooks.
- **Status page required:** A publicly accessible status page URL must be provided at submission time.
- **Review timeline:** Community reports indicate 2-4 weeks for initial review; longer for paid apps with billing flow verification.

**Prevention:**
1. Create the organization that will own CyclOps before Phase 1 development starts.
2. Transfer the App registration to the org immediately.
3. Build `marketplace_purchase` webhook handlers before submitting for review, even if launching free-only initially.
4. Set up a status page (even a simple Statuspage.io free tier) before submission.
5. For paid plans: build the full billing flow (upgrade/downgrade/cancel) before submission. GitHub's review will test it.

**Phase:** Phase 1 (org setup) and Phase 5 (Marketplace submission prep).

---

## Minor Pitfalls

---

### MINOR-1: Webhook Endpoint Availability at Marketplace Review Time

**What goes wrong:**
GitHub Marketplace reviewers will test that your webhook endpoint is reachable and responds with 2xx within the timeout window. If the endpoint is behind a VPN, returns 5xx, or is on a development URL at submission time, the review fails.

**Prevention:** Ensure the production webhook URL is live and publicly accessible before submitting for Marketplace review. GitHub requires webhooks to be set to "Active" in the App settings before submission.

**Phase:** Phase 5.

---

### MINOR-2: Token Cost Blowout from Untracked LLM Usage

**What goes wrong:**
Without per-request token tracking, it is impossible to know which installation, repo, or failure type drives cost. A single misconfigured prompt sending 50k tokens per request at scale can produce unexpected monthly bills with no visibility into which customer or feature is responsible.

**Prevention:**
1. Use Vercel AI SDK's `onFinish` callback to log `usage.promptTokens` and `usage.completionTokens` per request, tagged with `installation_id`, `repo_id`, `detector_id`, and `model`.
2. Set a hard token budget per analysis call (e.g., `maxTokens: 2000` for the completion). Pre-calculate the prompt token count and reject requests that would exceed the budget before making the API call.
3. Implement per-installation monthly token caps with a configurable limit and a soft warning at 80%.

**Phase:** Phase 2 (AI analysis layer).

---

### MINOR-3: Vercel AI SDK Structured Output Schema Fragility

**What goes wrong:**
Different LLM providers handle `z.optional()` fields differently — some return `null`, some omit the key, some return `""`. Zod schemas that don't account for all three variants will fail validation for some providers or model versions, throwing at runtime.

**Prevention:**
1. Use `z.string().optional().nullable()` for all optional string fields.
2. Add schema validation tests using `zod.safeParse()` against known provider response shapes.
3. Wrap `generateObject` calls in try/catch; on schema validation failure, fall back to `generateText` and parse manually, logging the validation error for schema improvement.

**Phase:** Phase 2.

---

## Phase-Specific Warning Map

| Phase | Topic | Highest Risk | Mitigation |
|-------|-------|-------------|------------|
| Phase 1 | GitHub App auth setup | CRITICAL-1, CRITICAL-2 | Use `@octokit/auth-app`; never store tokens in jobs |
| Phase 1 | Webhook ingestion | CRITICAL-4, HIGH-1 | Raw body for HMAC; idempotency table on `X-GitHub-Delivery` |
| Phase 1 | Data model | CRITICAL-3 | PostgreSQL RLS + Prisma middleware from day one |
| Phase 1 | Installation lifecycle | MOD-1, MOD-2 | Handle `installation.deleted/suspended`; lock in all permission scopes |
| Phase 2 | Log fetching | HIGH-4, HIGH-6 | Step-level logs + tail extraction; never store logs in Redis/BullMQ |
| Phase 2 | AI analysis | HIGH-3, MINOR-2, MINOR-3 | Structured output with confidence; token tracking; Zod schema robustness |
| Phase 2 | Worker infrastructure | HIGH-2, MOD-3 | Octokit throttling plugin; PgBouncer; per-queue concurrency limits |
| Phase 3 | Action Engine | HIGH-5 | Confidence gating; action deduplication; per-repo rate limits; kill switches first |
| Phase 4 | SDK packaging | MOD-4 | `tsup` dual output; correct `exports` field; strict semver |
| Phase 5 | Marketplace | MOD-2, MOD-5, MINOR-1 | Transfer app to org; build billing handlers; status page; 100 installs for paid |

---

## Sources

- [GitHub Docs: Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub Docs: Generating an installation access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub Docs: Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub Docs: Requirements for listing an app on GitHub Marketplace](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app)
- [GitHub Docs: Approving updated permissions for a GitHub App](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)
- [GitHub Community: Token seems to expire after 1h — actions/create-github-app-token #121](https://github.com/actions/create-github-app-token/issues/121)
- [GitHub Changelog: GitHub Apps can now use the client ID to fetch installation tokens (May 2024)](https://github.blog/changelog/2024-05-01-github-apps-can-now-use-the-client-id-to-fetch-installation-tokens/)
- [GitHub Community: Streaming logs are limited to ~4mb — Discussion #127903](https://github.com/orgs/community/discussions/127903)
- [BullMQ GitHub Issue: Jobs taking too much space in Redis #2734](https://github.com/taskforcesh/bullmq/issues/2734)
- [BullMQ Docs: Going to production](https://docs.bullmq.io/guide/going-to-production)
- [Prisma Docs: Connection pool](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool)
- [TypeScript in 2025 with ESM and CJS npm publishing is still a mess — Liran Tal](https://lirantal.com/blog/typescript-in-2025-with-esm-and-cjs-npm-publishing)
- [Vercel AI SDK in Production: What Docs Don't Cover (2026) — Madgeek](https://madgeek.ai/blog/vercel-ai-sdk-production-what-docs-dont-tell-you)
- [Multi-Tenant SaaS Data Isolation: RLS, Tenant Scoping with Prisma — DEV Community](https://dev.to/whoffagents/multi-tenant-saas-data-isolation-row-level-security-tenant-scoping-and-plan-enforcement-with-1gd4)
- [Avoiding Redis Crashes with BullMQ: Memory Monitoring Basics](https://medium.com/@lior.bardov/avoiding-redis-crashes-with-bullmq-memory-monitoring-basics-5a978b28f9c6)
- [Webhook Idempotency and Deduplication — Hooklistener](https://www.hooklistener.com/learn/webhook-idempotency-and-deduplication)
- [Hallucination Root Cause Analysis: How to Diagnose and Prevent LLM Failure Modes — InsightFinder AI](https://insightfinder.com/blog/hallucination-root-cause-analysis-llm-failure-modes/)
