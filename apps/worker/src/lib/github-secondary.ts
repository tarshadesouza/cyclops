import type { ActionContext } from "../workers/action-execution.js";

// ---------------------------------------------------------------------------
// ActionDedup helpers — 24-hour deduplication window (ACT-11)
// ---------------------------------------------------------------------------

export async function checkActionDedup(
  db: ActionContext["db"],
  installationId: number,
  repositoryId: number,
  detectorType: string,
  ref: string,
  actionType: string
): Promise<boolean> {
  const existing = await db.actionDedup.findFirst({
    where: {
      installationId,
      repositoryId,
      detectorType,
      ref,
      actionType,
      expiresAt: { gt: new Date() },
    },
  });
  return !!existing;
}

export async function recordActionDedup(
  db: ActionContext["db"],
  installationId: number,
  repositoryId: number,
  detectorType: string,
  ref: string,
  actionType: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await db.actionDedup.upsert({
    where: {
      installationId_repositoryId_detectorType_ref_actionType: {
        installationId,
        repositoryId,
        detectorType,
        ref,
        actionType,
      },
    },
    create: { installationId, repositoryId, detectorType, ref, actionType, expiresAt },
    update: { expiresAt },
  });
}

// ---------------------------------------------------------------------------
// handleRerunWorkflow — ACT-07, ACT-11, ACT-13
// Triggers a workflow rerun for FlakyTest findings.
// ---------------------------------------------------------------------------

export async function handleRerunWorkflow(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { octokit, db, finding, owner, repo } = ctx;
  const { installationId, repositoryId, detectorType, ref, workflowRunId } = finding;
  const dedupeRef = ref || "unknown";

  if (
    await checkActionDedup(
      db,
      installationId,
      repositoryId,
      detectorType,
      dedupeRef,
      "rerun-workflow"
    )
  ) {
    ctx.log.info({ workflowRunId }, "Rerun already performed within 24h — skipping");
    return { skipped: true as const, reason: "deduped" };
  }

  await (octokit as any).request(
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
    { owner, repo, run_id: workflowRunId }
  );

  await recordActionDedup(
    db,
    installationId,
    repositoryId,
    detectorType,
    dedupeRef,
    "rerun-workflow"
  );
  ctx.log.info({ workflowRunId }, "Workflow rerun triggered");
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// handleCancelWorkflow — ACT-08, ACT-11
// Cancels a hanging workflow. 409 = already completed = treat as success.
// ---------------------------------------------------------------------------

export async function handleCancelWorkflow(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { octokit, db, finding, owner, repo } = ctx;
  const { installationId, repositoryId, detectorType, ref, workflowRunId } = finding;
  const dedupeRef = ref || "unknown";

  if (
    await checkActionDedup(
      db,
      installationId,
      repositoryId,
      detectorType,
      dedupeRef,
      "cancel-workflow"
    )
  ) {
    ctx.log.info({ workflowRunId }, "Cancel already performed within 24h — skipping");
    return { skipped: true as const, reason: "deduped" };
  }

  try {
    await (octokit as any).request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
      { owner, repo, run_id: workflowRunId }
    );
  } catch (err: any) {
    // 409 Conflict = run already completed; treat as success (Pitfall 5 from research)
    if (err?.status === 409 || err?.response?.status === 409) {
      ctx.log.info(
        { workflowRunId },
        "Workflow already completed — cancel treated as success"
      );
    } else {
      throw err;
    }
  }

  await recordActionDedup(
    db,
    installationId,
    repositoryId,
    detectorType,
    dedupeRef,
    "cancel-workflow"
  );
  ctx.log.info({ workflowRunId }, "Workflow cancel complete");
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// handleSlackAlert — ACT-09, ACT-11
// Sends a Slack alert via native fetch() (Node 22 built-in — no Slack SDK).
// Webhook URL from config.notifications.slack.webhookUrl or SLACK_WEBHOOK_URL env.
// Skips gracefully when no URL is configured.
// ---------------------------------------------------------------------------

export async function handleSlackAlert(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { db, finding, config, owner, repo } = ctx;
  const { installationId, repositoryId, detectorType, ref } = finding;
  const dedupeRef = ref || "unknown";

  if (
    await checkActionDedup(
      db,
      installationId,
      repositoryId,
      detectorType,
      dedupeRef,
      "send-slack-alert"
    )
  ) {
    ctx.log.info({ detectorType }, "Slack alert already sent within 24h — skipping");
    return { skipped: true as const, reason: "deduped" };
  }

  const webhookUrl =
    config.notifications?.slack?.webhookUrl ?? process.env["SLACK_WEBHOOK_URL"];
  if (!webhookUrl) {
    ctx.log.warn({ detectorType }, "No Slack webhook URL configured — skipping alert");
    return { skipped: true as const, reason: "no_webhook_url" };
  }

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const message = {
    text: `*${detectorType} failure detected* in <${repoUrl}|${owner}/${repo}> on \`${ref || "unknown"}\``,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Cyclops detected: ${detectorType} failure*\n` +
            `Repo: <${repoUrl}|${owner}/${repo}>\n` +
            `Branch: \`${ref || "unknown"}\`\n` +
            `Confidence: ${finding.confidence ?? "N/A"}\n` +
            (finding.rootCause ? `Root cause: ${finding.rootCause.slice(0, 200)}` : ""),
        },
      },
    ],
  };

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!resp.ok) {
    throw new Error(`Slack webhook returned ${resp.status}: ${await resp.text()}`);
  }

  await recordActionDedup(
    db,
    installationId,
    repositoryId,
    detectorType,
    dedupeRef,
    "send-slack-alert"
  );
  ctx.log.info({ detectorType }, "Slack alert sent");
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// handleCreateGithubIssue — ACT-10, ACT-11, ACT-13
// Creates a GitHub Issue on first failure; adds a comment on repeat.
// Dedup via TrackedIssue table (not ActionDedup).
// ---------------------------------------------------------------------------

export async function handleCreateGithubIssue(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { octokit, db, finding, owner, repo } = ctx;
  const { installationId, repositoryId, detectorType, ref } = finding;
  const issueRef = ref || "unknown";

  // Check TrackedIssue table for existing issue on this (installationId, repositoryId, detectorType, ref)
  const existing = await db.trackedIssue.findUnique({
    where: {
      installationId_repositoryId_detectorType_ref: {
        installationId,
        repositoryId,
        detectorType,
        ref: issueRef,
      },
    },
  });

  if (existing) {
    // Add comment to existing issue (repeat failure evidence — not a new issue)
    await (octokit as any).request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: existing.githubIssueNumber,
        body:
          `**Repeat failure detected** — ${new Date().toISOString()}\n\n` +
          `Finding ID: ${finding.id}\n` +
          `Confidence: ${finding.confidence ?? "N/A"}\n` +
          (finding.rootCause ? `Root cause: ${finding.rootCause.slice(0, 500)}` : ""),
      }
    );
    ctx.log.info(
      { issueNumber: existing.githubIssueNumber },
      "Added comment to existing tracked issue"
    );
    return { ok: true as const };
  }

  // Create new issue
  const issueTitle = `[Cyclops] ${detectorType} failure on \`${issueRef}\``;
  const issueBody = [
    `## ${detectorType} failure detected by Cyclops`,
    "",
    `**Repository:** ${owner}/${repo}`,
    `**Branch:** \`${issueRef}\``,
    `**Commit SHA:** \`${finding.sha}\``,
    `**Confidence:** ${finding.confidence ?? "N/A"}`,
    "",
    finding.rootCause ? `### Root Cause\n${finding.rootCause}` : "",
    finding.suggestedFix
      ? `### Suggested Fix\n${finding.suggestedFix.slice(0, 1000)}`
      : "",
    "",
    "_Tracked by [cyclops[bot]](https://github.com/apps/cyclops)_",
  ]
    .filter(Boolean)
    .join("\n");

  const issueResp = await (octokit as any).request(
    "POST /repos/{owner}/{repo}/issues",
    {
      owner,
      repo,
      title: issueTitle,
      body: issueBody,
      labels: ["cyclops", "ci-failure"],
    }
  );

  await db.trackedIssue.create({
    data: {
      installationId,
      repositoryId,
      detectorType,
      ref: issueRef,
      githubIssueNumber: issueResp.data.number,
    },
  });

  ctx.log.info({ issueNumber: issueResp.data.number }, "GitHub issue created for tracked failure");
  return { ok: true as const };
}
