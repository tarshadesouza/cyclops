# Technology Stack

**Project:** CyclOps (ciintel)
**Researched:** 2026-07-13
**Confidence:** HIGH — all versions confirmed via npm registry; key architectural decisions verified against official documentation

---

## Verified Package Versions

| Package | Version | Source |
|---------|---------|--------|
| typescript | 7.0.2 | npm registry |
| fastify | 5.10.0 | npm registry |
| bullmq | 5.79.3 | npm registry |
| ioredis | 5.11.1 | npm registry |
| prisma / @prisma/client | 7.8.0 | npm registry |
| @octokit/app | 16.1.2 | npm registry |
| @octokit/auth-app | 8.2.0 | npm registry |
| @octokit/webhooks | 14.2.0 | npm registry |
| ai (Vercel AI SDK) | 7.0.18 | npm registry |
| zod | 4.4.3 | npm registry |
| tsup | 8.5.1 | npm registry |
| turbo | 2.10.4 | npm registry |
| pnpm | 11.10.0 | npm registry |

---

## Recommended Stack

### Runtime Platform

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js | 22 LTS | Runtime | Active LTS with native ESM, built-in fetch, stable Worker Threads |
| TypeScript | 7.0.2 | Language | GA as of 2026-07-08; Go-native compiler gives 10-12x faster builds. **Critical caveat: no stable programmatic API until 7.1 — do not depend on `ts.CompilerAPI` in build tools.** |
| pnpm | 11.10.0 | Package manager | First-class workspace support, strict isolated node_modules, fastest installs |

**TypeScript 7 configuration note:** `target: es5`, `moduleResolution: node`, and `baseUrl` are hard errors in TS7. Use `moduleResolution: bundler` for apps built with tsup/esbuild, and `moduleResolution: node16` for Node.js packages that use `package.json` exports. Removing these from legacy configs is mandatory before using TS7.

---

### HTTP Layer

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| fastify | 5.10.0 | HTTP server | 3x Express throughput; schema-based validation built-in; TypeScript-native since v4; correct plugin encapsulation model prevents leaking webhook routes to public |
| @fastify/formbody | latest | Form body parsing | Required for OAuth callback routes |
| fastify-raw-body | latest | Raw body capture | **Required for GitHub webhook HMAC verification** — must capture bytes before Fastify's JSON parser runs |

**Why Fastify over Hono or Express:** Fastify 5 ships with full TypeScript generics on routes. Its plugin encapsulation model is critical — webhook ingestion routes (no auth, raw body required) and internal API routes (JWT auth, JSON parsing) are registered in separate plugin contexts with different hooks, avoiding configuration bleed.

---

### GitHub App Authentication

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @octokit/app | 16.1.2 | GitHub App lifecycle | Manages webhook routing, per-installation Octokit instances, and App JWT auth |
| @octokit/auth-app | 8.2.0 | Installation token auth | Automatic token caching (up to 15,000 tokens via toad-cache) and refresh — tokens expire at 1h; this library handles it transparently |
| @octokit/webhooks | 14.2.0 | Webhook verification | HMAC-SHA256 signature verification via `verify()` before any payload processing |

**Do not use Probot.** Probot is a convenience wrapper around @octokit/app that forces an Express-style HTTP model and opinionated bootstrapping. For CyclOps: (a) we use Fastify, not Express; (b) we need BullMQ enqueue as the webhook handler, not in-process event handling; (c) we need multi-tenant control over which installations to service. Raw @octokit/app gives full control and is what Probot itself uses internally.

#### GitHub App Auth Flow

There are two distinct auth contexts. Conflating them causes subtle bugs:

**App-level auth (JWT):** Used for listing installations, getting app metadata. The `App` class from `@octokit/app` handles this automatically. Never use installation tokens for app-level calls.

**Installation-level auth (installation token):** Used for all repository operations — creating PRs, posting comments, creating check runs. Call `app.getInstallationOctokit(installationId)` to get a pre-authenticated Octokit instance. `@octokit/auth-app` caches and refreshes tokens transparently; you never call the token endpoint manually.

```typescript
// Correct pattern for installation-level operations
const octokit = await app.getInstallationOctokit(installationId);
await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
// Token was either fetched fresh or served from cache — transparent
```

#### Webhook Signature Verification in Fastify

GitHub sends `X-Hub-Signature-256: sha256=<hmac>`. You must compute HMAC over the **raw request bytes**, not the parsed JSON body.

```typescript
// Register raw body plugin before JSON parser on webhook routes
fastify.register(fastifyRawBody, { field: 'rawBody', global: false, routes: ['/webhooks/github'] });

// In webhook route handler
fastify.post('/webhooks/github', { config: { rawBody: true } }, async (request, reply) => {
  const sig = request.headers['x-hub-signature-256'] as string;
  const valid = await webhooks.verify(request.rawBody as string, sig);
  if (!valid) return reply.status(401).send();

  // Safe to enqueue now
  await webhookQueue.add('github-event', { payload: request.body, installationId });
});
```

---

### Job Queue

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| bullmq | 5.79.3 | Job queue | TypeScript-first; Flow producers for DAG job dependencies; OpenTelemetry built-in; reliable state machine with atomic operations |
| ioredis | 5.11.1 | Redis client | BullMQ's required client; must set `maxRetriesPerRequest: null` or BullMQ throws on blocked commands |
| @bull-board/fastify | latest | Queue dashboard | Dev/internal visibility into queues; Fastify plugin available |

**Required Redis configuration (non-negotiable):**
- `maxmemory-policy noeviction` — Redis eviction silently deletes job data
- `appendonly yes` — AOF persistence; Redis restart without this loses all pending jobs
- `maxRetriesPerRequest: null` in ioredis connection options

#### Queue Architecture for CyclOps

Four queues, one worker pool. Queues are separated by blast radius — a saturated notification queue should never block failure analysis.

| Queue Name | Job Type | Concurrency | Retry Policy | Notes |
|------------|----------|-------------|--------------|-------|
| `webhook-ingress` | Ingest + validate GitHub event, enqueue to analysis | 50 | 3x, no backoff | Fast, no I/O beyond Redis write |
| `failure-analysis` | Fetch logs, run detectors, call LLM | 5 | 3x, exponential 30s | Expensive; concurrency capped to manage LLM rate limits |
| `remediation` | Create PR / rerun workflow / cancel job | 10 | 5x, exponential 60s | GitHub API calls; retry handles rate limits |
| `notification` | Slack / Jira / GitHub comment post | 20 | 5x, exponential 30s | External APIs; idempotency via `jobId` |

**Use Flow producers for the analysis → remediation dependency:** When failure analysis completes and determines a remediation is needed, use `FlowProducer` to atomically enqueue the remediation job as a child that only runs after the parent analysis job resolves. This prevents orphaned remediations if analysis fails mid-way.

**Job payload typing pattern:**
```typescript
// packages/queue/src/types.ts — shared across apps/api and apps/worker
export interface FailureAnalysisJob {
  installationId: number;
  owner: string;
  repo: string;
  workflowRunId: number;
  headSha: string;
  attemptNumber: number;
}
// Worker imports this type; queue producer imports this type — single source of truth
```

---

### Database

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| prisma | 7.8.0 | ORM | TypeScript-native query builder; Prisma 7 dropped the Rust engine for a TypeScript runtime — 3x faster, 90% smaller bundle |
| @prisma/client | 7.8.0 | Generated client | Type-safe queries; Prisma 7 adds native PGVector and FTS support |
| PostgreSQL | 16 | Database | Battle-tested; RLS for tenant isolation; jsonb for storing detector outputs |

**Prisma 7 breaking change:** Database connection config moved from `schema.prisma` to `prisma.config.ts`. Create this file at project root:

```typescript
// prisma.config.ts
import { defineConfig } from 'prisma/config';
export default defineConfig({
  datasource: { url: process.env.DATABASE_URL! }
});
```

#### Multi-Tenant Isolation Pattern

CyclOps is multi-tenant by `installation_id` (GitHub's unique identifier per App installation per org/account). Every table that contains customer data carries `installation_id` as a non-nullable foreign key.

**Two-layer defense:**

**Layer 1 — Application layer (Prisma extension):** A custom Prisma extension injects `where: { installationId }` into every query operation automatically. This means developers cannot forget the tenant filter — it's structurally impossible to omit.

```typescript
// packages/db/src/client.ts
export function createTenantClient(installationId: number) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          // Inject tenant scope on all read/write operations
          args.where = { ...args.where, installationId };
          return query(args);
        }
      }
    }
  });
}
```

**Layer 2 — Database layer (PostgreSQL RLS):** Row-Level Security policies at the PostgreSQL level enforce the same isolation as a fallback. If application code bypasses the extension (e.g., raw SQL migrations, ad-hoc queries), RLS catches it. Set `app.current_tenant` via a SET LOCAL command at session start in a Prisma middleware.

**Do not use schema-per-tenant.** Schema proliferation hits PostgreSQL connection overhead at scale and complicates migrations. `installation_id` column scoping with RLS is the correct pattern for a SaaS with thousands of tenants.

---

### AI Abstraction Layer

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| ai (Vercel AI SDK) | 7.0.18 | LLM provider abstraction | 20+ providers (Anthropic, OpenAI, Google, Groq, Bedrock, Mistral, DeepSeek) behind a single TypeScript API; enterprises swap providers without code changes |
| @ai-sdk/anthropic | latest | Anthropic provider | Claude Sonnet/Opus for high-accuracy failure analysis |
| @ai-sdk/openai | latest | OpenAI provider | GPT-4o for cost-sensitive operations |
| zod | 4.4.3 | Schema validation for tool calls | AI SDK uses Zod schemas to validate LLM tool call outputs at runtime |

**Zod 4 breaking change:** String format methods moved to top-level functions. Use `z.email()` not `z.string().email()`. The old form is deprecated (not removed) so builds won't break, but use the new form in all new code. Import from `zod/v4` subpath explicitly to opt into Zod 4 semantics without ambiguity.

#### Tool-Calling Pattern for Detectors

Each detector (Lint, Snapshot, FlakeyTest, etc.) is modeled as a set of AI SDK tools the LLM can call during failure analysis. The analysis loop runs until the model either calls a `reportConclusion` tool or reaches max steps.

```typescript
import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod/v4';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  tools: {
    fetchWorkflowLogs: tool({
      description: 'Fetch raw logs for a specific job in the workflow run',
      parameters: z.object({ jobId: z.number(), lineRange: z.tuple([z.number(), z.number()]).optional() }),
      execute: async ({ jobId, lineRange }) => fetchLogs(installationOctokit, owner, repo, jobId, lineRange),
    }),
    reportConclusion: tool({
      description: 'Report the failure classification and recommended remediation',
      parameters: z.object({
        category: z.enum(['lint', 'snapshot', 'flakey-test', 'expired-secret', 'hanging-workflow', 'unknown']),
        confidence: z.number().min(0).max(1),
        rootCause: z.string(),
        remediationAction: z.enum(['create-fix-pr', 'rerun-workflow', 'cancel-and-notify', 'post-comment-only']),
      }),
      execute: async (conclusion) => conclusion, // Terminal tool — just return the value
    }),
  },
  stopWhen: (result) => result.toolResults.some(r => r.toolName === 'reportConclusion'),
  maxSteps: 8,
  system: DETECTOR_SYSTEM_PROMPT,
  prompt: buildAnalysisPrompt(workflowRun),
});
```

**Provider key management:** Store provider API keys per-installation in the database (encrypted). During analysis, load the installation's configured provider key. If not configured, fall back to the platform default. This is the "bring your own API key" model for enterprise self-hosters.

---

### SDK Packaging (@cyclops/core)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| tsup | 8.5.1 | Bundler for SDK | esbuild-powered; outputs ESM + CJS + `.d.ts` in one command; minimal config |
| publint | latest | Package correctness | Validates `package.json` exports are correct before publish |
| @arethetypeswrong/cli | latest | Type compatibility | Validates CJS/ESM type resolution is correct for all consumers |

#### Dual Output Configuration

The ESM/CJS dual package problem is still real in 2025-2026. Use `.mjs`/`.cjs` file extensions (not just folder-level `type: module`) to force correct module interpretation regardless of consumer's `package.json` settings.

```typescript
// packages/core/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,              // Generate .d.ts alongside both formats
  sourcemap: true,
  clean: true,
  splitting: false,       // Keep single-file output for SDK — easier debugging for consumers
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
});
```

```json
// packages/core/package.json exports field
{
  "name": "@cyclops/core",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts"
}
```

**What NOT to do:** Do not set `"type": "module"` at the package root of a dual-output library. This confuses consumers who `require()` the CJS build. Use explicit `.mjs`/`.cjs` extensions instead — extension wins over `type` field.

**Publish checklist before each `npm publish`:**
1. `pnpm --filter @cyclops/core build`
2. `npx publint packages/core` — validates export map correctness
3. `npx attw --pack packages/core` — checks types are reachable for both ESM and CJS consumers
4. `npm pack --dry-run` to confirm dist files are included and src is not

---

## Monorepo Structure

```
cyclops/
├── apps/
│   ├── api/              # Fastify webhook receiver + internal REST
│   │   ├── src/
│   │   │   ├── plugins/  # Fastify plugin registrations (auth, webhooks, etc.)
│   │   │   ├── routes/   # Route handlers (webhook ingestion, health)
│   │   │   └── server.ts # Fastify instance bootstrap
│   │   ├── Dockerfile
│   │   └── railway.toml
│   └── worker/           # BullMQ worker process (separate deploy unit)
│       ├── src/
│       │   ├── processors/  # One file per queue (failure-analysis.ts, etc.)
│       │   └── worker.ts    # Worker bootstrap
│       ├── Dockerfile
│       └── railway.toml
├── packages/
│   ├── core/             # @cyclops/core — PUBLIC npm SDK for self-hosters
│   │   ├── src/
│   │   │   ├── detectors/  # Detector plugin interface + built-in detectors
│   │   │   ├── engine/     # Analysis orchestration logic
│   │   │   └── index.ts    # Public API surface
│   │   └── tsup.config.ts
│   ├── db/               # @cyclops/db — Prisma schema + generated client
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   ├── prisma.config.ts
│   │   └── src/
│   │       ├── client.ts       # createTenantClient factory
│   │       └── migrations/
│   ├── github/           # @cyclops/github — Octokit/app wrappers (internal)
│   │   └── src/
│   │       ├── app.ts          # App singleton initialization
│   │       ├── actions.ts      # createPR, postComment, createCheckRun
│   │       └── webhooks.ts     # Webhook signature verification helper
│   ├── queue/            # @cyclops/queue — BullMQ queue defs + job types (internal)
│   │   └── src/
│   │       ├── queues.ts       # Queue instances (singleton)
│   │       └── types.ts        # Typed job payload interfaces
│   └── config/           # Shared ESLint + TypeScript configs
│       ├── eslint-base.js
│       └── tsconfig.base.json
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

**apps/ contains deployable services.** Each app has its own Dockerfile and `railway.toml`. Apps import from `packages/` via workspace protocol (`workspace:*`).

**packages/ contains libraries.** `core` is the only public package (published to npm). All others are internal workspace packages consumed by apps.

**Why separate `api` and `worker`:** Railway deploys them as independent services with independent scaling. The API pod needs near-zero latency for webhook acknowledgment (GitHub expects 200 within 10s). The worker pod needs CPU/memory for LLM calls and log fetching. Coupling them in one process means a slow analysis job blocks webhook receipt.

---

## Turborepo Configuration

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "persistent": true,
      "cache": false
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "lint": {}
  }
}
```

`^build` means "build all workspace dependencies before building this package." This ensures `packages/db` is built (Prisma client generated) before `apps/api` compiles.

---

## Railway Deployment Config

Railway auto-detects pnpm workspaces and creates one service per detectable app. Override per-service with `railway.toml`:

```toml
# apps/api/railway.toml
[build]
builder = "dockerfile"
dockerfilePath = "apps/api/Dockerfile"

[deploy]
startCommand = "node dist/server.js"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3

[[deploy.environmentVariables]]
# Set DATABASE_URL, REDIS_URL, GITHUB_APP_ID, etc. in Railway dashboard
```

```dockerfile
# apps/api/Dockerfile — multi-stage, pnpm-aware
FROM node:22-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/github/package.json ./packages/github/
COPY packages/queue/package.json ./packages/queue/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .
RUN pnpm turbo build --filter=@cyclops/api...

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/server.js"]
```

**Critical Railway/pnpm gotcha:** Copy `pnpm-workspace.yaml` into the runtime stage (or the deps stage that creates `node_modules`). Railway's build pipeline runs in a container that may not have the workspace context file, causing `pnpm install` to fail with "workspace not found."

**Railway selective deploys (Jan 2026):** Railway now only redeploys services touched by a PR. In a three-service monorepo (api, worker, core-publish), most PRs will only redeploy one or two services. Configure `watchPaths` in the Railway dashboard per service to enable this.

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| HTTP framework | Fastify 5 | Express, Hono | Express lacks plugin encapsulation; Hono is edge-optimized but ecosystem depth for long-running server processes is thinner |
| GitHub App framework | @octokit/app raw | Probot | Probot forces Express-style handlers, blocking Fastify integration; adds abstraction that reduces control over webhook → queue handoff |
| Job queue | BullMQ 5 | pg-boss, SQS | pg-boss requires Postgres for queue (doubles DB load); SQS adds AWS coupling before we need it |
| ORM | Prisma 7 | Drizzle, Kysely | Drizzle lacks multi-tenant extension patterns at the ORM level; Kysely is query-builder not ORM; Prisma 7's TypeScript runtime removes the Rust engine penalty |
| Build tool (SDK) | tsup | tsc only, Rollup | tsc-only produces no tree-shaking or bundled output; Rollup is more configurable but more config to maintain; tsup does the right thing by default |
| Validation | Zod 4 | Valibot, ArkType | Vercel AI SDK 7 uses Zod 4 natively; using a different library means bridging types for tool schemas |
| LLM abstraction | Vercel AI SDK 7 | LangChain | LangChain's Node.js bundle size is heavy (~12MB) and abstractions often lag provider capabilities; Vercel AI SDK is leaner with better TypeScript ergonomics |
| Deployment (MVP) | Railway | Render, Fly.io | Railway has first-class pnpm monorepo support and per-service selective deploys; Render monorepo support is limited; Fly.io requires more Dockerfile tuning |

---

## Installation Bootstrap

```bash
# Initialize monorepo
pnpm init
pnpm add -D turbo typescript@7 @types/node

# Core dependencies per workspace
# apps/api
pnpm --filter @cyclops/api add fastify fastify-raw-body @fastify/formbody
pnpm --filter @cyclops/api add @octokit/app @octokit/auth-app @octokit/webhooks
pnpm --filter @cyclops/api add bullmq ioredis

# apps/worker
pnpm --filter @cyclops/worker add bullmq ioredis ai @ai-sdk/anthropic @ai-sdk/openai
pnpm --filter @cyclops/worker add zod

# packages/db
pnpm --filter @cyclops/db add prisma @prisma/client
pnpm --filter @cyclops/db add -D prisma

# packages/core (public SDK)
pnpm --filter @cyclops/core add -D tsup publint @arethetypeswrong/cli

# Dev tooling at root
pnpm add -D eslint prettier vitest
```

---

## Sources

- TypeScript 7.0 GA announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- @octokit/app GitHub repository: https://github.com/octokit/app.js/
- BullMQ documentation: https://docs.bullmq.io/
- Prisma 7 announcement: https://www.prisma.io/blog/announcing-prisma-orm-7-0-0
- Vercel AI SDK 7: https://vercel.com/blog/ai-sdk-6 (v6 announced; v7.0.18 current per npm)
- Zod v4 migration guide: https://zod.dev/v4/changelog
- tsup dual output: https://johnnyreilly.com/dual-publishing-esm-cjs-modules-with-tsup-and-are-the-types-wrong
- Railway monorepo docs: https://docs.railway.com/deployments/monorepo
- GitHub webhook validation: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Prisma multi-tenant RLS: https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security
