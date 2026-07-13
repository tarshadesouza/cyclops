import type { ActionContext } from "../workers/action-execution.js";

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
// handleAutofixLint — ACT-05: Git Data API 5-step chain for lint fixes
// ---------------------------------------------------------------------------
export async function handleAutofixLint(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { octokit, db, finding, owner, repo, config, log } = ctx;
  const { installationId, repositoryId, detectorType, sha, ref, suggestedFix, affectedFiles } =
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

  // ACT-13: dedup check before branch creation
  if (await isAutofixDeduped(db, installationId, repositoryId, detectorType, sha)) {
    log.info(
      { sha, detectorType },
      "Autofix PR already exists for this SHA — skipping"
    );
    return { skipped: true as const, reason: "deduped" };
  }

  // ACT-12: rate limit check
  if (await isRateLimited(db, installationId, repositoryId, config.autofixRateLimit)) {
    log.warn({ repositoryId }, "Autofix rate limit reached — skipping");
    return { skipped: true as const, reason: "rate_limited" };
  }

  // Determine affected file path — use first affectedFile
  const filePath = affectedFiles[0];
  if (!filePath) {
    log.warn({ findingId: finding.id }, "Autofix skipped: no affectedFiles");
    return { skipped: true as const, reason: "no_affected_files" };
  }

  // Step 1: Get current commit to find tree SHA
  const commitResp = await (octokit as any).request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner, repo, commit_sha: sha }
  );
  const baseTreeSha: string = commitResp.data.tree.sha;

  // Step 2: Create new tree with fixed content (inline — no separate blob call needed)
  const treeResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: [{ path: filePath, mode: "100644", type: "blob", content: suggestedFix }],
    }
  );

  // Step 3: Create commit
  const newCommitResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/commits",
    {
      owner,
      repo,
      message: `fix(lint): auto-fix ESLint violations [cyclops]\n\nFinding: ${finding.id}`,
      tree: treeResp.data.sha,
      parents: [sha],
    }
  );

  // Step 4: Create branch ref — pattern: cyclops/autofix/lint/{sha7}-{epochMs}
  const branchName = `cyclops/autofix/lint/${sha.slice(0, 7)}-${Date.now()}`;
  await (octokit as any).request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: newCommitResp.data.sha,
  });

  // Step 5: Create PR — target the source branch (strip refs/heads/ prefix if present)
  const targetBranch = (ref ?? "main").replace(/^refs\/heads\//, "");
  const prResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/pulls",
    {
      owner,
      repo,
      title: `fix(lint): auto-fix ESLint violations on ${sha.slice(0, 7)} [cyclops]`,
      body: [
        "Automated lint fix by cyclops[bot].",
        "",
        `**Finding:** ${finding.id}`,
        `**Confidence:** ${finding.confidence}`,
        `**Affected file:** \`${filePath}\``,
        "",
        "> No auto-merge — please review before merging.",
      ].join("\n"),
      head: branchName,
      base: targetBranch,
      draft: false,
    }
  );

  // Store in AutofixPr table (ACT-13 dedup source)
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
    "Autofix lint PR created"
  );
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// handleAutofixSnapshot — ACT-06: same Git Data API chain with stricter
// sanity check for snapshot content
// ---------------------------------------------------------------------------
export async function handleAutofixSnapshot(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { octokit, db, finding, owner, repo, config, log } = ctx;
  const { installationId, repositoryId, detectorType, sha, ref, suggestedFix, affectedFiles } =
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

  // ACT-13: dedup check before branch creation
  if (await isAutofixDeduped(db, installationId, repositoryId, detectorType, sha)) {
    log.info(
      { sha, detectorType },
      "Autofix snapshot PR already exists — skipping"
    );
    return { skipped: true as const, reason: "deduped" };
  }

  // ACT-12: rate limit check
  if (await isRateLimited(db, installationId, repositoryId, config.autofixRateLimit)) {
    log.warn(
      { repositoryId },
      "Autofix rate limit reached — skipping snapshot autofix"
    );
    return { skipped: true as const, reason: "rate_limited" };
  }

  const filePath = affectedFiles[0];
  if (!filePath) {
    return { skipped: true as const, reason: "no_affected_files" };
  }

  // Step 1: Get current commit to find tree SHA
  const commitResp = await (octokit as any).request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner, repo, commit_sha: sha }
  );

  // Step 2: Create new tree with snapshot content
  const treeResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      owner,
      repo,
      base_tree: commitResp.data.tree.sha,
      tree: [{ path: filePath, mode: "100644", type: "blob", content: suggestedFix }],
    }
  );

  // Step 3: Create commit
  const newCommitResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/git/commits",
    {
      owner,
      repo,
      message: `test(snapshot): regenerate snapshots [cyclops]\n\nFinding: ${finding.id}`,
      tree: treeResp.data.sha,
      parents: [sha],
    }
  );

  // Step 4: Create branch ref — pattern: cyclops/autofix/snapshot/{sha7}-{epochMs}
  const branchName = `cyclops/autofix/snapshot/${sha.slice(0, 7)}-${Date.now()}`;
  await (octokit as any).request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: newCommitResp.data.sha,
  });

  // Step 5: Create PR
  const targetBranch = (ref ?? "main").replace(/^refs\/heads\//, "");
  const prResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/pulls",
    {
      owner,
      repo,
      title: `test(snapshot): regenerate snapshots on ${sha.slice(0, 7)} [cyclops]`,
      body: [
        "Automated snapshot update by cyclops[bot].",
        "",
        `**Finding:** ${finding.id}`,
        `**Affected file:** \`${filePath}\``,
        "",
        "> Review snapshot changes carefully before merging.",
      ].join("\n"),
      head: branchName,
      base: targetBranch,
      draft: false,
    }
  );

  // Store in AutofixPr table (ACT-13 dedup source)
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
    "Autofix snapshot PR created"
  );
  return { ok: true as const };
}
