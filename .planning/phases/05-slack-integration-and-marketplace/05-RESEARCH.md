# Phase 5: Slack Integration & Marketplace - Research

**Researched:** 2026-07-14
**Domain:** GitHub Marketplace billing webhooks, Slack OAuth v2, billing state machines, BullMQ delayed jobs, Fastify status endpoints
**Confidence:** MEDIUM-HIGH (most verified with official docs; marketplace payload fields partially inferred)

---

## Summary

Phase 5 adds three distinct capabilities: (1) GitHub Marketplace listing and billing lifecycle management, (2) Slack OAuth v2 per-workspace bot token connection for channel alerts, and (3) a public `/status` endpoint. Each has hard constraints driven by the existing codebase shape.

The single biggest architectural finding is that **marketplace_purchase webhooks use a separate webhook secret from the GitHub App webhook secret** — these are configured in different places in GitHub's UI and validated with different env vars. The existing `/webhooks` route cannot be reused without secret-multiplexing logic; a separate `/marketplace/webhooks` route is cleaner. Additionally, marketplace events arrive without an `installation.id` field in the payload, which the current webhook handler requires, making a dedicated route mandatory.

The Slack migration path is significant: Phase 3 stubbed `handleSlackAlert` using a simple incoming webhook URL (`webhookUrl` from config). Phase 5 replaces this with a per-installation OAuth bot token stored encrypted via the existing AES-256-GCM pattern. The `chat.postMessage` API requires **channel IDs, not names**, and the bot must be a member of the channel before posting — these are the two most common runtime failures.

**Primary recommendation:** Add a dedicated `/marketplace/webhooks` route with `MARKETPLACE_WEBHOOK_SECRET`, extend the Installation model with `billingStatus`/`trialEndsAt`/`slackToken` fields, implement trial expiry as a lazy check inside `checkInstallationActive`, and use native `fetch` (Node 22 built-in) for Slack API calls — no Slack SDK required.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node 22 `fetch` | built-in | Slack API calls (`chat.postMessage`, `oauth.v2.access`) | Already used in Phase 3 `handleSlackAlert`; no new dependency |
| Prisma 7 | existing | Schema migration for new Installation fields | Already in the project |
| BullMQ | existing | Delayed job for trial expiry (optional path) | Already in the project |
| ioredis | existing | Redis health check in `/status` | `app.redis` is already decorated on the Fastify instance |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:crypto` `randomBytes` | built-in | Generate OAuth state param for CSRF | Slack OAuth callback route |
| `node:crypto` AES-256-GCM | built-in via `@cyclops/internal` | Encrypt Slack bot tokens | Store `xoxb-` tokens in DB |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native `fetch` for Slack API | `@slack/web-api` SDK | SDK adds ~2 MB and wraps the same HTTP calls; unnecessary for 2 methods (postMessage, oauth.v2.access) |
| Lazy trial expiry check | BullMQ delayed job | Delayed jobs can be lost on Redis flush; lazy check is durable and free |
| `@slack/oauth` package | Custom OAuth handler | Package is useful for enterprise grid apps; for single-workspace-per-install MVP, 3 route handlers suffice |

**Installation:** No new npm packages needed. All required functionality is available via built-ins or existing deps.

---

## Architecture Patterns

### Recommended Project Structure (new files only)

```
apps/api/src/
  routes/
    webhooks.ts           — existing; DO NOT add marketplace logic here
    marketplace.ts        — NEW: marketplace_purchase webhook route
    slack-oauth.ts        — NEW: GET /slack/install + GET /slack/oauth/callback
    status.ts             — NEW: GET /status (upgrade of existing health.ts)
  
apps/worker/src/
  workers/
    billing.ts            — NEW: BillingWorker processing marketplace_purchase jobs
  lib/
    billing-state.ts      — NEW: state machine transition functions
    slack-client.ts       — NEW: postMessage wrapper using bot token

packages/db/prisma/
  schema.prisma           — MODIFY: add fields to Installation
```

### Pattern 1: Separate Marketplace Webhook Route

**What:** The Marketplace listing is configured with its own webhook URL and secret in GitHub's Marketplace dashboard (separate from the GitHub App webhook secret in Developer Settings). Marketplace events do NOT include an `installation` field; they include `marketplace_purchase.account` instead.

**When to use:** Always — you cannot route marketplace events through the existing `/webhooks` handler.

**Critical difference from existing webhook route:**
- Existing: validates with `GITHUB_WEBHOOK_SECRET`, requires `installation.id` in payload
- Marketplace: validates with `MARKETPLACE_WEBHOOK_SECRET`, uses `marketplace_purchase.account.id` to identify the customer

```typescript
// Source: https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/configuring-a-webhook-to-notify-you-of-plan-changes
// apps/api/src/routes/marketplace.ts

export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  const secret = process.env["MARKETPLACE_WEBHOOK_SECRET"];
  if (!secret) throw new Error("MARKETPLACE_WEBHOOK_SECRET is required");

  app.post("/marketplace/webhooks", { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    // Same HMAC-SHA256 verification as existing webhook route
    if (!signature || !verifyWebhookSignature(secret, request.rawBody as string, signature)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    const body = request.body as any;
    const action = body.action; // "purchased" | "cancelled" | "changed" | "pending_change" | "pending_change_cancelled"
    const purchase = body.marketplace_purchase;
    const accountId: number = purchase.account.id;
    const accountLogin: string = purchase.account.login;
    const effectiveDate: string = body.effective_date;

    await billingQueue.add("billing", { action, accountId, accountLogin, purchase, effectiveDate });
    return reply.status(202).send({ status: "accepted" });
  });
}
```

### Pattern 2: Billing State Machine (lazy check approach)

**What:** `billingStatus` field on Installation tracks trial → active → suspended → cancelled. Trial expiry is detected lazily in `checkInstallationActive`, not via a scheduled job.

**When to use:** Every worker job already calls `checkInstallationActive`. Injecting the trial expiry check there means no new infrastructure.

**Prisma schema additions to `Installation`:**
```prisma
billingStatus       String    @default("trial")  // trial | active | suspended | cancelled
trialEndsAt         DateTime?
marketplacePlanId   Int?
marketplacePlanName String?
encryptedSlackToken String?
slackTeamId         String?
slackTeamName       String?
```

**Also required:** Add `@unique` to the `targetId` field on Installation to enable upsert-by-account for marketplace events (which have no installation ID at time of delivery).

**State transitions:**

| Event | Action | billingStatus transition |
|-------|--------|--------------------------|
| App installed (no marketplace) | `installation.created` | stays `trial`, set `trialEndsAt = now + 14d` |
| `marketplace_purchase` | `purchased` | `trial`, set `trialEndsAt = now + 14d` if `on_free_trial`, else `active` |
| `marketplace_purchase` | `changed` | `active` (plan upgrade/downgrade) |
| `marketplace_purchase` | `cancelled` | `cancelled` at `effective_date` |
| `marketplace_purchase` | `pending_change` | no state change (future change queued) |
| `marketplace_purchase` | `pending_change_cancelled` | no state change |

**Lazy trial expiry in checkInstallationActive:**
```typescript
// packages/db or apps/worker/src/lib/installation.ts
if (installation.billingStatus === "trial" && installation.trialEndsAt && installation.trialEndsAt < new Date()) {
  // Atomically transition to suspended
  await db.installation.update({ where: { id: installationId }, data: { billingStatus: "suspended" } });
  logger.info({ installationId }, "Trial expired — installation suspended");
  return { active: false, reason: "trial_expired" };
}
if (installation.billingStatus === "suspended" || installation.billingStatus === "cancelled") {
  return { active: false, reason: installation.billingStatus };
}
```

### Pattern 3: Slack OAuth v2 Flow

**What:** Two API routes handle the OAuth handshake. State param stored in Redis (TTL 10 min) for CSRF protection.

**Scopes needed:** `chat:write` (post messages to channels the bot has joined), `chat:write.public` (post to public channels without joining — avoids needing to manually add bot to every channel).

**oauth.v2.access response fields to store:**
- `access_token` → encrypt as `encryptedSlackToken` (AES-256-GCM, same as BYOK key)
- `team.id` → store as `slackTeamId`
- `team.name` → store as `slackTeamName`

```typescript
// apps/api/src/routes/slack-oauth.ts

// Step 1: Generate state, redirect to Slack
app.get("/slack/install", async (request, reply) => {
  const { installationId } = request.query as { installationId: string };
  const state = `${installationId}:${randomBytes(16).toString("hex")}`;
  // Store state in Redis with 10 min TTL
  await app.redis.set(`slack:oauth:state:${state}`, installationId, "EX", 600);
  
  const params = new URLSearchParams({
    client_id: process.env["SLACK_CLIENT_ID"]!,
    scope: "chat:write,chat:write.public",
    redirect_uri: process.env["SLACK_REDIRECT_URI"]!,
    state,
  });
  return reply.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

// Step 2: Exchange code for token
app.get("/slack/oauth/callback", async (request, reply) => {
  const { code, state } = request.query as { code: string; state: string };
  
  // Verify CSRF state
  const storedInstallationId = await app.redis.get(`slack:oauth:state:${state}`);
  if (!storedInstallationId) return reply.status(400).send({ error: "Invalid state" });
  await app.redis.del(`slack:oauth:state:${state}`);
  
  // Exchange code
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env["SLACK_CLIENT_ID"]!,
      client_secret: process.env["SLACK_CLIENT_SECRET"]!,
      code,
      redirect_uri: process.env["SLACK_REDIRECT_URI"]!,
    }),
  });
  const data = await resp.json() as { ok: boolean; access_token: string; team: { id: string; name: string } };
  if (!data.ok) return reply.status(400).send({ error: "Slack OAuth failed" });
  
  // Store encrypted token
  const encryptedSlackToken = encryptApiKey(data.access_token); // reuse existing crypto
  await db.installation.update({
    where: { id: parseInt(storedInstallationId, 10) },
    data: { encryptedSlackToken, slackTeamId: data.team.id, slackTeamName: data.team.name },
  });
  return reply.send({ ok: true });
});
```

### Pattern 4: Slack Message Posting with Bot Token

**What:** Replace `handleSlackAlert` webhook URL approach with bot token + `chat.postMessage`. Channel comes from `config.notifications.slack.channel` (already in CyclopsConfigSchema).

**CRITICAL:** Use channel IDs (e.g., `C123456`), not channel names. Channel names silently fail with `channel_not_found`. The `chat:write.public` scope allows posting to any public channel without the bot needing to join.

```typescript
// apps/worker/src/lib/slack-client.ts
export async function postSlackMessage(botToken: string, channelId: string, message: object): Promise<void> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, ...message }),
  });
  const data = await resp.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack postMessage failed: ${data.error}`);
}
```

**Fallback chain in handleSlackAlert:**
1. If `encryptedSlackToken` exists on installation → use bot token + `config.notifications.slack.channel`
2. Else if `config.notifications.slack.webhookUrl` exists → use legacy incoming webhook (Phase 3 path)
3. Else → skip with reason "no_slack_configured"

### Pattern 5: SLK-02 Repeat Failure Detection

**What:** Query Finding history for `(installationId, repositoryId, detectorType, ref)` within last 7 days. If count >= 3, route to team channel instead of per-committer path.

**Finding model already has:** `installationId`, `repositoryId`, `detectorType`, `ref`, `createdAt`, `deletedAt`.

```typescript
// In handleSlackAlert, before sending:
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const recentCount = await db.finding.count({
  where: {
    installationId,
    repositoryId,
    detectorType,
    ref,
    createdAt: { gte: sevenDaysAgo },
    deletedAt: null,
  },
});
const isRepeatFailure = recentCount >= 3;

// If repeat failure AND we have a bot token AND a team channel configured:
if (isRepeatFailure && encryptedSlackToken && config.notifications.slack.channel) {
  const botToken = decryptApiKey(encryptedSlackToken);
  await postSlackMessage(botToken, config.notifications.slack.channel, message);
}
```

Note: `config.notifications.slack.channel` in the existing schema is a `String` (channel name). **This needs to change to store a channel ID.** The schema comment or validation should note that users must provide the channel ID (starts with `C`, `G`, or `D`).

### Pattern 6: /status Endpoint

**What:** Public endpoint checking DB, Redis, and queue depths. Replaces the trivial `/health` route or runs alongside it.

```typescript
// apps/api/src/routes/status.ts
app.get("/status", async (_request, reply) => {
  const checks: Record<string, unknown> = {};
  let overall: "ok" | "degraded" | "down" = "ok";

  // DB check
  try {
    await db.$queryRaw`SELECT 1`;
    checks["db"] = { status: "ok" };
  } catch (err) {
    checks["db"] = { status: "down", error: (err as Error).message };
    overall = "down";
  }

  // Redis check
  try {
    await app.redis.ping();
    checks["redis"] = { status: "ok" };
  } catch (err) {
    checks["redis"] = { status: "down", error: (err as Error).message };
    overall = "down";
  }

  // Queue depths (from imported Queue instances)
  try {
    const counts = await webhookIngestionQueue.getJobCounts("wait", "active", "failed", "delayed");
    checks["queues"] = { status: "ok", webhookIngestion: counts };
  } catch (err) {
    checks["queues"] = { status: "degraded", error: (err as Error).message };
    if (overall === "ok") overall = "degraded";
  }

  return reply.status(overall === "down" ? 503 : 200).send({
    status: overall,
    timestamp: new Date().toISOString(),
    checks,
  });
});
```

**No authentication required** — this is public by design (MKT-03).

### Anti-Patterns to Avoid

- **Routing marketplace events through `/webhooks`:** Fails immediately — existing handler rejects payloads without `installation.id`, which marketplace events don't have.
- **Using channel names in `chat.postMessage`:** Returns `channel_not_found`. Always use channel IDs.
- **Storing Slack token in plaintext:** Use `encryptApiKey` from `@cyclops/internal` — same pattern as BYOK API keys.
- **Using a scheduled cron for trial expiry:** BullMQ delayed jobs can be lost if Redis is flushed; lazy check in `checkInstallationActive` is more durable.
- **Treating `marketplace_purchase cancelled` as immediate:** Paid plan cancellations take effect at end of billing cycle — use `effective_date` to schedule the state transition, not the webhook arrival time.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slack API calls | Custom HTTP wrapper | Native `fetch` + `chat.postMessage` endpoint | Already used in Phase 3; Slack API is simple REST |
| HMAC verification for Marketplace webhook | New crypto logic | Copy existing `verifyWebhookSignature` from `webhooks.ts` | Identical algorithm (HMAC-SHA256, X-Hub-Signature-256) |
| AES-256-GCM for Slack token | New encrypt/decrypt | `encryptApiKey`/`decryptApiKey` from `@cyclops/internal` | Already handles IV+authTag+ciphertext encoding |
| Trial expiry tracking | Separate cron service | Lazy check in existing `checkInstallationActive` | No new infrastructure; already called on every job |
| OAuth CSRF state | Redis TTL key | `redis.set(key, value, 'EX', 600)` | Redis already decorated on Fastify instance |
| Marketplace billing verification | Poll GitHub API | Handle webhooks + REST verification fallback | GitHub explicitly states apps "must handle marketplace purchase events" — webhook-first is correct |

**Key insight:** The existing `@cyclops/internal` crypto, `@cyclops/db` Prisma client, Redis decorator, and BullMQ queue infrastructure cover every dependency in this phase. No new packages are required.

---

## Common Pitfalls

### Pitfall 1: Marketplace Webhook Uses a Different Secret

**What goes wrong:** Developer uses `GITHUB_WEBHOOK_SECRET` to validate `marketplace_purchase` events, causing all marketplace deliveries to fail HMAC validation.

**Why it happens:** Marketplace listing and GitHub App are configured in separate GitHub UI sections, each with their own webhook secret. The same X-Hub-Signature-256 header is used for both, but with different secrets.

**How to avoid:** Add `MARKETPLACE_WEBHOOK_SECRET` env var and validate it in a dedicated `/marketplace/webhooks` route.

**Warning signs:** All marketplace webhook deliveries returning 401 in GitHub's delivery logs.

### Pitfall 2: Slack `channel_not_found` with Channel Names

**What goes wrong:** Storing `#general` in config and passing it to `chat.postMessage` — fails at runtime with `channel_not_found` even though the channel exists.

**Why it happens:** Slack API requires channel IDs (`C123456`), not display names. The API accepts names in some legacy contexts but not reliably with bot tokens.

**How to avoid:** Document clearly in `.cyclops.yml` schema that `notifications.slack.channel` must be a channel ID. Add a Zod validation pattern (`z.string().regex(/^[CGDW][A-Z0-9]+$/)`) or accept both and resolve names to IDs at startup.

**Warning signs:** `channel_not_found` in worker logs even with correct workspace connection.

### Pitfall 3: Bot Not in Channel (private channels)

**What goes wrong:** Bot token has `chat:write` but not `chat:write.public`; attempting to post to a private channel the bot hasn't been invited to returns `not_in_channel`.

**Why it happens:** `chat:write` alone requires the bot to be a member. `chat:write.public` only covers public channels.

**How to avoid:** Request both `chat:write` and `chat:write.public` scopes during OAuth. For private channel support, add bot invitation instructions to setup docs.

**Warning signs:** `not_in_channel` errors for some installations but not others.

### Pitfall 4: `cancelled` Action Timing

**What goes wrong:** Immediately setting `billingStatus = 'cancelled'` when `marketplace_purchase` + `cancelled` event arrives, cutting off service for customers who still have days left in their billing cycle.

**Why it happens:** GitHub sends the `cancelled` event with an `effective_date` that may be weeks in the future (end of billing period). Only free trial cancellations take effect immediately.

**How to avoid:** Compare `effective_date` to `now()`. If `effective_date > now()`, do not transition immediately — schedule the transition or check on next job run.

**Warning signs:** Customer complaints about losing access before their paid period ends.

### Pitfall 5: Missing `targetId` Unique Index

**What goes wrong:** When `marketplace_purchase` event arrives before `installation.created`, the upsert-by-account logic fails because there's no unique constraint on `targetId` to use for the upsert `where` clause.

**Why it happens:** The Installation model uses `id` (GitHub installation ID) as PK; marketplace events provide only the GitHub account ID (`marketplace_purchase.account.id` = `targetId`).

**How to avoid:** Add `@unique` to `targetId` in the Prisma schema before writing any marketplace handler.

**Warning signs:** Prisma throws "An operation failed because it depends on one or more records that were required but not found" when processing marketplace webhooks.

### Pitfall 6: Slack OAuth State Param Not Validated

**What goes wrong:** Omitting state param validation on the OAuth callback allows CSRF attacks — an attacker can trick an admin into connecting an attacker-controlled Slack workspace.

**Why it happens:** Developers skip state validation to simplify the callback handler.

**How to avoid:** Always verify the state value from Redis on callback. If state is missing or doesn't match, return 400 and do not exchange the code.

**Warning signs:** No Redis lookup in the callback route.

### Pitfall 7: Railway Shared vs Per-Service Env Vars

**What goes wrong:** `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` set only on `api` service — `worker` service can't read them if it ever needs them.

**Why it happens:** Railway scopes env vars per service by default.

**How to avoid:** Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` as Railway **Shared Variables** (Project Settings → Shared Variables) so they're available to all services. Add `MARKETPLACE_WEBHOOK_SECRET` the same way.

---

## Code Examples

### marketplace_purchase Payload Shape (HIGH confidence from GitHub REST API docs)

```typescript
// Source: https://docs.github.com/en/rest/apps/marketplace
// Inferred from REST API response + webhook docs cross-reference
interface MarketplacePurchasePayload {
  action: "purchased" | "cancelled" | "changed" | "pending_change" | "pending_change_cancelled";
  effective_date: string; // ISO 8601
  sender: { login: string; id: number; type: string };
  marketplace_purchase: {
    account: {
      type: "User" | "Organization";
      id: number;        // This is targetId on Installation
      login: string;     // This is accountLogin on Installation
      organization_billing_email?: string;
    };
    billing_cycle: "monthly" | "yearly";
    unit_count: number;
    on_free_trial: boolean;
    free_trial_ends_on: string | null;  // ISO 8601
    next_billing_date: string | null;   // ISO 8601
    plan: {
      id: number;
      name: string;
      description: string;
      monthly_price_in_cents: number;
      yearly_price_in_cents: number;
      price_model: "FREE" | "FLAT_RATE" | "PER_UNIT";
      has_free_trial: boolean;
      unit_name: string | null;
      bullets: string[];
    };
  };
  previous_marketplace_purchase?: { /* same shape */ };
}
```

### BullMQ One-Shot Delayed Job for Trial Expiry (alternative to lazy check)

```typescript
// Source: https://docs.bullmq.io/guide/jobs/delayed
// Add to billing handler when setting up a trial:
const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
const delay = trialEndsAt.getTime() - Date.now();

await billingQueue.add(
  "trial-expiry",
  { accountId, action: "trial-expired" },
  { delay, jobId: `trial-expiry:${accountId}` }
);
// Note: Use jobId deduplication so re-processing the purchased event
// doesn't create duplicate expiry jobs.
```

### BullMQ Queue Health Check

```typescript
// Source: https://docs.bullmq.io/guide/jobs/getters
const counts = await webhookIngestionQueue.getJobCounts("wait", "active", "failed", "delayed");
// Returns: { wait: number, active: number, failed: number, delayed: number }
```

### oauth.v2.access Token Exchange (HIGH confidence from official Slack docs)

```typescript
// Source: https://docs.slack.dev/reference/methods/oauth.v2.access/
const resp = await fetch("https://slack.com/api/oauth.v2.access", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: process.env["SLACK_CLIENT_ID"]!,
    client_secret: process.env["SLACK_CLIENT_SECRET"]!,
    code,                                         // from ?code= query param
    redirect_uri: process.env["SLACK_REDIRECT_URI"]!,
  }),
});
const data = await resp.json();
// data.ok: boolean
// data.access_token: "xoxb-..." (bot token)
// data.team.id: "T9TK3CUKW"
// data.team.name: "My Workspace"
// data.bot_user_id: "UXXXXXXXX"
// data.is_enterprise_install: false (for standard workspaces)
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Incoming webhook URL per-channel | OAuth bot token + `chat.postMessage` | Phase 3 → Phase 5 | Bot token allows dynamic channel routing; webhook URL is static |
| Simple `/health` returning `{ status: "ok" }` | `/status` with DB+Redis+queue depth checks | Phase 5 | Required for MKT-03; same Fastify route pattern |
| `suspended: Boolean` on Installation | `billingStatus: String` + `suspended: Boolean` | Phase 5 | `suspended` = GitHub App suspension; `billingStatus` = marketplace billing state |

**Deprecated/outdated in this phase:**
- `config.notifications.slack.webhookUrl` as primary Slack path: still a valid fallback, but new installations should use OAuth bot token path.

---

## Open Questions

1. **marketplace_purchase before installation.created ordering**
   - What we know: GitHub fires marketplace_purchase first, then installation.created
   - What's unclear: Whether the gap is milliseconds or seconds in practice; whether the worker concurrency means they interleave
   - Recommendation: Handle both orders defensively — upsert-by-targetId in marketplace handler; upsert-by-id in installation.created handler; both are idempotent

2. **channel ID vs channel name in .cyclops.yml**
   - What we know: Slack API requires channel IDs for reliable delivery; names work inconsistently
   - What's unclear: How to give users a good UX (they know `#general`, not `C01234`)
   - Recommendation: Accept both; resolve names to IDs at alert-send time using `conversations.list` if the value doesn't match the ID pattern. Add `channels:read` scope to OAuth.

3. **Marketplace listing minimum 100 installations requirement**
   - What we know: GitHub requires 100+ installations before approving a paid listing
   - What's unclear: Whether this blocks the initial listing draft (can list without approval for testing)
   - Recommendation: Submit as draft listing immediately; paid plans require publisher verification, which is separate from the 100-installation threshold. Draft listing can be used for development and testing.

4. **effective_date handling for pending cancellations**
   - What we know: Cancellations of paid plans take effect at end of billing cycle; `effective_date` is provided
   - What's unclear: Whether to set a BullMQ delayed job for the transition or check lazily
   - Recommendation: Store `billingCancelAt: DateTime?` on Installation; check lazily in `checkInstallationActive` (same pattern as trial expiry). Avoids BullMQ job loss risk.

---

## Sources

### Primary (HIGH confidence)
- Official GitHub docs: [Webhook events - marketplace_purchase](https://docs.github.com/en/webhooks/webhook-events-and-payloads#marketplace_purchase)
- Official GitHub docs: [Handling plan cancellations](https://docs.github.com/en/apps/github-marketplace/using-the-github-marketplace-api-in-your-app/handling-plan-cancellations)
- Official GitHub docs: [Pricing plans for GitHub Marketplace apps](https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/pricing-plans-for-github-marketplace-apps)
- Official GitHub docs: [Configuring Marketplace webhook](https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/configuring-a-webhook-to-notify-you-of-plan-changes)
- Official GitHub docs: [Marketplace REST API](https://docs.github.com/en/rest/apps/marketplace)
- Official Slack docs: [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
- Official Slack docs: [oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access/)
- Official Slack docs: [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- Official BullMQ docs: [Delayed jobs](https://docs.bullmq.io/guide/jobs/delayed)
- Official BullMQ docs: [Job getters / getJobCounts](https://docs.bullmq.io/guide/jobs/getters)
- Railway docs: [Shared variables](https://docs.railway.com/variables)

### Secondary (MEDIUM confidence)
- Marketplace payload field shape: inferred from REST API `/marketplace_listing/accounts/{id}` response structure + GitHub docs cross-reference; exact nested field names should be validated against a live test delivery
- `chat:write.public` scope behavior: confirmed from Slack community issues and docs; eliminates need to manually add bot to channels

### Tertiary (LOW confidence)
- Ordering of `marketplace_purchase` vs `installation.created` event delivery: inferred from GitHub documentation description of purchase flow; not explicitly confirmed with timing guarantees

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages needed; all paths use built-ins or existing deps
- Architecture: HIGH — patterns verified against official docs; route separation is unambiguous given current webhook handler constraints
- Marketplace payload fields: MEDIUM — top-level fields confirmed; nested `marketplace_purchase` object field names inferred from REST API response structure, should be validated with a test delivery
- Slack OAuth flow: HIGH — verified against official Slack docs
- Pitfalls: HIGH — webhook secret separation and channel ID requirements confirmed from official sources

**Research date:** 2026-07-14
**Valid until:** 2026-08-14 (Slack and GitHub APIs are stable; BullMQ API is stable at v5)
