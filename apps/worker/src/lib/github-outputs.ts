import type { ActionContext } from "../workers/action-execution.js";
import {
  IMPLEMENT_FIX_ACTION_ID,
  AGENT_FIX_SAFE_ACTION_ID,
  AGENT_FIX_ALLIN_ACTION_ID,
  isAutofixEligible,
  isAgentFixEligible,
} from "./github-autofix.js";
import { findActiveSessionByBranch } from "./fix-loop.js";

// ---------------------------------------------------------------------------
// getPrNumber — resolve the open PR number for a given commit SHA
// Returns undefined when no open PR is associated (ACT-02)
// ---------------------------------------------------------------------------
export async function getPrNumber(
  octokit: any,
  owner: string,
  repo: string,
  sha: string
): Promise<number | undefined> {
  try {
    const resp = await (octokit as any).request(
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
      { owner, repo, commit_sha: sha, per_page: 5 }
    );
    return (resp.data as Array<{ number: number }>)[0]?.number;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// renderPrCommentBody — markdown table of all findings for a workflow run
// ---------------------------------------------------------------------------
const SEVERITY_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

function renderFinding(f: {
  detectorType: string;
  confidence: number | null;
  severity: string | null;
  rootCause: string | null;
  suggestedFix: string | null;
  evidence: string[];
  affectedFiles: string[];
  autofixPrNumber?: number | null;
}): string {
  const confidence = f.confidence != null ? `${Math.round(f.confidence * 100)}%` : "—";
  const sev = (f.severity ?? "").toLowerCase();
  const sevBadge = sev ? `${SEVERITY_ICON[sev] ?? "⚪️"} ${sev}` : "";
  const parts: string[] = [];

  parts.push(`### ${f.detectorType}  ·  ${confidence} confidence${sevBadge ? `  ·  ${sevBadge}` : ""}`);
  parts.push("");
  if (f.rootCause) {
    parts.push(`**Root cause**`);
    parts.push(f.rootCause);
    parts.push("");
  }
  if (f.affectedFiles.length) {
    parts.push(`**Affected files:** ${f.affectedFiles.map((x) => `\`${x}\``).join(", ")}`);
    parts.push("");
  }
  if (f.evidence.length) {
    parts.push(`<details><summary><b>Evidence</b> (${f.evidence.length})</summary>`);
    parts.push("");
    parts.push("```");
    parts.push(f.evidence.slice(0, 20).join("\n"));
    parts.push("```");
    parts.push("</details>");
    parts.push("");
  }
  if (f.suggestedFix) {
    parts.push(`**Suggested fix**`);
    parts.push("");
    parts.push("```diff");
    parts.push(f.suggestedFix);
    parts.push("```");
    parts.push("");
  }
  if (f.autofixPrNumber) {
    parts.push(`✅ **Auto-fix opened:** #${f.autofixPrNumber}`);
    parts.push("");
  }
  return parts.join("\n");
}

function renderPrCommentBody(findings: Array<{
  detectorType: string;
  confidence: number | null;
  severity: string | null;
  rootCause: string | null;
  suggestedFix: string | null;
  evidence: string[];
  affectedFiles: string[];
  autofixPrNumber?: number | null;
}>): string {
  const sections = findings.map(renderFinding).join("\n---\n\n");
  return [
    "## 🔍 Cyclops CI Analysis",
    "",
    `Found **${findings.length}** issue${findings.length === 1 ? "" : "s"} in this run.`,
    "",
    sections,
    "---",
    "*Analysis by [cyclops[bot]](https://github.com/apps/cyclops-app). Confidence reflects how clearly the logs demonstrate the failure.*",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// handleUpsertPrComment — ACT-01, ACT-02, ACT-13
// ---------------------------------------------------------------------------
export async function handleUpsertPrComment(
  ctx: ActionContext
): Promise<{ skipped: true } | { ok: true }> {
  const { octokit, db, finding, owner, repo, log } = ctx;
  const { installationId, repositoryId, sha, workflowRunId } = finding;

  // ACT-02: skip if no PR is associated with this commit
  const prNumber = await getPrNumber(octokit, owner, repo, sha);
  if (!prNumber) {
    log.info({ sha }, "No PR associated with commit — skipping PR comment");
    return { skipped: true as const };
  }

  // Load all findings for this workflow run (consolidated body — ACT-01)
  const allFindings = await db.finding.findMany({
    where: { installationId, workflowRunId, deletedAt: null },
  });

  const body = renderPrCommentBody(allFindings);

  // ACT-13: check DB before creating — never list GitHub comments
  const existing = await db.prComment.findUnique({
    where: {
      installationId_repositoryId_prNumber: {
        installationId,
        repositoryId,
        prNumber,
      },
    },
  });

  if (existing) {
    // ACT-01: PATCH existing comment
    await (octokit as any).request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      { owner, repo, comment_id: existing.githubCommentId, body }
    );
    log.info(
      { prNumber, commentId: existing.githubCommentId },
      "PR comment updated"
    );
  } else {
    // ACT-01: POST new comment and persist PrComment row
    const resp = await (octokit as any).request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: prNumber, body }
    );
    await db.prComment.create({
      data: {
        installationId,
        repositoryId,
        prNumber,
        githubCommentId: BigInt(resp.data.id),
      },
    });
    log.info({ prNumber, commentId: resp.data.id }, "PR comment created");
  }

  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// renderCheckRunSummary — markdown summary for a single finding
// ---------------------------------------------------------------------------
function renderCheckRunSummary(finding: {
  detectorType: string;
  confidence: number | null;
  rootCause: string | null;
  evidence: string[];
}): string {
  const confidence =
    finding.confidence != null
      ? `${Math.round(finding.confidence * 100)}%`
      : "unknown";
  const evidenceList =
    finding.evidence.length > 0
      ? finding.evidence.map((e) => `- ${e}`).join("\n")
      : "- No evidence collected";

  return [
    `**Detector:** ${finding.detectorType}`,
    `**Confidence:** ${confidence}`,
    `**Root Cause:** ${finding.rootCause ?? "Not determined"}`,
    "",
    "**Evidence:**",
    evidenceList,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// handleUpdateCheckRun — ACT-03, ACT-04, ACT-13
// ---------------------------------------------------------------------------
const ANNOTATION_BATCH_SIZE = 50;
const CHECK_RUN_NAME = "Cyclops CI Analysis";

export async function handleUpdateCheckRun(
  ctx: ActionContext
): Promise<{ ok: true }> {
  const { octokit, db, finding, owner, repo, log, config } = ctx;
  const { sha } = finding;

  // ACT-13: reuse existing check run id if already persisted
  let checkRunId = finding.cyclopsCheckRunId
    ? Number(finding.cyclopsCheckRunId)
    : null;

  if (!checkRunId) {
    // ACT-03: create check run with status in_progress
    const createResp = await (octokit as any).request(
      "POST /repos/{owner}/{repo}/check-runs",
      {
        owner,
        repo,
        name: CHECK_RUN_NAME,
        head_sha: sha,
        status: "in_progress",
        started_at: new Date().toISOString(),
      }
    );
    checkRunId = createResp.data.id as number;

    // ACT-03: persist cyclopsCheckRunId to DB
    await db.finding.update({
      where: { id: finding.id },
      data: { cyclopsCheckRunId: BigInt(checkRunId) },
    });
    log.info({ checkRunId }, "Check run created");
  }

  // Build annotations from violations
  const violations =
    (finding.violations as Array<{
      path?: string;
      line?: number;
      message?: string;
    }>) ?? [];

  const annotations = violations
    .filter((v) => v.path && v.message)
    .map((v) => ({
      path: v.path!,
      start_line: v.line ?? 1,
      end_line: v.line ?? 1,
      annotation_level: "failure" as const,
      message: v.message!,
    }));

  const summary = renderCheckRunSummary(finding);
  const conclusion =
    finding.confidence != null &&
    finding.confidence >= config.confidenceThreshold
      ? "failure"
      : "neutral";

  // "Implement fix" button — rendered on the completed check run when the
  // finding carries a usable fix. Pressing it fires a `check_run`
  // `requested_action` webhook (identifier = IMPLEMENT_FIX_ACTION_ID), which
  // webhook-ingestion turns into a manual autofix action. GitHub caps the
  // actions array at 3 and each field's length (label ≤ 20, description ≤ 40,
  // identifier ≤ 20) — keep the strings short.
  // Suppress the button while a fix loop is already running on this branch —
  // the per-iteration check runs would otherwise each offer a duplicate
  // loop-start button (Phase 6 step 2).
  const loopActive =
    (await findActiveSessionByBranch(
      db,
      finding.installationId,
      finding.repositoryId,
      finding.ref
    )) !== null;
  // Which button to render is gated by autofix.mode (Phase 7):
  //   agent + all-in → "Agent fix (all-in)" — autonomous loop on THIS branch
  //   agent + safe   → "Agent fix (safe)"   — autonomous loop on a fix branch + PR
  //   suggest        → "Implement fix"      — one-shot suggestedFix (Phase 6 path)
  //   off            → no button
  // GitHub caps: label ≤ 20, description ≤ 40, identifier ≤ 20.
  let actions: { label: string; description: string; identifier: string }[] = [];
  if (!loopActive) {
    if (config.autofix.mode === "agent" && isAgentFixEligible(finding, config)) {
      actions =
        config.autofix.agent.permission === "all-in"
          ? [
              {
                label: "Agent fix (all-in)",
                description: "Loops on this branch until CI is green",
                identifier: AGENT_FIX_ALLIN_ACTION_ID,
              },
            ]
          : [
              {
                label: "Agent fix (safe)",
                description: "Loop on a fix branch until CI is green",
                identifier: AGENT_FIX_SAFE_ACTION_ID,
              },
            ];
    } else if (config.autofix.mode === "suggest" && isAutofixEligible(finding, config)) {
      actions = [
        {
          label: "Implement fix",
          description: "Open a PR with cyclops's fix",
          identifier: IMPLEMENT_FIX_ACTION_ID,
        },
      ];
    }
  }

  log.info(
    {
      findingId: finding.id,
      detectorType: finding.detectorType,
      confidence: finding.confidence,
      threshold: config.confidenceThreshold,
      autofixMode: (config as { autofix?: { mode?: string } }).autofix?.mode,
      permission: (config as { autofix?: { agent?: { permission?: string } } }).autofix?.agent
        ?.permission,
      loopActive,
      agentEligible: isAgentFixEligible(finding, config),
      actions: actions.map((a) => a.identifier),
    },
    "check-run button decision"
  );

  if (annotations.length === 0) {
    // Complete with no annotations
    await (octokit as any).request(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      {
        owner,
        repo,
        check_run_id: checkRunId,
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: { title: "Cyclops Analysis", summary, annotations: [] },
        ...(actions.length ? { actions } : {}),
      }
    );
  } else {
    // ACT-04: batch annotations 50 per PATCH call
    for (let i = 0; i < annotations.length; i += ANNOTATION_BATCH_SIZE) {
      const batch = annotations.slice(i, i + ANNOTATION_BATCH_SIZE);
      const isLast = i + ANNOTATION_BATCH_SIZE >= annotations.length;
      await (octokit as any).request(
        "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
        {
          owner,
          repo,
          check_run_id: checkRunId,
          output: { title: "Cyclops Analysis", summary, annotations: batch },
          ...(isLast
            ? {
                status: "completed",
                conclusion,
                completed_at: new Date().toISOString(),
                ...(actions.length ? { actions } : {}),
              }
            : {}),
        }
      );
    }
  }

  log.info(
    { checkRunId, annotationCount: annotations.length, conclusion },
    "Check run completed"
  );

  return { ok: true as const };
}
