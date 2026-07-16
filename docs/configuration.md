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

# Master switch for automatically opening fix PRs from the normal pipeline
# (no button press). Turn off to require the "Implement fix" button for every fix.
autofix: true

# WHERE fixes land. See the disclaimer below before changing this.
#   locked  — fixes go on a separate cyclops/fix/* branch and open a PR for review
#   autofix — fixes are committed DIRECTLY to the pull request's own head branch
autofixMode: locked

# Max auto-fix PRs per hour per repo (applies to non-manual fixes only).
autofixRateLimit: 3

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

## Disclaimer: autofix mode writes directly to your branches

By default (`autofixMode: locked`) every fix CyclOps makes lands on its **own
`cyclops/fix/*` branch** and opens a pull request. Nothing touches your code
until a human reviews and merges it. This is the safe, reversible default and is
recommended for most repositories.

Setting **`autofixMode: autofix`** changes this materially:

> **CyclOps will push commits DIRECTLY to the head branch of your open pull
> requests.** When the "Implement fix" button starts a fix loop, each iteration
> is committed straight onto the PR's own branch — no intermediate branch, no
> separate review PR. The agentic loop keeps committing (up to 5 attempts) until
> CI is green or it gives up.

Before enabling `autofix` mode, make sure you're comfortable with **all** of the
following, because CyclOps relies on them as guardrails:

- **Branch protection stays in force.** CyclOps commits like any collaborator;
  it cannot merge, and it never force-pushes. Required reviews and status checks
  still gate the merge. Keep them on.
- **You trust the fixes on this repo.** Direct commits are convenient but they
  land in your history immediately. High `confidenceThreshold` and the per-detector
  switches are your levers to keep this conservative.
- **A moved branch aborts safely.** If someone else pushes to the branch, CyclOps's
  fast-forward fails and the iteration stops rather than clobbering the new work.
- **It's reversible.** Everything CyclOps commits is a normal commit you can revert.

If any of that gives you pause, stay on `locked` — you still get the full fix
loop, just on a reviewable branch instead of your own.

## The "Implement fix" button

Regardless of mode, CyclOps surfaces an **Implement fix** button on its check run
for fixable findings (lint / snapshot with a high-confidence suggested fix).
Pressing it starts the fix loop. The button's description reflects the active
mode so you know what pressing it will do:

- **locked** → *"Open a PR with cyclops's fix"*
- **autofix** → *"⚠ Commits fix directly to this branch"*
