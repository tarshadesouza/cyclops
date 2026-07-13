# Phase 2: Detector Pipeline & AI Analysis — Context

**Gathered:** 2026-07-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Six platform-agnostic detectors classify CI failures from real GitHub Actions events (iOS, Android, web, backend). An AI enrichment pass adds structured findings with confidence, evidence, root cause, suggested fix, affected files, severity, and caveat fields. No user-facing output — this is the data pipeline Phase 3 will act on.

</domain>

<decisions>
## Implementation Decisions

### The 6 Detectors

The six detectors are:
- **Lint** — platform-agnostic; infer the linter (ESLint, SwiftLint, ktlint, Rubocop, etc.) from the workflow file commands, then extract violations from log output
- **FlakyTest** — history-based; tests with ≥1 pass + ≥2 fails (or vice versa) in the history window
- **BuildFailure** — compile/build errors on any platform (tsc, Xcode, Gradle, go build, etc.)
- **TestFailure** — tests that newly started failing (distinct from FlakyTest — no mixed history)
- **MissingEnvVar** — CI jobs failing due to missing secrets or environment variables
- **ExpiredSecret** — expired API keys, iOS provisioning profiles, certificates, tokens

### Data Inputs for Detectors

Each detector receives:
1. **CI log** — pre-extracted excerpt (detector identifies the relevant section, not the full log) from GitHub Actions API
2. **Workflow file** — the `.github/workflows/*.yml` that triggered the failure (fetched via GitHub API)

Both are fetched via GitHub API at job start. No extra API calls after that — AI gets the pre-extracted excerpt, not the full log.

### Multi-Failure Behavior

When a workflow run has multiple failed jobs: run all applicable detectors on all failed jobs, then **aggregate into one finding per workflow run**. Do not stop at the first failed job.

### Unknown Failure Types

When no detector matches: still send to AI for best-effort classification. Store the finding with `detectorType: "Unknown"`. AI provides classification and evidence. Never silently drop.

### Linter Identification

Infer linter type from the workflow file (look at the step commands — `eslint`, `swiftlint`, `ktlint`, `rubocop`, etc.). Do not rely on log-output parsing for identification.

### Test Name Extraction (Flaky Test)

AI extracts individual test names from the log. Works for any test runner format (XCTest, JUnit, Jest, pytest, RSpec) without per-runner parsers.

### Flaky Test History

- Primary: GitHub check run history API (no new DB tables in Phase 2)
- Lookup window: last 5 runs on same branch OR last 20 runs across all branches (branch-local first, repo-wide if inconclusive)
- Flaky threshold: at least 1 pass + 2 fails (or vice versa) in the window
- First-run failures (no history) are NOT classified as flaky

### AI Model

Claude Sonnet 5 (`claude-sonnet-5`) — default, no per-installation override in Phase 2.

### AI Finding Schema

Each finding must contain:
- `confidence` — float (0.0–1.0)
- `evidence[]` — array of strings (never null, never empty for stored findings)
- `caveat` — string (limitations or uncertainty)
- `rootCause` — 1–2 sentence plain English explanation
- `suggestedFix` — brief, actionable next step
- `affectedFiles[]` — list of implicated files
- `severity` — enum: `critical | high | medium | low`
- `detectorType` — which of the 6 detectors matched (or "Unknown")

### Confidence Thresholds

- `high` ≥ 0.85 — advances to Phase 3 action workers
- `medium` 0.60–0.85 — stored, no actions triggered
- `low` < 0.60 — stored, no actions triggered

Only `high` confidence findings with non-empty `evidence[]` proceed to Phase 3.

### BYOK API Key (Per-Installation Claude Key)

Each installation provides their own Anthropic API key at setup time:
- **Setup flow:** `POST /setup` endpoint — installation owner calls it with their key (curl or CLI). No UI required for Phase 2.
- **Storage:** AES-256-GCM encrypted at rest in the database, per installation. Decryption key stored as `CYCLOPS_ENCRYPTION_KEY` Railway env var. Key is never logged or returned via API.
- **Access pattern:** Worker fetches and decrypts the key at job start. Never stored in Redis or job payload.
- **Schema addition:** `Installation` model gains an `encryptedApiKey` field (nullable until setup is called).

### Token Usage Tracking

Write a token usage record per AI call containing: `installationId`, `detectorId`, model name, input tokens, output tokens, timestamp.

### Monthly Token Cap

- Default: configurable via `CYCLOPS_MONTHLY_TOKEN_BUDGET` env var (Claude's discretion on default value, document clearly)
- Hard-stop behavior: when cap is reached, skip AI analysis for remaining failures that month. Store the `DetectorResult` only (confidence=null, no evidence). Do not drop the finding entirely.
- Budget resets on the 1st of each month.

### Claude's Discretion

- Default value for `CYCLOPS_MONTHLY_TOKEN_BUDGET`
- Log excerpt extraction strategy within each detector (how many lines, which section)
- DB schema for token usage table
- Encryption/decryption utility implementation details

</decisions>

<specifics>
## Specific Ideas

- "Not just TypeScript — this has to go for any platform: iOS and Android as well, not just web/backend"
- "Linting should be adaptable per stack/platform" — Lint detector infers linter from workflow file, not hardcoded to ESLint
- "Security is paramount even for an MVP" — AES-256-GCM for API key storage, key never in logs or job payloads
- BYOK must be part of Phase 2, not deferred — setup endpoint required before AI analysis works

</specifics>

<deferred>
## Deferred Ideas

- BYOK via UI (redirect after GitHub App install → web form) — Phase 3 or later when frontend exists
- Per-installation model override (let installations choose Haiku vs Sonnet) — future phase
- Custom detector plugins / SDK — Phase 4 (Public SDK)
- Dashboard showing per-installation token usage — future phase

</deferred>

---

*Phase: 02-detector-pipeline-and-ai-analysis*
*Context gathered: 2026-07-13*
