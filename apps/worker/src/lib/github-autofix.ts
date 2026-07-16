import type { ActionType } from "@cyclops/queue";
import type { CyclopsConfig } from "@cyclops/config";
import type { Finding } from "@cyclops/db";
import type { ActionContext } from "../workers/action-execution.js";

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

  // Step 1: current commit → base tree SHA
  const commitResp = await (octokit as any).request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner, repo, commit_sha: sha }
  );
  const baseTreeSha: string = commitResp.data.tree.sha;

  // Step 2: new tree with the fixed file content (path in body — never URL-encoded)
  const treeResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: [{ path: opts.filePath, mode: "100644", type: "blob", content: opts.content }],
    }
  );

  // Step 3: commit (parent = the failing sha = current branch head)
  const newCommitResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/commits",
    {
      owner,
      repo,
      message: opts.commitMessage,
      tree: treeResp.data.sha,
      parents: [sha],
    }
  );
  const newCommitSha: string = newCommitResp.data.sha;

  const headBranch = (ref ?? "main").replace(/^refs\/heads\//, "");

  if (config.autofixMode === "autofix") {
    // Commit DIRECTLY to the PR's own head branch. `{+ref}` keeps the slash in
    // heads/<branch> unencoded; force:false so a non-fast-forward errors out
    // rather than overwriting commits pushed after the failing sha.
    await (octokit as any).request(
      "PATCH /repos/{owner}/{repo}/git/refs/{+ref}",
      { owner, repo, ref: `heads/${headBranch}`, sha: newCommitSha, force: false }
    );
    log.info(
      { headBranch, newCommitSha, findingId: finding.id },
      "Autofix committed directly to head branch (autofix mode)"
    );
    return { ok: true as const };
  }

  // locked mode: new branch + review PR
  const branchName = `cyclops/autofix/${opts.branchPrefix}/${sha.slice(0, 7)}-${Date.now()}`;
  await (octokit as any).request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: newCommitSha,
  });
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

  return commitFix(ctx, {
    filePath,
    content: suggestedFix,
    commitMessage: `fix(lint): auto-fix ESLint violations [cyclops]\n\nFinding: ${finding.id}`,
    branchPrefix: "lint",
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
  });
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

  return commitFix(ctx, {
    filePath,
    content: suggestedFix,
    commitMessage: `test(snapshot): regenerate snapshots [cyclops]\n\nFinding: ${finding.id}`,
    branchPrefix: "snapshot",
    prTitle: `test(snapshot): regenerate snapshots on ${sha.slice(0, 7)} [cyclops]`,
    prBody: [
      "Automated snapshot update by cyclops[bot].",
      "",
      `**Finding:** ${finding.id}`,
      `**Affected file:** \`${filePath}\``,
      "",
      "> Review snapshot changes carefully before merging.",
    ].join("\n"),
  });
}
