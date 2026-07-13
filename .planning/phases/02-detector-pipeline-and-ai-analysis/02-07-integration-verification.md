---
phase: 02-detector-pipeline-and-ai-analysis
plan: 07
type: execute
wave: 5
depends_on: ["02-01", "02-02", "02-03", "02-04", "02-05", "02-06"]
files_modified:
  - .env.example
  - docs/environment.md
  - README.md
autonomous: false

must_haves:
  truths:
    - "All Phase 2 env vars are documented (CYCLOPS_ENCRYPTION_KEY, CYCLOPS_SETUP_SECRET, CYCLOPS_MONTHLY_TOKEN_BUDGET)"
    - "The full monorepo builds and the 0003 migration applies against the real database"
    - "A real failing workflow_run produces a Finding within ~60s, enriched with confidence/evidence/caveat"
    - "A high-confidence finding dispatches an action-execution job; a medium/low one does not"
    - "TokenUsage rows exist for AI calls; the monthly cap hard-stops further calls"
  artifacts:
    - path: ".env.example"
      provides: "Phase 2 env var documentation"
      contains: "CYCLOPS_ENCRYPTION_KEY"
  key_links:
    - from: "docs/environment.md"
      to: "operator setup"
      via: "documented generation commands + budget guidance"
      pattern: "CYCLOPS_MONTHLY_TOKEN_BUDGET"
---

<objective>
Finalize Phase 2: document all new environment variables, run a full build + migration, and perform an end-to-end verification of the detector -> AI -> routing pipeline against real GitHub events and a real Anthropic key.

Purpose: Prove the phase success criteria hold in the running system and give operators the config they need. This is the phase's acceptance gate.
Output: Updated env docs; a human-verified end-to-end run.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-RESEARCH.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-CONTEXT.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Document Phase 2 environment variables + full build/migrate</name>
  <files>.env.example, docs/environment.md, README.md</files>
  <action>
1. Add the new env vars to `.env.example` (create if absent) and to `docs/environment.md` (create if absent), each with a one-line purpose and, where relevant, a generation command:
   - `CYCLOPS_ENCRYPTION_KEY` — 64 hex chars (32 bytes) for AES-256-GCM of BYOK keys. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Required by BOTH apps/api and apps/worker (must be identical).
   - `CYCLOPS_SETUP_SECRET` — shared secret for the `x-setup-token` header on POST /setup. Required by apps/api.
   - `CYCLOPS_MONTHLY_TOKEN_BUDGET` — per-installation monthly token cap (default 1000000). Note approx cost at Sonnet 5 pricing (~$2-10/mo per installation). Required by apps/worker.
   - Note the model id `claude-sonnet-5` and that Anthropic keys are BYOK (supplied per installation via POST /setup, never a global env var).

2. In README.md, add a short "Configure BYOK API key" section showing the curl call:
   `curl -X POST $API_URL/setup/$INSTALLATION_ID -H "x-setup-token: $CYCLOPS_SETUP_SECRET" -H "content-type: application/json" -d '{"apiKey":"sk-ant-..."}'`

3. Run a full clean build: `pnpm -r build` (all packages + apps) — must exit 0.

4. Apply the migration against the configured database: `pnpm --filter @ciintel/db db:migrate`. If DATABASE_URL is set, confirm the `findings` and `token_usages` tables exist and RLS is enabled (`\d+ findings` shows "Row security: enabled/forced"). If DATABASE_URL is not available in this environment, note it and defer the DB assertions to the checkpoint below.
  </action>
  <verify>
`pnpm -r build` exits 0; `grep -q "CYCLOPS_ENCRYPTION_KEY" .env.example`; `grep -q "CYCLOPS_MONTHLY_TOKEN_BUDGET" docs/environment.md`; `grep -q "/setup/" README.md`.
  </verify>
  <done>All Phase 2 env vars documented with generation guidance; monorepo builds clean; migration applied (or explicitly deferred to checkpoint with reason).</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
The complete Phase 2 pipeline: webhook-ingestion dispatches failing workflow_run events to detector-dispatch, which fetches GitHub Actions logs + workflow YAML, runs all 6 detectors, stores a Finding, and dispatches ai-analysis; ai-analysis checks the monthly budget, decrypts the BYOK key, calls Claude Sonnet 5, records TokenUsage, enriches the Finding, and routes only high-confidence findings to action-execution.
  </what-built>
  <how-to-verify>
Prereqs: apps/api + apps/worker deployed/running with CYCLOPS_ENCRYPTION_KEY, CYCLOPS_SETUP_SECRET, CYCLOPS_MONTHLY_TOKEN_BUDGET, DATABASE_URL, Redis, and GitHub App envs set; the App installed on a test repo.

1. Register a key:
   `curl -X POST $API_URL/setup/$INSTALLATION_ID -H "x-setup-token: $CYCLOPS_SETUP_SECRET" -H "content-type: application/json" -d '{"apiKey":"sk-ant-..."}'` → expect 200 {ok:true}. Then verify with a wrong token → expect 401.
2. Trigger a failing ESLint (or Prettier) workflow in the test repo. Within ~60s, query the DB: `SELECT "detectorType","confidence",array_length(evidence,1) FROM findings ORDER BY "createdAt" DESC LIMIT 1;` → expect detectorType='Lint', confidence NOT NULL, evidence length >= 1 (criteria 1 + 3).
3. Re-run a test that previously passed but now fails (>=2 fails, >=1 pass in history) → expect a Finding with detectorType='FlakyTest'. Trigger a brand-new failing test (no history) → expect it is NOT FlakyTest (criterion 2).
4. Check routing: for a high-confidence finding (confidence>=0.85), confirm `advancedToAction=true` and an action-execution job was enqueued (BullMQ). For a medium/low finding confirm advancedToAction=false and NO action job (criterion 4).
5. Check token accounting: `SELECT "installationId","detectorId","model","inputTokens","outputTokens" FROM token_usages ORDER BY timestamp DESC LIMIT 3;` → rows present per AI call (criterion 5). Temporarily set CYCLOPS_MONTHLY_TOKEN_BUDGET very low, trigger another failure → confirm the finding has budgetExceeded=true and NO AI call was made.
6. Grep worker + api logs for any `sk-ant-` string or raw encryptedApiKey → expect NONE (constraint 3).
  </how-to-verify>
  <resume-signal>Type "approved" if all six checks pass, or describe which criterion failed and the observed behavior.</resume-signal>
</task>

</tasks>

<verification>
- `pnpm -r build` exits 0
- Env vars documented; migration applied with RLS on findings + token_usages
- End-to-end run satisfies criteria 1-5 (human-verified)
- No key material in logs
</verification>

<success_criteria>
- Lint failure -> Finding with files + rules within 60s (criterion 1)
- FlakyTest vs first-time failure classified correctly (criterion 2)
- Enriched findings always carry confidence + non-empty evidence + caveat (criterion 3)
- Only high-confidence findings advance to action-execution (criterion 4)
- TokenUsage recorded per call; monthly cap hard-stops (criterion 5)
</success_criteria>

<output>
After completion, create `.planning/phases/02-detector-pipeline-and-ai-analysis/02-07-SUMMARY.md`
</output>
