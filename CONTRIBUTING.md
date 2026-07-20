# Contributing to CyclOps

Thanks for your interest! CyclOps is an early-stage open-source project and
contributions are welcome — from bug reports to detectors to docs.

## Ways to help

- **File an issue** for bugs or ideas (a failing repro or a clear use case helps a lot).
- **Improve a detector** — the classifiers live in `packages/detectors`.
- **Docs** — the landing page and reference live in `docs/`.
- **Pick up a good first issue** if any are labelled.

Before a large change, open an issue first so we can agree on the approach.

## Local setup

CyclOps is a TypeScript monorepo (Turborepo + pnpm), split into `apps/api`
(Fastify webhook receiver) and `apps/worker` (BullMQ pipeline), with shared
`packages/`.

**Prerequisites:** Node.js 22+, pnpm 9+, PostgreSQL 15+, Redis 7+
(`maxmemory-policy noeviction`).

```bash
pnpm install
cp .env.example .env          # fill in values — see docs/environment.md
pnpm --filter @cyclops/db db:migrate
pnpm build
pnpm dev                      # both services in watch mode
```

## Before you open a PR

```bash
pnpm build                    # all packages compile
pnpm exec tsc --build --noEmit  # type-check
pnpm test                     # unit tests (e.g. pnpm --filter @cyclops/worker test)
```

- Match the surrounding code style; keep changes focused.
- Add or update tests for behavior changes where practical.
- Use clear commit messages; small, reviewable PRs merge fastest.
- CI (`.github/workflows/ci.yml`) runs build + type-check on every PR.

## Reporting security issues

Please do **not** open a public issue — see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
