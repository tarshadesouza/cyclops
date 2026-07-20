# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via GitHub: go to the **Security** tab → **Report a
vulnerability** (private security advisory). Include steps to reproduce and the
impact you observed. We aim to acknowledge reports within a few days.

## How CyclOps handles your code and keys

CyclOps is designed so the sensitive parts stay under your control:

- **Bring your own key (BYOK).** CyclOps uses *your* Anthropic API key. It is
  encrypted at rest with AES-256-GCM (`CYCLOPS_ENCRYPTION_KEY`), decrypted only
  at the moment of each AI call, and never logged.
- **The fix agent runs in *your* CI, on *your* key.** The autonomous coding
  agent executes inside your repository's own GitHub Actions runner (the
  reusable `agent.yml`), using a repo-scoped `GITHUB_TOKEN` and your
  `ANTHROPIC_API_KEY` secret. CyclOps's central service never holds a
  code-write credential for the agent's work.
- **No force-push, no merge.** CyclOps commits like any collaborator. It cannot
  merge and never force-pushes onto your branches — branch protection and
  required checks still gate every merge.
- **Explicit, permission-gated fixes.** A fix only runs when a repo writer ticks
  the "Let Cyclops fix this" checkbox (or presses the check-run button).
  Nothing writes to your code automatically.
- **Tenant isolation.** Per-installation data isolation is enforced at both the
  query layer and Postgres row-level security (RLS).

## Scope

This policy covers the CyclOps app (`apps/api`, `apps/worker`), the shared
packages under `packages/`, and the reusable workflow in
`.github/workflows/agent.yml`. Self-hosted deployments are responsible for
their own infrastructure, secrets, and GitHub App configuration.
