# Configuring CyclOps — `.cyclops.yml`

CyclOps works with **zero configuration** — sensible, safe defaults apply out of
the box. To customize behavior per repository, add a `.cyclops.yml` file to the
repository root. It's read from the branch under analysis on every run, so
changes take effect immediately.

Every field is optional; anything you omit falls back to the default below.

```yaml
# .cyclops.yml — all fields shown with their defaults

# Per-detector kill switches. Set any to false to stop CyclOps analyzing that
# class of failure.
detectors:
  lint:          true
  flakyTest:     true
  build:         true
  testFailure:   true
  missingEnv:    true
  expiredSecret: true

# Minimum AI confidence (0–1) before a finding advances to an action
# (check run, PR comment, or fix). Higher = more conservative.
confidenceThreshold: 0.85

# How CyclOps fixes failures. See "Autofix modes" below.
autofix:
  mode: suggest          # off | suggest | agent   (default: suggest)
  agent:                 # only used when mode: agent
    permission: safe     # safe   → fix on a new cyclops/fix/* branch + open a PR
                         # all-in → commit fixes directly to the PR's own branch
    maxIterations: 3     # how many times CyclOps re-runs the agent against real CI
    model: claude-sonnet-5   # the agent model (cost / quality lever)
  dryRun: false          # true → agent proposes a fix but nothing is committed
  rateLimit: 3           # max fix sessions per hour per repo

# Output channels — turn any off to silence that surface.
checkRuns:    true
prComments:   true
githubIssues: true

notifications:
  slack:
    enabled: true
    channel: "#your-channel"          # optional
    webhookUrl: "https://hooks.slack.com/services/…"  # optional
```

## Autofix modes

`autofix.mode` decides **what CyclOps offers to do** about a fixable failure.
Every mode is triggered explicitly — by a **check-run button** or by ticking a
**checkbox in CyclOps's PR comment** — so nothing writes to your code until a
repo writer asks for it.

| `mode` | What you get | Where the fix lands |
|---|---|---|
| `off` | Analysis only — no fix trigger is offered | — |
| `suggest` *(default)* | Agent runs **once**, proposes a **diff**; you click **Apply** to commit it | the PR's branch, one commit |
| `agent` | Agent **loops until CI is green**, re-running against real CI | depends on `agent.permission` |

When `mode: agent`, `agent.permission` decides where the loop commits:

- **`safe`** — the fix lands on a fresh `cyclops/fix/*` branch and CyclOps opens
  a **pull request** for review. Your original branch is never touched. Status
  updates are posted on the original PR.
- **`all-in`** — CyclOps commits fixes **directly to the pull request's own head
  branch**, iterating there until CI is green. Convenient, but it writes to your
  branch (see the disclaimer below).

`dryRun: true` is a safe way to try any mode: the agent produces a fix but
CyclOps **promotes nothing** — it posts the proposed diff/SHA and stops, so you
can watch the behavior without a single commit landing.

## How a fix is triggered

For any fixable finding (a code-level detector — lint, test failure, build,
snapshot, flaky — at/above `confidenceThreshold`), CyclOps surfaces the trigger
two ways, both **permission-gated** (only repo writers can use them):

1. **Check-run button** — on the "Cyclops CI Analysis" check (in the PR's
   **Checks** tab). The label reflects the mode: *Suggest a fix* /
   *Fix in a new PR* (safe) / *Fix on this branch* (all-in).
2. **PR-comment checkbox** — a `- [ ] 🤖 Let Cyclops fix this` box inside
   CyclOps's analysis comment, right in the PR conversation. Ticking it starts
   the same fix. (Requires the CyclOps GitHub App to be subscribed to
   *Issue comment* events.)

The moment a fix starts, CyclOps posts a **"🔧 Cyclops is on it"** status
comment and updates it as the agent works — ending in one of:

- **✅ fixed it — CI is green** (agent modes, success)
- **🔍 dry run — fix proposed, nothing committed** (`dryRun: true`)
- **⛔ stopped — max fix attempts reached** / **the same failure kept recurring**
- **⚠️ stopped — an error interrupted the fix loop**

## Disclaimer: `all-in` writes directly to your branches

Setting **`agent.permission: all-in`** means:

> **CyclOps will push commits DIRECTLY to the head branch of your open pull
> requests.** Each loop iteration is committed straight onto the PR's own branch
> — no intermediate branch, no separate review PR — until CI is green or a stop
> condition trips (`agent.maxIterations`).

Before enabling `all-in`, make sure you're comfortable with **all** of the
following, because CyclOps relies on them as guardrails:

- **Branch protection stays in force.** CyclOps commits like any collaborator;
  it cannot merge, and it never force-pushes onto your PR branch. Required
  reviews and status checks still gate the merge. Keep them on.
- **You trust the fixes on this repo.** Direct commits land in your history
  immediately. A high `confidenceThreshold` and the per-detector switches keep
  this conservative.
- **It's reversible.** Everything CyclOps commits is a normal commit you can
  revert.

If any of that gives you pause, use **`safe`** — you still get the full agent
loop, just on a reviewable branch and PR instead of your own.

### Migrating from the old config

The previous flat shape is still accepted and mapped automatically:

| Old | New |
|---|---|
| `autofix: false` | `autofix: { mode: off }` |
| `autofixMode: locked` | `autofix: { mode: agent, agent: { permission: safe } }` |
| `autofixMode: autofix` | `autofix: { mode: agent, agent: { permission: all-in } }` |
| `autofixRateLimit: N` | `autofix: { rateLimit: N }` |
