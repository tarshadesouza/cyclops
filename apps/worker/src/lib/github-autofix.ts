import type { ActionType } from "@cyclops/queue";
import type { CyclopsConfig } from "@cyclops/config";
import type { Finding, FixSession } from "@cyclops/db";
import type { ActionContext } from "../workers/action-execution.js";
import {
  failureSignature,
  finalizeFixSession,
  upsertLoopComment,
  progressBody,
  resolveOpenPrForBranch,
} from "./fix-loop.js";

// ---------------------------------------------------------------------------
// "Implement fix" button — check-run action identifier. Pressing the button
// fires a `check_run` `requested_action` webhook carrying this identifier;
// webhook-ingestion matches on it to enqueue a manual autofix action.
// GitHub caps identifiers at 20 chars.
// ---------------------------------------------------------------------------
export const IMPLEMENT_FIX_ACTION_ID = "cyclops-fix";

// ---------------------------------------------------------------------------
// autofixActionTypeFor — the autofix action a detector's fix should run as.
// Only Lint and Snapshot produce full-file suggested fixes today.
// ---------------------------------------------------------------------------
export function autofixActionTypeFor(detectorType: string): ActionType | null {
  switch (detectorType.toLowerCase()) {
    case "lint":
      return "create-autofix-pr-lint";
    case "snapshot":
      return "create-autofix-pr-snapshot";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// isAutofixEligible — whether to render the "Implement fix" button for this
// finding. Requires a fixable detector, a usable suggested fix, at least one
// affected file, and confidence at/above the threshold (the handler enforces
// the same confidence guard, so button presence ⇔ the handler will act).
// ---------------------------------------------------------------------------
export function isAutofixEligible(
  finding: Finding,
  config: CyclopsConfig
): boolean {
  if (!autofixActionTypeFor(finding.detectorType)) return false;
  if (!finding.suggestedFix || finding.affectedFiles.length === 0) return false;
  if (finding.confidence == null || finding.confidence < config.confidenceThreshold) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// isRateLimited — ACT-12: max autofixRateLimit (default 3) autofix PRs per
// hour per repo
// ---------------------------------------------------------------------------
export async function isRateLimited(
  db: ActionContext["db"],
  installationId: number,
  repositoryId: number,
  limit: number
): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const count = await db.autofixPr.count({
    where: { installationId, repositoryId, createdAt: { gte: oneHourAgo } },
  });
  return count >= limit;
}

// ---------------------------------------------------------------------------
// isAutofixDeduped — ACT-11, ACT-13: check if autofix PR already created for
// this (installationId, repositoryId, detectorType, sha)
// ---------------------------------------------------------------------------
export async function isAutofixDeduped(
  db: ActionContext["db"],
  installationId: number,
  repositoryId: number,
  detectorType: string,
  sha: string
): Promise<boolean> {
  const existing = await db.autofixPr.findUnique({
    where: {
      installationId_repositoryId_detectorType_sha: {
        installationId,
        repositoryId,
        detectorType,
        sha,
      },
    },
  });
  return !!existing;
}

// ---------------------------------------------------------------------------
// isValidFileContent — sanity check: skip autofix if content looks like prose
// ---------------------------------------------------------------------------
function isValidFileContent(
  content: string,
  detectorType: "Lint" | "Snapshot"
): boolean {
  if (!content || content.trim().length < 10) return false;
  if (detectorType === "Snapshot") {
    // Snapshot content must start with exports[ or Object.freeze / // Jest — otherwise it's prose
    return (
      content.trimStart().startsWith("exports[") ||
      content.trimStart().startsWith("// Jest")
    );
  }
  // Lint: accept if content has multiple lines (real file content, not a one-liner description)
  return content.split("\n").length > 3;
}

// ---------------------------------------------------------------------------
// commitFix — build the fix commit via the Git Data API, then place it based
// on config.autofixMode:
//   "autofix" → fast-forward the PR's own head branch directly onto the new
//               commit (never force — a moved branch surfaces as an error, not
//               a clobber). No PR, no AutofixPr row.
//   "locked"  → create a fresh cyclops/autofix/* branch + open a review PR,
//               and record the AutofixPr row (dedup source).
// Shared by the lint and snapshot handlers so the mode logic lives in one place.
// ---------------------------------------------------------------------------
// buildFixCommit — the Git Data API commit-build (tree + commit), parented on
// the failing sha (= current branch head). Returns the new commit sha. Placing
// it (branch/PR vs direct) is the caller's job. The file path travels in the
// tree body, so it's never URL-encoded.
async function buildFixCommit(
  ctx: ActionContext,
  filePath: string,
  content: string,
  commitMessage: string
): Promise<string> {
  const { octokit, finding, owner, repo } = ctx;
  const { sha } = finding;

  const commitResp = await (octokit as any).request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner, repo, commit_sha: sha }
  );
  const treeResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      owner,
      repo,
      base_tree: commitResp.data.tree.sha,
      tree: [{ path: filePath, mode: "100644", type: "blob", content }],
    }
  );
  const newCommitResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/commits",
    { owner, repo, message: commitMessage, tree: treeResp.data.sha, parents: [sha] }
  );
  return newCommitResp.data.sha as string;
}

// createBranchRef / updateBranchRef — `{+ref}` keeps the slash in heads/<branch>
// unencoded; force:false so a non-fast-forward errors rather than clobbering.
async function createBranchRef(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any,
  owner: string,
  repo: string,
  branch: string,
  sha: string
): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha,
  });
}

async function updateBranchRef(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any,
  owner: string,
  repo: string,
  branch: string,
  sha: string
): Promise<void> {
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{+ref}", {
    owner,
    repo,
    ref: `heads/${branch}`,
    sha,
    force: false,
  });
}

async function commitFix(
  ctx: ActionContext,
  opts: {
    filePath: string;
    content: string;
    commitMessage: string;
    branchPrefix: "lint" | "snapshot";
    prTitle: string;
    prBody: string;
  }
): Promise<{ ok: true }> {
  const { octokit, db, finding, owner, repo, config, log } = ctx;
  const { installationId, repositoryId, detectorType, sha, ref } = finding;

  const newCommitSha = await buildFixCommit(ctx, opts.filePath, opts.content, opts.commitMessage);
  const headBranch = (ref ?? "main").replace(/^refs\/heads\//, "");

  if (config.autofixMode === "autofix") {
    // Commit DIRECTLY to the PR's own head branch.
    await updateBranchRef(octokit, owner, repo, headBranch, newCommitSha);
    log.info(
      { headBranch, newCommitSha, findingId: finding.id },
      "Autofix committed directly to head branch (autofix mode)"
    );
    return { ok: true as const };
  }

  // locked mode: new branch + review PR
  const branchName = `cyclops/autofix/${opts.branchPrefix}/${sha.slice(0, 7)}-${Date.now()}`;
  await createBranchRef(octokit, owner, repo, branchName, newCommitSha);
  const prResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/pulls",
    {
      owner,
      repo,
      title: opts.prTitle,
      body: opts.prBody,
      head: branchName,
      base: headBranch,
      draft: false,
    }
  );
  await db.autofixPr.create({
    data: {
      installationId,
      repositoryId,
      detectorType,
      sha,
      branchName,
      prNumber: prResp.data.number,
    },
  });
  log.info(
    { branchName, prNumber: prResp.data.number },
    "Autofix PR created (locked mode)"
  );
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// applyFixForSession — one iteration of the fix LOOP (Phase 6 step 2). Enforces
// the no-progress and max-iteration stop conditions, commits the fix onto the
// session's stable branch (creating the branch + review PR on the first locked
// iteration), then advances the session and updates its progress comment.
// ---------------------------------------------------------------------------
async function applyFixForSession(
  ctx: ActionContext,
  session: FixSession,
  opts: {
    filePath: string;
    content: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
  }
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { octokit, db, finding, owner, repo, log } = ctx;
  const target = { octokit, db, owner, repo };

  // no-progress: this failure is identical to the previous iteration's failure
  const sig = failureSignature(finding);
  if (session.lastFailureSig && session.lastFailureSig === sig) {
    log.warn(
      { sessionId: session.id },
      "Fix loop: no progress (identical failure signature) — stopping"
    );
    await finalizeFixSession(target, session, "failed_no_progress");
    return { skipped: true as const, reason: "no_progress" };
  }

  // max-iteration cap (webhook-ingestion also gates re-dispatch; belt-and-suspenders)
  if (session.iteration >= session.maxIterations) {
    log.warn({ sessionId: session.id }, "Fix loop: max iterations reached — stopping");
    await finalizeFixSession(target, session, "failed_max_iterations");
    return { skipped: true as const, reason: "max_iterations" };
  }

  const newCommitSha = await buildFixCommit(ctx, opts.filePath, opts.content, opts.commitMessage);

  let prNumber = session.prNumber ?? undefined;
  if (session.mode === "autofix") {
    // commit directly onto the PR's own head branch (== session.branchName)
    await updateBranchRef(octokit, owner, repo, session.branchName, newCommitSha);
    // resolve the PR so the loop can post its progress/terminal comment
    if (!prNumber) {
      prNumber = await resolveOpenPrForBranch(octokit, owner, repo, session.branchName);
    }
  } else if (session.iteration === 0 && !prNumber) {
    // first locked iteration — create the fix branch and open the review PR
    await createBranchRef(octokit, owner, repo, session.branchName, newCommitSha);
    const prResp = await (octokit as any).request(
      "POST /repos/{owner}/{repo}/pulls",
      {
        owner,
        repo,
        title: opts.prTitle,
        body: opts.prBody,
        head: session.branchName,
        base: session.baseBranch,
        draft: false,
      }
    );
    prNumber = prResp.data.number;
  } else {
    // subsequent locked iteration — fast-forward the existing fix branch
    await updateBranchRef(octokit, owner, repo, session.branchName, newCommitSha);
  }

  const iteration = session.iteration + 1;
  const updated: FixSession = await db.fixSession.update({
    where: { id: session.id },
    data: {
      iteration,
      lastSha: newCommitSha,
      lastFailureSig: sig,
      ...(prNumber ? { prNumber } : {}),
    },
  });

  try {
    await upsertLoopComment(target, updated, progressBody(iteration, updated.maxIterations));
  } catch {
    // best-effort — progress comment is cosmetic
  }

  log.info(
    { sessionId: session.id, iteration, newCommitSha, branch: session.branchName },
    "Fix loop: pushed fix iteration"
  );
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// handleAutofixLint — ACT-05: Git Data API chain for lint fixes
// ---------------------------------------------------------------------------
export async function handleAutofixLint(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { db, finding, config, log } = ctx;
  const { installationId, repositoryId, detectorType, sha, suggestedFix, affectedFiles } =
    finding;

  // ACT-05: confidence guard (defense-in-depth — also enforced at dispatch in ai-analysis.ts)
  if (!finding.confidence || finding.confidence < config.confidenceThreshold) {
    log.info(
      { confidence: finding.confidence },
      "Autofix skipped: confidence below threshold"
    );
    return { skipped: true as const, reason: "confidence-below-threshold" };
  }

  // Skip if no suggested fix or it fails sanity check
  if (!suggestedFix || !isValidFileContent(suggestedFix, "Lint")) {
    log.warn(
      { findingId: finding.id },
      "Autofix skipped: suggestedFix empty or not valid file content"
    );
    return { skipped: true as const, reason: "no_valid_suggested_content" };
  }

  // ACT-13 dedup + ACT-12 rate limit apply to AUTO-created PRs only. A manual
  // fix (the user pressed "Implement fix") bypasses both — explicit re-requests
  // and repeated attempts are intentional, and the loop (Phase 6 step 2) relies
  // on being able to re-fix the same sha.
  if (!ctx.manual) {
    if (await isAutofixDeduped(db, installationId, repositoryId, detectorType, sha)) {
      log.info(
        { sha, detectorType },
        "Autofix PR already exists for this SHA — skipping"
      );
      return { skipped: true as const, reason: "deduped" };
    }
    if (await isRateLimited(db, installationId, repositoryId, config.autofixRateLimit)) {
      log.warn({ repositoryId }, "Autofix rate limit reached — skipping");
      return { skipped: true as const, reason: "rate_limited" };
    }
  }

  // Determine affected file path — use first affectedFile
  const filePath = affectedFiles[0];
  if (!filePath) {
    log.warn({ findingId: finding.id }, "Autofix skipped: no affectedFiles");
    return { skipped: true as const, reason: "no_affected_files" };
  }

  const fixOpts = {
    filePath,
    content: suggestedFix,
    commitMessage: `fix(lint): auto-fix ESLint violations [cyclops]\n\nFinding: ${finding.id}`,
    branchPrefix: "lint" as const,
    prTitle: `fix(lint): auto-fix ESLint violations on ${sha.slice(0, 7)} [cyclops]`,
    prBody: [
      "Automated lint fix by cyclops[bot].",
      "",
      `**Finding:** ${finding.id}`,
      `**Confidence:** ${finding.confidence}`,
      `**Affected file:** \`${filePath}\``,
      "",
      "> No auto-merge — please review before merging.",
    ].join("\n"),
  };

  // Loop iteration (Phase 6 step 2) vs one-shot (step 1 / auto pipeline)
  if (ctx.loopSession) {
    return applyFixForSession(ctx, ctx.loopSession, fixOpts);
  }
  return commitFix(ctx, fixOpts);
}

// ---------------------------------------------------------------------------
// handleAutofixSnapshot — ACT-06: same Git Data API chain with stricter
// sanity check for snapshot content
// ---------------------------------------------------------------------------
export async function handleAutofixSnapshot(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { db, finding, config, log } = ctx;
  const { installationId, repositoryId, detectorType, sha, suggestedFix, affectedFiles } =
    finding;

  // ACT-06: confidence guard
  if (!finding.confidence || finding.confidence < config.confidenceThreshold) {
    log.info(
      { confidence: finding.confidence },
      "Snapshot autofix skipped: confidence below threshold"
    );
    return { skipped: true as const, reason: "confidence-below-threshold" };
  }

  // Snapshot autofix has stricter feasibility: require exports[ or // Jest snapshot format
  if (!suggestedFix || !isValidFileContent(suggestedFix, "Snapshot")) {
    log.warn(
      { findingId: finding.id },
      "Snapshot autofix skipped: no recognizable snapshot content in suggestedFix"
    );
    return { skipped: true as const, reason: "no_valid_snapshot_content" };
  }

  // dedup + rate limit apply to AUTO-created PRs only — manual fixes bypass both
  // (see handleAutofixLint for the rationale).
  if (!ctx.manual) {
    if (await isAutofixDeduped(db, installationId, repositoryId, detectorType, sha)) {
      log.info(
        { sha, detectorType },
        "Autofix snapshot PR already exists — skipping"
      );
      return { skipped: true as const, reason: "deduped" };
    }
    if (await isRateLimited(db, installationId, repositoryId, config.autofixRateLimit)) {
      log.warn(
        { repositoryId },
        "Autofix rate limit reached — skipping snapshot autofix"
      );
      return { skipped: true as const, reason: "rate_limited" };
    }
  }

  const filePath = affectedFiles[0];
  if (!filePath) {
    return { skipped: true as const, reason: "no_affected_files" };
  }

  const fixOpts = {
    filePath,
    content: suggestedFix,
    commitMessage: `test(snapshot): regenerate snapshots [cyclops]\n\nFinding: ${finding.id}`,
    branchPrefix: "snapshot" as const,
    prTitle: `test(snapshot): regenerate snapshots on ${sha.slice(0, 7)} [cyclops]`,
    prBody: [
      "Automated snapshot update by cyclops[bot].",
      "",
      `**Finding:** ${finding.id}`,
      `**Affected file:** \`${filePath}\``,
      "",
      "> Review snapshot changes carefully before merging.",
    ].join("\n"),
  };

  if (ctx.loopSession) {
    return applyFixForSession(ctx, ctx.loopSession, fixOpts);
  }
  return commitFix(ctx, fixOpts);
}
