#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Manually fire the Cyclops agent sandbox (Phase 7) for testing, BEFORE the
# worker dispatch/poll/promote loop exists.
#
# It sends a repository_dispatch (event type `cyclops-agent`) to the test repo,
# which the client stub forwards to the reusable agent.yml. The agent checks out
# TARGET_REF, reproduces CI locally, fixes it, and pushes the result to
# refs/cyclops/session-<id>. Inspect that ref afterwards — nothing is promoted
# onto the target branch (that is CyclOps's job, not built yet), so this is an
# inherently dry run.
#
# Prereqs:
#   * ANTHROPIC_API_KEY set as an Actions secret on the test repo:
#       gh secret set ANTHROPIC_API_KEY --repo tarshadesouza/cyclops-test
#   * gh authenticated as an account that can dispatch to the test repo.
#
# Usage:
#   scripts/dispatch-agent-test.sh [target_ref] [model]
# Env overrides: CYCLOPS_TEST_REPO, CYCLOPS_MAX_TURNS
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${CYCLOPS_TEST_REPO:-tarshadesouza/cyclops-test}"
TARGET_REF="${1:-cyclops-fixture/lint-fail}"
MODEL="${2:-claude-sonnet-5}"
MAX_TURNS="${CYCLOPS_MAX_TURNS:-20}"
SESSION_ID="test-$(date +%s)"

echo "Dispatching cyclops-agent → $REPO"
echo "  target_ref : $TARGET_REF"
echo "  model      : $MODEL  (max_turns=$MAX_TURNS)"
echo "  session_id : $SESSION_ID  → refs/cyclops/session-$SESSION_ID"

payload="$(jq -n \
  --arg sid "$SESSION_ID" \
  --arg ref "$TARGET_REF" \
  --arg model "$MODEL" \
  --argjson turns "$MAX_TURNS" \
  '{
    event_type: "cyclops-agent",
    client_payload: {
      session_id: $sid,
      installation_id: 0,
      pr_number: 0,
      target_ref: $ref,
      level: "agent-safe",
      seed: {
        detector: "lint",
        summary: "ESLint failing in src/math.js (double-quote, semi, no-unused-vars).",
        affected_files: ["src/math.js"]
      },
      caps: { max_iterations: 1, max_turns: $turns, model: $model, dry_run: true }
    }
  }')"

echo "$payload" | gh api "repos/$REPO/dispatches" --input -
echo "Dispatched. Waiting for the run to appear…"

# repository_dispatch runs have no run-id in the response — poll for the newest
# run of the stub workflow, then watch it.
sleep 6
RUN_ID="$(gh run list --repo "$REPO" --workflow cyclops-agent.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
if [ -z "$RUN_ID" ]; then
  echo "Could not find the run yet. List it with:"
  echo "  gh run list --repo $REPO --workflow cyclops-agent.yml"
  exit 0
fi
echo "Watching run $RUN_ID …"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status || true

echo
echo "Inspect the agent's result:"
echo "  git fetch origin '+refs/cyclops/session-$SESSION_ID:refs/cyclops/session-$SESSION_ID'"
echo "  git diff $TARGET_REF refs/cyclops/session-$SESSION_ID"
