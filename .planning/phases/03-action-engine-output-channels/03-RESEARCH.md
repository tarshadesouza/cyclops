# Phase 3: Action Engine & Output Channels - Research

**Researched:** 2026-07-13
**Domain:** GitHub REST API (Check Runs, PR Comments, Git Data API, Actions), BullMQ worker design, YAML config parsing, PostgreSQL schema design
**Confidence:** HIGH

---

## Summary

Phase 3 wires the action-execution queue (already defined) to real GitHub outputs: a consolidated, in-place PR comment; a cyclops Check Run on every commit; autofix PRs for high-confidence Lint and Snapshot failures; plus five secondary actions (flaky rerun, hanging cancel, Slack alert, GitHub Issue, rate limiting). All actions are guarded by kill switches read from `.cyclops.yml`.

The project uses `@octokit/app` v16 + `@octokit/core` v7 with NO `@octokit/plugin-rest-endpoint-methods`. Every GitHub API call must follow the existing pattern: `(octokit as any).request("VERB /path", params)`. `js-yaml` is already a direct dependency of `@ciintel/detectors` and available in the pnpm store; add it directly to `apps/worker`. Zod is already present everywhere.

The most important structural constraint is that `packages/core` must remain I/O-free. Config schema (Zod) lives in `packages/core`; config loading (file fetch + yaml parse) lives in a new `packages/config` that imports `@ciintel/github`. All new DB tables require a Prisma migration before any action handler can ship.

**Primary recommendation:** Ship in strict wave order — DB schema first, config second, PR comment + Check Run third (core output), autofix PRs fourth, secondary actions fifth. Never build deduplication or rate limiting with custom logic; use the DB tables for durable state and Redis SET EX for the existing 24-h dedup namespace.

---

## Standard Stack

### Core (no new packages needed for main path)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@octokit/app` | 16.1.2 (installed) | GitHub API calls via installation token | Already in `@ciintel/github`; use `getInstallationClient()` |
| `zod` | 3.24.x (installed) | Config schema + job payload validation | Already used project-wide |
| `js-yaml` | 4.1.0 (installed) | Parse `.cyclops.yml` YAML | Direct dep of `@ciintel/detectors`; add to worker and packages/config |
| `bullmq` | 5.79.x (installed) | Action-execution queue worker | Already wired |
| `pino` | 9.x (installed) | Structured logging | Already used in all workers |

### New Dependencies Required

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `js-yaml` | ^4.1.0 | Add as direct dep to `apps/worker` | Config loading in worker |
| `@types/js-yaml` | ^4.0.9 | TypeScript types | Dev dep alongside js-yaml |

**No Slack SDK needed.** Use native `fetch()` to POST to `SLACK_WEBHOOK_URL`. Node 22 has `fetch` built in.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| js-yaml + zod | `yaml` (newer package) | js-yaml already installed; not worth switching |
| DB table for ActionDedup | Redis SET EX | Redis namespace `installation:{id}:delivery:{id}` already used; but dedup key is per (repo, detector, branch), not delivery. DB table is more queryable and survives Redis flush. Use DB. |
| Git Data API for autofix commits | `simple-git` / subprocess git clone | Worker on Railway has no local repo; Git Data API is the only viable approach without a build sandbox |

**Installation:**
```bash
pnpm --filter @ciintel/worker add js-yaml
pnpm --filter @ciintel/worker add -D @types/js-yaml
pnpm --filter @ciintel/config add js-yaml @ciintel/github zod
pnpm --filter @ciintel/config add -D @types/js-yaml typescript @types/node
```

---

## Architecture Patterns

### Recommended Project Structure Changes

```
packages/
├── config/              # NEW: .cyclops.yml schema (I/O-free) + loader (has I/O)
│   ├── src/
│   │   ├── schema.ts    # Zod CyclopsConfigSchema — no imports from @ciintel/github
│   │   ├── loader.ts    # fetchConfig(octokit, owner, repo, ref) — imports @ciintel/github
│   │   └── index.ts
│   └── package.json

apps/worker/src/
├── workers/
│   ├── action-execution.ts    # NEW: replaces phase3-placeholder
│   └── ...existing workers
├── lib/
│   ├── github-outputs.ts      # NEW: PR comment upsert, check run, annotations
│   ├── github-autofix.ts      # NEW: branch/commit/PR creation via Git Data API
│   ├── github-actions.ts      # EXISTING: reuse getRepoInfo(), fetchJobLogExcerpt()
│   └── installation.ts        # EXISTING
```

### Pattern 1: Action Handler Map (Discriminated Dispatch)

**What:** A `Record<ActionType, Handler>` mapping where each handler is a function receiving a shared context. The worker validates the action type, loads shared context once, then delegates.

**When to use:** Any queue worker serving 8+ distinct action types. Avoids a massive switch statement and makes each handler independently testable.

```typescript
// Source: established BullMQ + TypeScript pattern
type ActionContext = {
  job: Job<ActionExecutionJob>;
  octokit: Octokit;
  db: ReturnType<typeof getTenantClient>;
  config: CyclopsConfig;
  finding: Finding;
  owner: string;
  repo: string;
  log: pino.Logger;
};

type Handler = (ctx: ActionContext) => Promise<void>;

const HANDLERS: Record<ActionType, Handler> = {
  'upsert-pr-comment':        handleUpsertPrComment,
  'update-check-run':         handleUpdateCheckRun,
  'create-autofix-pr-lint':   handleAutofixLint,
  'create-autofix-pr-snapshot': handleAutofixSnapshot,
  'rerun-workflow':            handleRerunWorkflow,
  'cancel-workflow':           handleCancelWorkflow,
  'send-slack-alert':          handleSlackAlert,
  'create-github-issue':       handleCreateGithubIssue,
};

// In the worker processor:
const handler = HANDLERS[actionType];
if (!handler) {
  log.warn({ actionType }, 'Unknown action type — skipping');
  return { skipped: true };
}
await handler(ctx);
```

### Pattern 2: PR Comment Upsert (DB-tracked, idempotent)

**What:** Store the GitHub comment ID in a `PrComment` DB table keyed by `(installationId, repositoryId, prNumber)`. On each action, look up the row first; PATCH if found, POST if not. Always re-read ALL findings for the workflow run to render the consolidated body.

**When to use:** Every `upsert-pr-comment` action. Never list GitHub comments to find the bot's comment — that requires paginating and parsing, and is fragile; DB tracking is authoritative.

```typescript
// Source: GitHub REST API docs + deduced from project pattern
async function upsertPrComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  installationId: number,
  repositoryId: number,
  db: any
): Promise<void> {
  const existing = await db.prComment.findUnique({
    where: { installationId_repositoryId_prNumber: { installationId, repositoryId, prNumber } },
  });

  if (existing) {
    await (octokit as any).request(
      'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
      { owner, repo, comment_id: existing.githubCommentId, body }
    );
  } else {
    const resp = await (octokit as any).request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { owner, repo, issue_number: prNumber, body }
    );
    await db.prComment.create({
      data: { installationId, repositoryId, prNumber, githubCommentId: resp.data.id },
    });
  }
}
```

### Pattern 3: Cyclops Check Run Lifecycle

**What:** Create a check run at the start of action execution (`status: 'in_progress'`), then PATCH it to `completed` with findings, annotations, and a markdown summary. Store the cyclops-created check run ID on the Finding so reruns can update it.

**When to use:** Every analyzed commit (ACT-03, ACT-04).

```typescript
// Source: GitHub REST API docs (checks/runs)
// CREATE
const createResp = await (octokit as any).request(
  'POST /repos/{owner}/{repo}/check-runs',
  {
    owner, repo,
    name: 'Cyclops CI Analysis',   // consistent name is required for stable UI
    head_sha: sha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
  }
);
const cyclopsCheckRunId = createResp.data.id;

// UPDATE with results (annotations max 50 per call — see Pitfalls)
await (octokit as any).request(
  'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
  {
    owner, repo,
    check_run_id: cyclopsCheckRunId,
    status: 'completed',
    conclusion: hasFinding ? 'failure' : 'success',
    completed_at: new Date().toISOString(),
    output: {
      title: 'Cyclops Analysis',
      summary: markdownSummary,          // rendered markdown shown in Checks tab
      annotations: first50Annotations,   // max 50
    },
  }
);
```

### Pattern 4: Autofix PR via Git Data API (no local clone)

**What:** Use the GitHub Git Data API to create a commit directly from file content, without cloning the repo. Requires: (1) fetch current file(s), (2) create blobs, (3) create tree, (4) create commit, (5) create branch ref, (6) create PR.

**When to use:** Lint and Snapshot autofix PRs (ACT-05, ACT-06). Worker runs on Railway with no local filesystem access to the target repo.

```typescript
// Source: GitHub REST API docs (git/blobs, git/trees, git/commits, git/refs, pulls)

// 1. Get current file content + tree SHA
const fileResp = await (octokit as any).request(
  'GET /repos/{owner}/{repo}/contents/{path}',
  { owner, repo, path: affectedFile, ref: sha }
);
const currentTreeSha = /* from commit */ '...';

// 2. Create new tree with fixed content (inline content — no separate blob call needed)
const treeResp = await (octokit as any).request(
  'POST /repos/{owner}/{repo}/git/trees',
  {
    owner, repo,
    base_tree: currentTreeSha,
    tree: [
      { path: affectedFile, mode: '100644', type: 'blob', content: fixedContent },
    ],
  }
);

// 3. Create commit
const commitResp = await (octokit as any).request(
  'POST /repos/{owner}/{repo}/git/commits',
  {
    owner, repo,
    message: 'fix(lint): auto-fix ESLint violations [cyclops]',
    tree: treeResp.data.sha,
    parents: [sha],
  }
);

// 4. Create branch ref
const branchName = `cyclops/autofix/lint/${sha.slice(0,7)}-${Date.now()}`;
await (octokit as any).request(
  'POST /repos/{owner}/{repo}/git/refs',
  { owner, repo, ref: `refs/heads/${branchName}`, sha: commitResp.data.sha }
);

// 5. Create PR
const prResp = await (octokit as any).request(
  'POST /repos/{owner}/{repo}/pulls',
  {
    owner, repo,
    title: `fix(lint): auto-fix ESLint violations on ${sha.slice(0,7)}`,
    body: `Automated fix by cyclops[bot].\n\nFinding: ${findingId}\nConfidence: ${confidence}`,
    head: branchName,
    base: targetBranch,  // finding.ref
    draft: false,
  }
);
```

### Pattern 5: .cyclops.yml Config Loading

**What:** Fetch `.cyclops.yml` from the repo root at the ref being analyzed, parse with js-yaml, validate with Zod using `.catch()` defaults, return merged config. Cache per (installationId, repositoryId) with a short TTL (e.g., 60s) in a module-level Map.

**When to use:** At the start of every action-execution job, before any kill switch check.

```typescript
// Source: js-yaml docs + zod docs
import yaml from 'js-yaml';
import { CyclopsConfigSchema } from '@ciintel/config';

export async function fetchConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<CyclopsConfig> {
  try {
    const resp = await (octokit as any).request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner, repo, path: '.cyclops.yml', ref }
    );
    const raw = Buffer.from(resp.data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    const parsed = yaml.load(raw);
    // safeParse: on any validation error, fall back to defaults
    const result = CyclopsConfigSchema.safeParse(parsed);
    return result.success ? result.data : CyclopsConfigSchema.parse({});
  } catch {
    // 404 or parse error — return defaults
    return CyclopsConfigSchema.parse({});
  }
}
```

### Anti-Patterns to Avoid

- **Listing GitHub comments to find the bot's comment**: Fragile, paginated, breaks if comment is old. Use DB-tracked comment ID.
- **One action job per action type dispatched from AI analysis**: The current placeholder dispatches ONE action job per finding. Phase 3 should treat this as an "orchestrate all actions for this finding" job, not one per output channel.
- **Storing cyclopsCheckRunId only in memory**: Worker processes restart; must persist cyclopsCheckRunId to the Finding row in DB.
- **Running ESLint as a subprocess on files cloned to local disk**: Worker on Railway has no repo access. Use Git Data API + AI-provided `suggestedFix` content.
- **Creating check run annotations in a single call when >50 violations**: GitHub silently truncates. Must paginate with multiple PATCH calls, 50 annotations each.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML parsing | Custom regex parser | `js-yaml` v4 `yaml.load()` | YML edge cases (multi-doc, special chars, Norway boolean) |
| Config validation with defaults | Manual field checks | Zod `.catch()` + `.default()` on each field | Type-safe, exhaustive, composable |
| Action deduplication | Custom Redis TTL logic | DB `ActionDedup` table with `expiresAt` | Survives Redis flush; queryable for debugging |
| Finding a PR number from SHA | Custom scraping | `GET /repos/{owner}/{repo}/commits/{sha}/pulls` | Official API, returns PR number directly |
| Bot comment detection on PR | List + filter comments by login | DB-tracked `PrComment` table | Authoritative; works even if comment was minimized |
| Git operations for autofix | subprocess `git clone` + `git commit` | GitHub Git Data API (blobs, trees, commits, refs) | Railway worker has no persistent filesystem |
| Slack delivery | `@slack/webhook` npm package | `fetch(SLACK_WEBHOOK_URL, { method: 'POST', body: JSON.stringify({text}) })` | No new dep; Node 22 fetch is built in |

**Key insight:** The Git Data API (blobs + trees + commits + refs) is the only way to make commits from a stateless worker that has no local clone. Every autofix PR must go through this 5-step API chain.

---

## DB Schema Additions

Phase 3 requires 4 new Prisma models and 1 new field on `Finding`. All require a single migration.

### New field on Finding

```prisma
// Add to Finding model
cyclopsCheckRunId  BigInt?   // GitHub check run ID created by cyclops for this finding
```

### New Models

```prisma
model PrComment {
  id               String   @id @default(uuid())
  installationId   Int
  repositoryId     Int
  prNumber         Int
  githubCommentId  BigInt   // GitHub's comment.id (int64)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([installationId, repositoryId, prNumber])
  @@index([installationId])
  @@map("pr_comments")
}

model ActionDedup {
  id             String   @id @default(uuid())
  installationId Int
  repositoryId   Int
  detectorType   String
  ref            String   // branch name
  actionType     String   // e.g. 'create-autofix-pr-lint'
  expiresAt      DateTime // now() + 24h
  createdAt      DateTime @default(now())

  @@unique([installationId, repositoryId, detectorType, ref, actionType])
  @@index([expiresAt])   // for TTL cleanup job
  @@map("action_dedups")
}

model AutofixPr {
  id             String   @id @default(uuid())
  installationId Int
  repositoryId   Int
  detectorType   String   // 'Lint' | 'Snapshot'
  sha            String   // source commit SHA (40 chars)
  branchName     String
  prNumber       Int
  createdAt      DateTime @default(now())

  @@unique([installationId, repositoryId, detectorType, sha])
  @@index([installationId])
  @@map("autofix_prs")
}

model TrackedIssue {
  id               String   @id @default(uuid())
  installationId   Int
  repositoryId     Int
  detectorType     String
  ref              String   // branch
  githubIssueNumber Int
  createdAt        DateTime @default(now())

  @@unique([installationId, repositoryId, detectorType, ref])
  @@index([installationId])
  @@map("tracked_issues")
}
```

---

## Common Pitfalls

### Pitfall 1: Annotation Limit (50 per update_check_run call)

**What goes wrong:** Sending more than 50 annotations in a single `PATCH /check-runs/{id}` call silently drops all annotations beyond 50 (GitHub returns 200, not an error).

**Why it happens:** GitHub API hard limit: "Maximum 50 annotations per update_check_run call."

**How to avoid:** Chunk `finding.violations` into groups of 50 and make sequential PATCH calls. Only the first call sets `status: 'completed'` and `conclusion`; subsequent calls use `status: 'completed'` with no `conclusion` change (or use a separate finalize call).

**Warning signs:** PR checks tab shows fewer annotations than expected with no error in logs.

```typescript
// Chunk annotations and send sequentially
const ANNOTATION_BATCH = 50;
for (let i = 0; i < annotations.length; i += ANNOTATION_BATCH) {
  await (octokit as any).request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
    owner, repo, check_run_id: cyclopsCheckRunId,
    output: {
      title: 'Cyclops Analysis',
      summary: markdownSummary,
      annotations: annotations.slice(i, i + ANNOTATION_BATCH),
    },
    // Only set completed on last batch or first if single batch
    ...(i + ANNOTATION_BATCH >= annotations.length
      ? { status: 'completed', conclusion, completed_at: new Date().toISOString() }
      : {}),
  });
}
```

### Pitfall 2: Bot Identity — App Slug vs. App Name

**What goes wrong:** When filtering PR comments by bot login (fallback strategy), the format is `{app-slug}[bot]` where `app-slug` is the GitHub App's slug (lowercase, hyphens), NOT the display name. Getting this wrong means comment filtering never finds the bot's existing comment.

**Why it happens:** GitHub App slug is set at app creation time and may differ from the app name (e.g., app name "Cyclops CI" → slug "cyclops-ci" → login "cyclops-ci[bot]").

**How to avoid:** Use the DB-tracked `PrComment` table (the recommended approach) and never rely on listing comments to find the bot's comment. If needed for migration, call `GET /app` to retrieve the app slug at startup.

**Warning signs:** Multiple PR comments appearing from the bot on the same PR.

### Pitfall 3: Autofix PR Branch Ref Collision

**What goes wrong:** `POST /repos/{owner}/{repo}/git/refs` returns 409 Conflict if the ref already exists.

**Why it happens:** Two workers race on the same finding, or a retry creates the same branch name.

**How to avoid:** Use `installationId + repositoryId + detectorType + sha` as the dedup key in `AutofixPr` table (check-before-create). Branch name: `cyclops/autofix/{detectorType.toLowerCase()}/{sha.slice(0,7)}-{epoch-ms}`. The epoch-ms suffix prevents cross-run collisions; the dedup table prevents same-run duplicates.

**Warning signs:** Action jobs failing with 409 on branch creation.

### Pitfall 4: PR Number is NOT the Same as Check Run ID

**What goes wrong:** Using `checkRunId` (which is the workflow run ID in the current schema) as the `issue_number` for PR comments.

**Why it happens:** `checkRunId` in the existing schema is overloaded as the GitHub workflow run ID used as a correlation identifier — it is NOT the PR number.

**How to avoid:** Always look up the PR number from the commit SHA at execution time:
```typescript
const prsResp = await (octokit as any).request(
  'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
  { owner, repo, commit_sha: sha, per_page: 10 }
);
const prNumber = prsResp.data[0]?.number;
if (!prNumber) return; // commit not associated with an open PR — skip comment
```

**Warning signs:** 404 errors when posting PR comments; or comments posted to wrong issue.

### Pitfall 5: Cancel Returns 409 for Already-Completed Runs

**What goes wrong:** `POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel` returns 409 Conflict if the run has already completed (by the time the hanging-workflow action executes).

**Why it happens:** Timing — the workflow may have completed between detection and action execution.

**How to avoid:** Wrap cancel call in try/catch, treat 409 as success (already done), log at info level.

### Pitfall 6: Config Kill Switch Must Be Read Before EVERY Action

**What goes wrong:** Kill switches in `.cyclops.yml` are read once at worker startup, not per-job. A user updates `autofix: false` but the worker still creates autofix PRs because it cached the old config.

**Why it happens:** Module-level config cache never invalidated.

**How to avoid:** Cache config with a short TTL (60 seconds max) keyed by `(repositoryId, ref)`. The job has `sha`, so fetch config at `ref` from the repo. TTL-based invalidation ensures kill switch takes effect within 60s of a push.

### Pitfall 7: Check Run Name Must Be Consistent

**What goes wrong:** Using a dynamic check run name (e.g., including the detector type) means GitHub treats each name as a different check, resulting in multiple separate check entries in the PR Checks tab instead of one updated entry.

**Why it happens:** GitHub uses `(check_run.name, head_sha)` as the identity for "which check to show."

**How to avoid:** Use a fixed name: `'Cyclops CI Analysis'`. The details go in `output.summary`, not the name.

---

## Code Examples

### Octokit Request Pattern (all API calls use this form)

```typescript
// Source: existing apps/worker/src/lib/github-actions.ts pattern
// All GitHub API calls use the generic request method (no @octokit/plugin-rest-endpoint-methods)
const resp = await (octokit as any).request(
  'POST /repos/{owner}/{repo}/check-runs',
  { owner, repo, name: 'Cyclops CI Analysis', head_sha: sha, status: 'in_progress',
    started_at: new Date().toISOString() }
);
const cyclopsCheckRunId: number = resp.data.id;
```

### PR Number Lookup from SHA

```typescript
// Source: GitHub REST API docs - GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls
const prsResp = await (octokit as any).request(
  'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
  { owner, repo, commit_sha: sha, per_page: 5 }
);
const prNumber: number | undefined = prsResp.data[0]?.number;
```

### Config Schema (packages/config/src/schema.ts)

```typescript
// Source: zod docs — .default() + .catch() for graceful fallback
import { z } from 'zod';

export const CyclopsConfigSchema = z.object({
  detectors: z.object({
    lint:       z.boolean().default(true),
    flakyTest:  z.boolean().default(true),
    build:      z.boolean().default(true),
    testFailure: z.boolean().default(true),
    missingEnv: z.boolean().default(true),
    expiredSecret: z.boolean().default(true),
  }).default({}),
  confidenceThreshold: z.number().min(0).max(1).default(0.85),
  autofix: z.boolean().default(true),
  autofixRateLimit: z.number().int().min(1).max(20).default(3), // per hour
  notifications: z.object({
    slack: z.object({
      enabled:    z.boolean().default(true),
      channel:    z.string().optional(),
      webhookUrl: z.string().url().optional(),
    }).default({}),
  }).default({}),
  githubIssues: z.boolean().default(true),
  checkRuns:    z.boolean().default(true),
  prComments:   z.boolean().default(true),
}).default({});

export type CyclopsConfig = z.infer<typeof CyclopsConfigSchema>;
```

### ActionDedup Check (DB-backed 24-hour window)

```typescript
// Pattern: check-before-create with DB
async function isDeduped(
  db: any,
  installationId: number,
  repositoryId: number,
  detectorType: string,
  ref: string,
  actionType: string
): Promise<boolean> {
  const existing = await db.actionDedup.findFirst({
    where: {
      installationId, repositoryId, detectorType, ref, actionType,
      expiresAt: { gt: new Date() },
    },
  });
  return !!existing;
}

async function recordDedup(db: any, ...same params...): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.actionDedup.upsert({
    where: { installationId_repositoryId_detectorType_ref_actionType: {
      installationId, repositoryId, detectorType, ref, actionType
    }},
    create: { installationId, repositoryId, detectorType, ref, actionType, expiresAt },
    update: { expiresAt },
  });
}
```

### Slack Alert (no SDK)

```typescript
// Source: Slack incoming webhook docs — simple POST with built-in fetch (Node 22)
const webhookUrl = process.env['SLACK_WEBHOOK_URL'] ?? config.notifications?.slack?.webhookUrl;
if (!webhookUrl) { log.warn('No Slack webhook URL configured'); return; }

await fetch(webhookUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: `*Expired Secret detected* in <${repoUrl}|${owner}/${repo}> on \`${ref}\``,
    blocks: [ /* ... */ ],
  }),
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@octokit/rest` typed methods | `(octokit as any).request(string, params)` | This project's convention from Phase 1 | Must follow existing pattern; typed methods not available |
| `YAML.safeLoad()` | `yaml.load()` (js-yaml v4) | js-yaml v4 removed safeLoad | `yaml.load()` is safe by default in v4 |
| Prisma v4 separate `@prisma/client` | Prisma 6 `prisma-client` generator | Prisma 6 release | Already handled in existing schema; no change needed |

**Deprecated/outdated:**
- `yaml.safeLoad()`: Removed in js-yaml v4. Use `yaml.load()`.
- `@octokit/rest` typed endpoint methods: Not installed in this project. Use raw `request()`.

---

## Wave / Plan Decomposition

Recommended build order — each wave must be shippable and testable before the next:

### Wave 1: DB Schema + Type Updates (prerequisite for everything)
1. Add `cyclopsCheckRunId BigInt?` to `Finding` model
2. Add `PrComment`, `ActionDedup`, `AutofixPr`, `TrackedIssue` models to Prisma schema
3. Generate migration + update `packages/db` exports
4. Update `ActionExecutionJobSchema` in `packages/queue/src/jobs.ts`: replace `actionType: z.string()` with `z.enum([...])` and add optional `ref` field OR keep `z.string()` and validate in worker

### Wave 2: Config System
1. Create `packages/config` with `schema.ts` (Zod, no I/O) and `loader.ts` (fetches `.cyclops.yml`)
2. Add `js-yaml` to `apps/worker` package
3. Implement TTL cache (60s) in loader
4. Write unit tests for schema defaults and override behavior
5. Freeze schema and document it (CFG-03)

### Wave 3: Action Execution Worker Skeleton + Kill Switches
1. Create `apps/worker/src/workers/action-execution.ts` with handler map pattern
2. Load config, resolve owner/repo, load finding from DB
3. Implement kill switch checks (config.autofix, config.prComments, config.checkRuns, per-detector disable)
4. Replace `actionType: 'phase3-placeholder'` dispatch in `ai-analysis.ts` with real action type(s)
5. Wire worker in `apps/worker/src/index.ts`

### Wave 4: Core Output Channels (PR comment + Check Run)
1. Implement `handleUpdateCheckRun` using the 2-phase create→update pattern; batch annotations 50/call
2. Implement `handleUpsertPrComment` with DB-tracked comment ID
3. PR number lookup helper (`GET /commits/{sha}/pulls`)
4. Integrate: dispatch `update-check-run` and `upsert-pr-comment` from action-execution worker
5. Test: single finding → one comment created; second finding on same PR → comment edited

### Wave 5: Autofix PRs
1. Implement `handleAutofixLint`: Git Data API chain (fetch files → create tree with inline content → commit → branch ref → PR)
2. Implement `handleAutofixSnapshot`: same chain, using `finding.suggestedFix` for new snapshot content; skip if suggestedFix is empty
3. `AutofixPr` dedup check before creation
4. ACT-12 rate limit: count `AutofixPr` rows in last hour per repo; skip if >= limit

### Wave 6: Secondary Actions
1. `handleRerunWorkflow`: `POST /actions/runs/{workflowRunId}/rerun`; dedup via ActionDedup
2. `handleCancelWorkflow`: `POST /actions/runs/{workflowRunId}/cancel`; handle 409 gracefully
3. `handleSlackAlert`: fetch POST to webhook URL; only for ExpiredSecret detector
4. `handleCreateGithubIssue`: POST issue + store in TrackedIssue; dedup check before creation

### Wave 7: Polish & Integration
1. ActionDedup applied to ALL secondary actions (rerun, cancel, Slack, Issue)
2. Cleanup job for expired `ActionDedup` rows (or rely on DB index + periodic delete)
3. Zero-config smoke test (no `.cyclops.yml` present → all defaults → all actions execute)
4. End-to-end test: failing workflow → PR comment + check run created; second run → comment edited, not duplicated

---

## Open Questions

1. **Autofix Lint — Source of Fix Content**
   - What we know: `finding.suggestedFix` (string) is populated by AI analysis. `finding.affectedFiles` (string[]) contains file paths.
   - What's unclear: `suggestedFix` may be prose ("remove the unused import on line 5") not a diff or replacement content. If so, the Git Data API approach requires re-parsing it or running ESLint in a sandbox.
   - Recommendation: In the action-execution worker, treat `suggestedFix` as the new file content ONLY if it passes a basic sanity check (contains original file structure); otherwise skip autofix and log a warning. Revisit with a Claude API call to generate a proper patch if needed (out of Phase 3 scope per requirements).

2. **Snapshot Autofix Feasibility Without Running Tests**
   - What we know: ACT-06 calls for "snapshot regeneration." Snapshots are outputs of test runs; you can't regenerate them without running tests.
   - What's unclear: Does `suggestedFix` contain the expected snapshot content from AI analysis, or is it empty for snapshot failures?
   - Recommendation: Implement `handleAutofixSnapshot` as a conditional: if `finding.suggestedFix` contains non-empty content that looks like a snapshot (starts with `exports[`) → apply as new file content; otherwise skip with a `skipped: true, reason: 'no_suggested_content'` return.

3. **GitHub App Slug at Runtime**
   - What we know: The PR comment upsert is DB-tracked, so bot login is not needed for the happy path.
   - What's unclear: If a comment needs to be found on PRs that pre-date the DB (e.g., after a DB reset), the fallback must know the app slug.
   - Recommendation: Log the app slug at worker startup via `GET /app` and store in memory. Not blocking for Phase 3 since all new comments will be DB-tracked.

4. **`ref` Field Missing from ActionExecutionJob**
   - What we know: `ActionExecutionJobSchema` lacks `ref`. The `ref` is available in `Finding.ref` (loaded from DB at execution time).
   - What's unclear: Whether `finding.ref` is always populated correctly for check_run (fallback) events (the webhook-ingestion code sets `ref: payload.check_run.check_suite?.head_branch ?? ''` which can be empty string).
   - Recommendation: In Wave 1, add `ref: z.string().optional()` to `ActionExecutionJobSchema` and populate it in `ai-analysis.ts` from the finding's ref. Alternatively, fall back to fetching it from Finding.ref at action time and handle empty string gracefully.

---

## Sources

### Primary (HIGH confidence)
- GitHub REST API docs — PR Comments: `https://docs.github.com/en/rest/issues/comments`
- GitHub REST API docs — Check Runs: `https://docs.github.com/en/rest/checks/runs`
- GitHub REST API docs — Pull Requests: `https://docs.github.com/en/rest/pulls/pulls`
- GitHub REST API docs — Git Commits/Trees/Refs: `https://docs.github.com/en/rest/git/commits`, `/trees`, `/refs`
- GitHub REST API docs — Workflow Run Rerun/Cancel: `https://docs.github.com/en/rest/actions/workflow-runs`
- GitHub REST API docs — Issues: `https://docs.github.com/en/rest/issues/issues`
- GitHub REST API docs — File Contents: `https://docs.github.com/en/rest/repos/contents`
- GitHub REST API docs — Commits/Pulls association: `https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit`
- Existing codebase: `apps/worker/src/lib/github-actions.ts`, `packages/queue/src/jobs.ts`, `packages/db/prisma/schema.prisma`

### Secondary (MEDIUM confidence)
- js-yaml v4 API confirmed via `packages/detectors/package.json` direct dep + installed version in pnpm store
- BullMQ handler map pattern — confirmed from BullMQ docs + existing project worker patterns
- Slack incoming webhook — `https://api.slack.com/incoming-webhooks`

### Tertiary (LOW confidence)
- Autofix PR branch naming convention: community practice (`cyclops/autofix/{type}/{sha7}-{ts}`); no single official source
- Bot login format `{app-slug}[bot]`: described in GitHub community discussions; verified against project pattern

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified in node_modules; API endpoints confirmed against official docs
- Architecture patterns: HIGH — derived from existing codebase conventions + official GitHub REST API docs
- DB schema additions: HIGH — derived directly from requirements; table structure follows existing Prisma patterns
- Autofix lint/snapshot content: LOW — `suggestedFix` content format not tested; feasibility depends on AI output quality
- Pitfalls: HIGH for annotation limit (official doc), PR number confusion (verified in codebase), 409 on cancel (official doc); MEDIUM for others

**Research date:** 2026-07-13
**Valid until:** 2026-08-13 (GitHub API is stable; BullMQ 5.x is stable; review if upgrading Octokit major version)
