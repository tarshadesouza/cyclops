# CyclOps

When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time.

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

CyclOps runs zero-config with safe defaults. To customize per repository — detector kill switches, confidence threshold, output channels, and **where fixes land** — add a `.cyclops.yml`. See [docs/configuration.md](./docs/configuration.md) for the full reference.

> ⚠️ **`autofixMode: autofix` commits fixes directly to your PR branches.** The default (`locked`) opens a review PR instead. Read the [disclaimer](./docs/configuration.md#disclaimer-autofix-mode-writes-directly-to-your-branches) before enabling it.

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
