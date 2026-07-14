---
phase: 03-action-engine-output-channels
verified: 2026-07-14T06:40:04Z
status: human_needed
score: 12/12 must-haves verified (code); live e2e deferred to first Railway deploy
human_verification:
  - test: "Upsert PR comment — edit-in-place"
    expected: "cyclops[bot] posts one comment on PR open; subsequent workflow failures PATCH the same comment (same comment ID), not post a second one"
    why_human: "Requires live GitHub App installation and a failing workflow run against a real PR"
  - test: "Check run appears on commit"
    expected: "A 'Cyclops CI Analysis' check run with failure/neutral conclusion and inline annotations appears on the commit's Checks tab in GitHub"
    why_human: "Requires live GitHub App with checks:write permission and a real commit SHA"
  - test: "Autofix lint PR created end-to-end"
    expected: "A branch named cyclops/autofix/lint/{sha7}-{epoch} is pushed and a PR targeting the source branch is opened with the fixed file content"
    why_human: "Requires a live Finding with suggestedFix containing multi-line content and a real repo write token"
  - test: "Autofix snapshot PR created end-to-end"
    expected: "A branch named cyclops/autofix/snapshot/{sha7}-{epoch} is pushed and a PR is opened; content must start with 'exports[' or '// Jest'"
    why_human: "Requires a live Finding with valid snapshot suggestedFix content"
  - test: "Kill switch — autofix:false suppresses autofix PRs"
    expected: "Adding 'autofix: false' to .cyclops.yml in the target repo causes all create-autofix-pr-* jobs to log 'kill_switched' and return without creating branches or PRs"
    why_human: "Requires live config delivery via GitHub Contents API and observable job logs on Railway"
  - test: "Kill switch — detectors.lint:false suppresses lint actions"
    expected: "Setting 'detectors: { lint: false }' in .cyclops.yml prevents upsert-pr-comment and create-autofix-pr-lint jobs from firing for Lint findings"
    why_human: "Requires live deployment with a Lint finding in the queue"
  - test: "ActionDedup 24h window prevents duplicate secondary actions"
    expected: "A second rerun-workflow or send-slack-alert job for the same (installationId, repositoryId, detectorType, ref) within 24h returns skipped:true and logs 'deduped'"
    why_human: "Requires two consecutive job runs against live Redis/Postgres to observe dedup behaviour"
---

# Phase 3: Action Engine & Output Channels — Verification Report

**Phase Goal:** cyclops[bot] delivers consolidated, deduplicated output on every failing workflow run — exactly one PR comment edited in place, a GitHub Check Run on every commit, autofix PRs for high-confidence Lint and Snapshot failures, and per-repo kill switches that immediately suppress any action.
**Verified:** 2026-07-14T06:40:04Z
**Status:** human_needed (all 12 code must-haves pass; 7 live e2e items deferred to first Railway deploy)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | One PR comment edited in place (PATCH, not duplicate POST) | HUMAN_NEEDED | Code verified: `existing` branch issues PATCH to `/issues/comments/{id}`; live behaviour deferred |
| 2 | GitHub Check Run on every commit reusing same run ID | HUMAN_NEEDED | Code verified: `finding.cyclopsCheckRunId` reuse path confirmed; live behaviour deferred |
| 3 | Autofix lint PR created via Git Data API | HUMAN_NEEDED | Code verified: full 5-step chain present; live branch push deferred |
| 4 | Autofix snapshot PR created via Git Data API | HUMAN_NEEDED | Code verified: full 5-step chain with snapshot content guard; live branch push deferred |
| 5 | Kill switches suppress all action types | HUMAN_NEEDED | Code verified: `isActionKillSwitched` covers autofix, prComments, checkRuns, per-detector; live config delivery deferred |
| 6 | fetchConfig zero-config fallback with 60s TTL | VERIFIED | `configCache` Map with `expiresAt: Date.now() + 60_000`; catch block falls back to `CyclopsConfigSchema.parse({})` |
| 7 | ActionDedup cleanup prevents unbounded table growth | VERIFIED | Probabilistic 1% `deleteMany({ where: { expiresAt: { lt: new Date() } } })` in action-execution.ts line 199 |
| 8 | All 8 action types handled with real implementations | VERIFIED | HANDLERS map (lines 88-97) maps all 8 keys to imported, substantive functions |

**Score:** 12/12 code must-haves pass. 7 truths marked human_needed for live deployment confirmation.

---

### Must-Have Verification (Detailed)

| # | Must-Have | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `handleUpsertPrComment` uses PATCH when PrComment already exists | PASS | `github-outputs.ts:97-103` — PATCH `/repos/{owner}/{repo}/issues/comments/{comment_id}` in `existing` branch |
| 2 | `handleUpdateCheckRun` reuses `cyclopsCheckRunId` via PATCH | PASS | `github-outputs.ts:166-190` — checks `finding.cyclopsCheckRunId`, creates + persists only when null, then PATCH for all updates |
| 3 | `handleAutofixLint` creates branch via Git Data API + opens PR | PASS | `github-autofix.ts:113-191` — full 5-step chain: get-commit → create-tree → create-commit → create-ref → create-PR |
| 4 | `handleAutofixSnapshot` creates branch via Git Data API + opens PR | PASS | `github-autofix.ts:247-322` — same 5-step chain with snapshot content guard (`exports[` / `// Jest`) |
| 5 | AutofixPr dedup check in both autofix handlers | PASS | `isAutofixDeduped` called in `handleAutofixLint:92` and `handleAutofixSnapshot:224` before branch creation |
| 6 | Kill switch: `config.autofix === false` suppresses autofix | PASS | `action-execution.ts:72-73` — `!config.autofix` returns true (kill-switched) for both autofix action types |
| 7 | Kill switch: `config.detectors[type] === false` suppresses per-detector | PASS | `action-execution.ts:59-62` — `detectorKey in config.detectors && !config.detectors[detectorKey]` (direct boolean, consistent with schema) |
| 8 | `fetchConfig` loads `.cyclops.yml` with 60s TTL cache + zero-config fallback | PASS | `loader.ts:5-38` — `configCache` Map, `expiresAt: Date.now() + 60_000`, catch block calls `CyclopsConfigSchema.parse({})` |
| 9 | ActionDedup cleanup (deleteMany with expiresAt filter) wired in action-execution.ts | PASS | `action-execution.ts:198-205` — `Math.random() < 0.01` guard, `deleteMany({ where: { expiresAt: { lt: new Date() } } })` |
| 10 | HANDLERS map has all 8 entries with no stub bodies | PASS | `action-execution.ts:88-97` — all 8 keys point to real imported functions; no TODO/placeholder/not-implemented patterns found |
| 11 | handleRerunWorkflow, handleCancelWorkflow, handleSlackAlert, handleCreateGithubIssue all present | PASS | All 4 in `github-secondary.ts` with substantive implementations (93, 148, 224, 316 lines respectively) |
| 12 | ActionDedup used in at least 3 of the 4 secondary handlers | PASS | `checkActionDedup`/`recordActionDedup` called in handleRerunWorkflow (lines 65, 83), handleCancelWorkflow (108, 141), handleSlackAlert (165, 214); handleCreateGithubIssue uses TrackedIssue table intentionally (documented in code comment) |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/worker/src/lib/github-outputs.ts` | PR comment upsert + check run update | VERIFIED | 263 lines, exports `handleUpsertPrComment` and `handleUpdateCheckRun`, imported in action-execution.ts |
| `apps/worker/src/lib/github-autofix.ts` | Autofix lint + snapshot via Git Data API | VERIFIED | 324 lines, exports `handleAutofixLint` and `handleAutofixSnapshot`, imported in action-execution.ts |
| `apps/worker/src/lib/github-secondary.ts` | Rerun/cancel/Slack/issue handlers + ActionDedup helpers | VERIFIED | 317 lines, exports all 4 handlers + `checkActionDedup`/`recordActionDedup` |
| `apps/worker/src/workers/action-execution.ts` | HANDLERS map, kill switch, ActionDedup cleanup | VERIFIED | 245 lines, all 8 handlers registered, `isActionKillSwitched` exported, cleanup at line 198 |
| `packages/config/src/loader.ts` | fetchConfig with 60s TTL cache + fallback | VERIFIED | 38 lines, Map-based cache, try/catch fallback to schema defaults |
| `packages/config/src/schema.ts` | CyclopsConfig with autofix/detectors/prComments/checkRuns kill switches | VERIFIED | 27 lines, all kill-switch fields present as booleans with defaults |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `action-execution.ts` | `github-outputs.ts` | named import | WIRED | `import { handleUpsertPrComment, handleUpdateCheckRun }` line 13 |
| `action-execution.ts` | `github-autofix.ts` | named import | WIRED | `import { handleAutofixLint, handleAutofixSnapshot }` line 14 |
| `action-execution.ts` | `github-secondary.ts` | named import | WIRED | `import { handleRerunWorkflow, handleCancelWorkflow, handleSlackAlert, handleCreateGithubIssue }` lines 15-20 |
| `action-execution.ts` | `@ciintel/config` | `fetchConfig` | WIRED | Line 11 import, called at line 153 with `octokit, owner, repo, ref, repositoryId` |
| `action-execution.ts` | kill switch gate | `isActionKillSwitched` | WIRED | Called at line 156 before handler dispatch |
| `action-execution.ts` | ActionDedup cleanup | `db.actionDedup.deleteMany` | WIRED | Probabilistic cleanup at lines 198-205 |
| `handleUpsertPrComment` | GitHub Comments API | PATCH on existing | WIRED | `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` at line 98 |
| `handleUpdateCheckRun` | GitHub Checks API | PATCH with `cyclopsCheckRunId` | WIRED | PATCH `/repos/{owner}/{repo}/check-runs/{check_run_id}` at lines 224, 238 |
| `handleAutofixLint` | Git Data API | 5-step chain | WIRED | get-commit → create-tree → create-commit → create-ref → create-PR at lines 113-172 |
| `handleAutofixSnapshot` | Git Data API | 5-step chain | WIRED | Same pattern at lines 247-303 |

---

### Anti-Patterns Scan

No blockers or warnings found.

- Zero TODO/FIXME/placeholder/not-implemented patterns across the 4 key files.
- No empty return `{}` / `return null` implementations in handlers.
- No console.log-only handler bodies.
- The one `return null` equivalent is `return { skipped: true, reason: "..." }` which is intentional and documented guard logic.

---

### Human Verification Required

All 7 items below require a live Railway deployment with a GitHub App installed on a test repository.

#### 1. Edit-in-place PR comment (no duplicates)

**Test:** Push two consecutive failing commits to a PR branch so that two `upsert-pr-comment` jobs fire.
**Expected:** Only one comment from cyclops[bot] appears on the PR; the second job PATCHes the body in place (updated "Analysis" table). GitHub comment ID is identical between the two.
**Why human:** Cannot verify GitHub API idempotency or actual comment count programmatically from code alone.

#### 2. Check run on commit

**Test:** Open a PR, let a workflow fail, observe the Checks tab on the commit in GitHub UI.
**Expected:** A check named "Cyclops CI Analysis" appears with conclusion `failure` or `neutral`, inline annotations visible where violations have `path` and `line` populated.
**Why human:** GitHub Checks API response and UI rendering not verifiable from code.

#### 3. Autofix lint PR end-to-end

**Test:** Seed a Finding with `detectorType=Lint`, `confidence >= 0.85`, `suggestedFix` containing 4+ lines of real file content, and one entry in `affectedFiles`. Trigger the `create-autofix-pr-lint` job.
**Expected:** A branch `cyclops/autofix/lint/{sha7}-{epoch}` appears in the repo and a PR is opened targeting the source branch.
**Why human:** Requires real Octokit token with `contents:write` and `pull_requests:write` on a test repo.

#### 4. Autofix snapshot PR end-to-end

**Test:** Seed a Finding with `detectorType=Snapshot`, valid `suggestedFix` starting with `exports[`, trigger `create-autofix-pr-snapshot`.
**Expected:** Branch `cyclops/autofix/snapshot/{sha7}-{epoch}` created and PR opened. Verify isValidFileContent guard rejects a Finding where suggestedFix is prose (returns `skipped: no_valid_snapshot_content`).
**Why human:** Same as above; also validates the content guard logic at runtime.

#### 5. Kill switch — `autofix: false`

**Test:** Add `.cyclops.yml` with `autofix: false` to the test repo. Trigger a `create-autofix-pr-lint` job.
**Expected:** Job logs `Action kill-switched by config — skipping`, no branch or PR created.
**Why human:** Requires live config fetch from GitHub Contents API and observable logs.

#### 6. Kill switch — `detectors.lint: false`

**Test:** Add `.cyclops.yml` with `detectors: { lint: false }` to the test repo. Trigger a `upsert-pr-comment` job for a Lint finding.
**Expected:** Job returns `skipped: kill_switched`. Repeat with a FlakyTest finding — should not be suppressed.
**Why human:** Same as above; also validates per-detector granularity.

#### 7. ActionDedup 24h window for secondary handlers

**Test:** Fire two `rerun-workflow` jobs for the same (installationId, repositoryId, detectorType, ref) within 60 seconds.
**Expected:** First job triggers GitHub rerun and records ActionDedup row. Second job returns `skipped: deduped` and logs "Rerun already performed within 24h".
**Why human:** Requires live Postgres + Redis and observable job output.

---

### Notes

- Must-have #7 checks `config.detectors[detectorType] === false` (direct boolean) rather than `.enabled === false` as described in the prompt. The schema (`schema.ts`) defines all detector entries as `z.boolean()`, so the implementation is correct and consistent — the must-have description was slightly imprecise in wording.
- `handleCreateGithubIssue` intentionally does not use `ActionDedup` — it uses the `TrackedIssue` table instead and adds a comment on repeat failures rather than silently skipping. This is documented in the code comment block at `action-execution.ts:80-84` and satisfies must-have #12 (3 of 4 secondary handlers use ActionDedup).

---

_Verified: 2026-07-14T06:40:04Z_
_Verifier: Claude (gsd-verifier)_
