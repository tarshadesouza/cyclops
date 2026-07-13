# CyclOps

## What This Is

CyclOps is a SaaS platform and packageable npm SDK that acts as an intelligent reliability layer on top of CI/CD systems, starting with GitHub Actions. It installs as a GitHub App (`cyclops[bot]`) in under 30 seconds — users install from GitHub Marketplace, select repos, and the bot begins monitoring immediately. It automatically classifies CI failures, explains root causes, recommends fixes, automates low-risk remediations, and surfaces organization-wide reliability patterns.

Target market: mid-size engineering teams and enterprises that cannot afford dedicated DevOps teams and lose significant time to recurring, predictable CI failures.

## Core Value

When a CI job fails, CyclOps tells you exactly why and either fixes it automatically or hands you a one-click remediation — eliminating the manual log-reading cycle that wastes engineering time across the organization.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] GitHub App installs via GitHub Marketplace with org/repo scope selection
- [ ] Webhook receiver ingests GitHub Actions workflow run events
- [ ] Event queue decouples ingestion from processing (BullMQ + Redis)
- [ ] Lint Detector classifies ESLint/Prettier failures with autofix PR capability
- [ ] Snapshot Detector classifies Jest/Storybook snapshot failures with regeneration PR
- [ ] Expired Secret Detector classifies auth/token failures with Slack + Jira notification
- [ ] Flaky Test Detector identifies intermittent failures with auto-rerun
- [ ] Hanging Workflow Detector identifies stalled jobs with cancel + notify
- [ ] Workflow Drift Detector flags cross-repo workflow inconsistencies
- [ ] AI Analysis layer abstracts OpenAI/Anthropic/Gemini (Vercel AI SDK)
- [ ] Action Engine executes: create PR, rerun workflow, Slack alert, GitHub issue
- [ ] PR comment output with category, confidence, root cause, suggested fix
- [ ] GitHub Check annotation output (inline on diff)
- [ ] Optional `.cyclops.yml` config in repo root for per-repo customization
- [ ] Multi-tenant installation isolation by GitHub `installation_id`
- [ ] `@cyclops/core` npm SDK for self-hosted deployments

### Out of Scope (MVP)

- Web dashboard — bot interactions are the UI in MVP; dashboard is v2
- GitLab CI, CircleCI, Jenkins, Azure DevOps — GitHub Actions only for MVP
- CI health scoring and trend analytics — v2 after core detection is validated
- Secret expiration forecasting — v2
- Custom/self-hosted AI model support — v2 (API-based providers only in MVP)
- Billing/subscription management — manual onboarding for early customers

## Context

- Licensing model is deferred — open core is the likely direction but not locked
- No existing codebase; this is a greenfield project
- The GitHub App model gives `cyclops[bot]` a native identity on GitHub (comments, PRs, checks) without requiring users to manage service account tokens or PATs
- Webhooks are auto-configured on GitHub App installation — zero user setup
- Distribution: direct install link works day one; GitHub Marketplace listing follows after GitHub review
- The detector engine is designed as a plugin interface so new detectors can be added without modifying core
- AI providers are abstracted via Vercel AI SDK — enterprises can bring their own provider key

## Constraints

- **Tech Stack**: TypeScript monorepo (Turborepo + pnpm), Fastify, BullMQ + Redis, PostgreSQL + Prisma, Vercel AI SDK, Next.js (dashboard, post-MVP) — established in pre-planning conversation
- **Deployment**: Railway for MVP → AWS ECS/Fargate at scale
- **Package**: Published as `@cyclops/core` on npm for self-hosters
- **GitHub First**: MVP is GitHub Actions only — breadth comes after depth is validated
- **No Dashboard in MVP**: All user-facing output is via GitHub (PR comments, check annotations, issues) and Slack/Jira notifications

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript over Python | GitHub App ecosystem (Octokit, Probot) is TS-native; full-stack TS shares types across SDK/API/dashboard; npm is the right packaging channel for developer tools | — Pending |
| GitHub App over service account | Bot identity (`cyclops[bot]`), auto-configured webhooks, multi-tenant isolation, no token rotation burden for users | — Pending |
| No dashboard in MVP | Faster time-to-value; GitHub/Slack are surfaces engineers already live in; dashboard validated by demand not assumption | — Pending |
| Vercel AI SDK for LLM abstraction | Supports OpenAI, Anthropic, Gemini with unified interface; enterprises can swap providers without code changes | — Pending |
| BullMQ over Celery | TypeScript-native, lower overhead for event-driven webhook processing, excellent observability | — Pending |
| Licensing deferred | Ship MVP first; open core is likely direction once there's something worth protecting | — Pending |

---
*Last updated: 2026-07-13 after initialization*
