import { getDb } from "@cyclops/db";
import type { ActionContext } from "../workers/action-execution.js";
import { postSlackMessage } from "./slack-client.js";

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
// handleSlackAlert — ACT-09, ACT-11, SLK-01, SLK-02
// Primary path: bot token stored per-installation (encryptedSlackToken).
// Fallback: webhookUrl from config or SLACK_WEBHOOK_URL env.
// SLK-02: 3+ findings on same (installationId, repositoryId, detectorType, ref)
//         within 7 days triggers alert regardless of 24h dedup window.
// ---------------------------------------------------------------------------

export async function handleSlackAlert(
  ctx: ActionContext
): Promise<{ skipped: true; reason?: string } | { ok: true }> {
  const { db, finding, config, owner, repo } = ctx;
  const { installationId, repositoryId, detectorType, ref } = finding;
  const dedupeRef = ref || "unknown";

  // SLK-02: Count recent findings for this (installationId, repositoryId, detectorType, ref)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentCount = await db.finding.count({
    where: {
      installationId,
      repositoryId,
      detectorType,
      ref: dedupeRef,
      createdAt: { gte: sevenDaysAgo },
    },
  });
  const isRepeatFailure = recentCount >= 3;

  // Dedup check — skip only if NOT a repeat failure
  if (!isRepeatFailure) {
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
  }

  // Load installation to get encryptedSlackToken
  const globalDb = getDb();
  const installation = await globalDb.installation.findUnique({
    where: { id: installationId },
    select: { encryptedSlackToken: true },
  });

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const repeatLabel = isRepeatFailure ? " (repeat failure)" : "";
  const messageText =
    `*${detectorType} failure detected${repeatLabel}* in <${repoUrl}|${owner}/${repo}> on \`${ref || "unknown"}\``;
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Cyclops detected: ${detectorType} failure${repeatLabel}*\n` +
          `Repo: <${repoUrl}|${owner}/${repo}>\n` +
          `Branch: \`${ref || "unknown"}\`\n` +
          `Confidence: ${finding.confidence ?? "N/A"}\n` +
          (isRepeatFailure ? `Recent occurrences (7d): ${recentCount}\n` : "") +
          (finding.rootCause ? `Root cause: ${finding.rootCause.slice(0, 200)}` : ""),
      },
    },
  ];

  // Primary path: bot token
  if (installation?.encryptedSlackToken) {
    const channelConfig = config.notifications?.slack?.channel;
    if (!channelConfig) {
      ctx.log.warn(
        { installationId },
        "No Slack channel configured in .cyclops.yml — skipping bot-token alert"
      );
      return { skipped: true as const, reason: "no_channel_configured" };
    }

    const result = await postSlackMessage({
      encryptedToken: installation.encryptedSlackToken,
      channelIdOrName: channelConfig,
      text: messageText,
      blocks,
    });

    if (!result.ok) {
      ctx.log.warn({ reason: result.reason, detectorType }, "Slack bot-token alert failed");
      return { skipped: true as const, reason: `slack_failed:${result.reason}` };
    }
  } else {
    // Fallback: webhook URL
    const webhookUrl =
      config.notifications?.slack?.webhookUrl ?? process.env["SLACK_WEBHOOK_URL"];
    if (!webhookUrl) {
      ctx.log.warn({ detectorType }, "No Slack bot token or webhook URL configured — skipping alert");
      return { skipped: true as const, reason: "no_slack_config" };
    }

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: messageText, blocks }),
    });

    if (!resp.ok) {
      throw new Error(`Slack webhook returned ${resp.status}: ${await resp.text()}`);
    }
  }

  await recordActionDedup(
    db,
    installationId,
    repositoryId,
    detectorType,
    dedupeRef,
    "send-slack-alert"
  );
  ctx.log.info(
    { detectorType, isRepeatFailure, recentCount },
    "Slack alert sent"
  );
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
