# CyclOps

When a CI job fails, CyclOps tells you exactly why and — with one tick in the PR — fixes it with a coding agent that iterates until CI is green, eliminating the manual log-reading cycle that wastes engineering time.

## Autofix

When a failure is fixable, CyclOps drops a checkbox into its PR comment — **"Let Cyclops fix this"**. Tick it and a coding agent fixes the code in an isolated sandbox, verifying against your **real** CI (not a local guess). Editing the bot's comment requires write access, so the trigger is permission-gated.

You choose how much autonomy to grant, per repo, in `.cyclops.yml`:

| Mode | What happens | Where the fix lands |
|------|--------------|---------------------|
| `suggest` *(default)* | Agent runs **once**, posts a diff; **Apply** commits it | the PR branch, one commit |
| `agent` + `safe` | Agent **loops until CI is green** | a new `cyclops/fix/*` branch + review PR |
| `agent` + `all-in` | Agent **loops until CI is green** | directly on the PR's own branch |
| `off` | Analysis only — no fix offered | — |

```yaml
# .cyclops.yml
autofix:
  mode: agent            # off · suggest · agent
  agent:
    permission: safe     # safe (new PR) · all-in (this branch)
    maxIterations: 3     # re-run against real CI until green
    model: claude-sonnet-5
  dryRun: false          # true → propose only, commit nothing
confidenceThreshold: 0.85
```

CyclOps runs on **your own Anthropic key** (BYOK), so the spend and your code stay yours. Every fix is explicit, posts a live status comment, and stops safely — on success, a dry run, the iteration cap, or an error. Full reference: [docs/configuration.md](./docs/configuration.md).

## Architecture

CyclOps is a TypeScript monorepo (Turborepo + pnpm) split into two Railway services:

- **`apps/api`** — Fastify webhook receiver: validates GitHub webhooks, deduplicates deliveries, enqueues jobs.
- **`apps/worker`** — BullMQ pipeline: detector dispatch → AI analysis (BYOK Claude) → action routing.

Shared packages under `packages/`: `core` (I/O-free logic), `db` (Prisma 7 + PostgreSQL), `detectors`, `ai` (Vercel AI SDK), `github`, `queue`.

## Installation

### Prerequisites

- Node.js 22+
- pnpm 9+
- PostgreSQL 15+
- Redis 7+ (must have `maxmemory-policy noeviction`)

### Setup

1. Clone the repository and install dependencies:

   ```bash
   git clone <repo-url>
   cd ciintel
   pnpm install
   ```

2. Copy the environment variable template:

   ```bash
   cp .env.example .env
   ```

3. Fill in the required values in `.env` — see [docs/environment.md](./docs/environment.md) for the full reference.

4. Run migrations:

   ```bash
   pnpm --filter @cyclops/db db:migrate
   ```

5. Build all packages:

   ```bash
   pnpm -r build
   ```

## Configure BYOK API Key

CyclOps uses a Bring-Your-Own-Key model for Anthropic API access. Register your Anthropic key per installation after the GitHub App is installed:

```bash
curl -X POST $API_URL/setup/$INSTALLATION_ID \
  -H "x-setup-token: $CYCLOPS_SETUP_SECRET" \
  -H "content-type: application/json" \
  -d '{"apiKey":"sk-ant-..."}'
```

- `API_URL` — your deployed `apps/api` URL (e.g. `https://cyclops-api.railway.app`)
- `INSTALLATION_ID` — the GitHub App installation ID (visible in GitHub App install URL or webhook payload)
- `CYCLOPS_SETUP_SECRET` — the secret you set in your `apps/api` environment

Expected response: `{"ok":true}`

The key is encrypted at rest using AES-256-GCM (`CYCLOPS_ENCRYPTION_KEY`) and decrypted only at the moment of each AI analysis call. It is never logged.

## Per-repo configuration (`.cyclops.yml`)

CyclOps runs zero-config with safe defaults. To customize per repository — detector kill switches, confidence threshold, output channels, and the autofix mode (see [Autofix](#autofix) above) — add a `.cyclops.yml`. See [docs/configuration.md](./docs/configuration.md) for the full reference.

> ⚠️ **`agent.permission: all-in` commits fixes directly to your PR branches.** The default `suggest` (and `agent` + `safe`) never touch your branch. Read the [disclaimer](./docs/configuration.md#disclaimer-all-in-writes-directly-to-your-branches) before enabling it.

## Development

```bash
# Start both services in watch mode
pnpm dev

# Run all tests
pnpm test

# Type-check only (no emit)
pnpm --filter <package> tsc --noEmit
```

## Environment Variables

See [docs/environment.md](./docs/environment.md) for the full reference.

Key variables:

| Variable | Where |
|----------|-------|
| `CYCLOPS_ENCRYPTION_KEY` | Both services — `openssl rand -hex 32` |
| `CYCLOPS_SETUP_SECRET` | `apps/api` only — `openssl rand -hex 32` |
| `CYCLOPS_MONTHLY_TOKEN_BUDGET` | `apps/worker` only — default 1 000 000 |

## Deployment (Railway)

See [docs/env-vars.md](./docs/env-vars.md) for Railway-specific configuration (PgBouncer, Redis settings, private key formatting).

Only `apps/api` runs `db:migrate` on deploy (prevents concurrent migration races).

## Contributing

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Please report
security issues privately per [SECURITY.md](./SECURITY.md), and be kind per our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Tarsha de Souza
