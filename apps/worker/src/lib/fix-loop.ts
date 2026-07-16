import { createHash } from "node:crypto";
import type { Finding, FixSession } from "@cyclops/db";

// ---------------------------------------------------------------------------
// Fix-loop orchestration (Phase 6 step 2).
//
// The loop turns a one-shot fix into "keep fixing until CI is green": cyclops
// commits a fix → CI runs → on green it stops, on red it feeds the NEW failure
// back through the pipeline and fixes again, until a stop condition trips.
//
// This module is intentionally queue-free — it holds the pure state helpers,
// signature logic, and GitHub comment I/O. The green/red/cap DECISIONS live in
// the workers (webhook-ingestion watches runs; action-execution applies fixes),
// which own the BullMQ queues.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_FIX_ITERATIONS = 5;

export type FixSessionStatus =
  | "running"
  | "succeeded"
  | "failed_max_iterations"
  | "failed_no_progress"
  | "failed_budget"
  | "error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Octokit = any;

export interface GitHubTarget {
  octokit: Octokit;
  db: Db;
  owner: string;
  repo: string;
}

// ---------------------------------------------------------------------------
// failureSignature — a stable fingerprint of a failure. Two consecutive
// iterations with the same signature means the fix isn't changing the failure
// (no progress). Prefer the structured violations; fall back to the raw log.
// ---------------------------------------------------------------------------
export function failureSignature(finding: Finding): string {
  const violations =
    (finding.violations as Array<{ path?: string; line?: number; message?: string }>) ?? [];
  const parts = violations
    .map((v) => `${v.path ?? ""}:${v.line ?? ""}:${v.message ?? ""}`)
    .sort();
  const basis = parts.length
    ? `${finding.detectorType}\n${parts.join("\n")}`
    : `${finding.detectorType}\n${(finding.rawExcerpt ?? "").slice(0, 2000)}`;
  return createHash("sha256").update(basis).digest("hex");
}

// ---------------------------------------------------------------------------
// Session lookups — a session is "active" while status === "running".
// ---------------------------------------------------------------------------
export async function findActiveSessionByBranch(
  db: Db,
  installationId: number,
  repositoryId: number,
  branch: string
): Promise<FixSession | null> {
  return db.fixSession.findFirst({
    where: { installationId, repositoryId, branchName: branch, status: "running" },
    orderBy: { createdAt: "desc" },
  });
}

export async function findActiveSessionByFinding(
  db: Db,
  installationId: number,
  findingId: string
): Promise<FixSession | null> {
  return db.fixSession.findFirst({
    where: { installationId, findingId, status: "running" },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// startFixSession — one row per "Implement fix" button press. branchName is
// where the loop commits: the PR's own head branch in autofix mode, a fresh
// cyclops/fix/* branch (derived from the finding id, so it's stable across
// iterations) in locked mode.
// ---------------------------------------------------------------------------
export async function startFixSession(
  db: Db,
  params: {
    installationId: number;
    repositoryId: number;
    finding: Finding;
    mode: "locked" | "autofix";
  }
): Promise<FixSession> {
  const { installationId, repositoryId, finding, mode } = params;
  const headBranch = (finding.ref ?? "main").replace(/^refs\/heads\//, "");
  const branchName =
    mode === "autofix" ? headBranch : `cyclops/fix/${finding.id.slice(0, 8)}`;
  return db.fixSession.create({
    data: {
      installationId,
      repositoryId,
      findingId: finding.id,
      detectorType: finding.detectorType,
      mode,
      branchName,
      baseBranch: headBranch,
      maxIterations: DEFAULT_MAX_FIX_ITERATIONS,
    },
  });
}

// setFixSessionStatus — flip status without touching GitHub. For callers with
// no octokit handy (e.g. the AI budget gate) that just need to close the loop.
export async function setFixSessionStatus(
  db: Db,
  sessionId: string,
  status: FixSessionStatus
): Promise<void> {
  await db.fixSession.update({ where: { id: sessionId }, data: { status } });
}

// resolveOpenPrForBranch — the open PR whose head is `branch` (same-repo), so
// autofix-mode loops (which commit to the PR's own head branch) know where to
// post their progress comment. Returns undefined if none / on error.
export async function resolveOpenPrForBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<number | undefined> {
  try {
    const resp = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "open",
      per_page: 1,
    });
    return resp.data[0]?.number as number | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// upsertLoopComment — maintain ONE comment on the PR that the loop updates in
// place as it progresses (no per-iteration spam). Stores the comment id on the
// session on first post. No-ops when there's no PR to comment on yet.
// ---------------------------------------------------------------------------
export async function upsertLoopComment(
  target: GitHubTarget,
  session: FixSession,
  body: string
): Promise<void> {
  if (!session.prNumber) return;
  const { octokit, db, owner, repo } = target;
  if (session.commentId) {
    await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      { owner, repo, comment_id: Number(session.commentId), body }
    );
    return;
  }
  const resp = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { owner, repo, issue_number: session.prNumber, body }
  );
  await db.fixSession.update({
    where: { id: session.id },
    data: { commentId: BigInt(resp.data.id) },
  });
}

// ---------------------------------------------------------------------------
// Comment bodies — a small consistent vocabulary for the loop's lifecycle.
// ---------------------------------------------------------------------------
// A runtime disclaimer shown while cyclops is committing straight to the user's
// branch (autofixMode: autofix). Reinforces the setup-time warning at the exact
// moment the "wild" behavior happens.
const AUTOFIX_MODE_BANNER =
  "> ⚠️ **Autofix mode** — cyclops is committing these fixes **directly to this " +
  "branch** (`autofixMode: autofix`). Switch to `locked` in `.cyclops.yml` to " +
  "get fixes on a separate review branch instead.";

function withModeBanner(mode: string, lines: string[]): string {
  const body = lines.join("\n");
  return mode === "autofix" ? `${AUTOFIX_MODE_BANNER}\n\n${body}` : body;
}

export function progressBody(
  mode: string,
  iteration: number,
  maxIterations: number
): string {
  return withModeBanner(mode, [
    "### 🔁 Cyclops automated fix in progress",
    "",
    `Attempt **${iteration} / ${maxIterations}** — pushed a fix and I'm watching CI.`,
    "",
    "_I'll update this comment when CI settles._",
  ]);
}

const TERMINAL_HEADLINE: Record<Exclude<FixSessionStatus, "running">, string> = {
  succeeded: "### ✅ Cyclops fixed it — CI is green",
  failed_max_iterations: "### ⛔ Cyclops stopped — max fix attempts reached",
  failed_no_progress: "### ⛔ Cyclops stopped — the same failure kept recurring",
  failed_budget: "### ⛔ Cyclops stopped — monthly AI token budget reached",
  error: "### ⚠️ Cyclops stopped — an error interrupted the fix loop",
};

export function terminalBody(
  status: Exclude<FixSessionStatus, "running">,
  session: FixSession,
  extra?: string
): string {
  const lines = [
    TERMINAL_HEADLINE[status],
    "",
    `Attempts used: **${session.iteration} / ${session.maxIterations}**`,
  ];
  if (extra) {
    lines.push("", extra);
  }
  // Keep the autofix disclaimer visible on the final comment too — except on a
  // clean success, where the outcome speaks for itself.
  return status === "succeeded"
    ? lines.join("\n")
    : withModeBanner(session.mode, lines);
}

// ---------------------------------------------------------------------------
// finalizeFixSession — flip the session to a terminal status and post the
// closing comment. Comment failures are swallowed so a GitHub hiccup can't
// leave the session stuck in "running".
// ---------------------------------------------------------------------------
export async function finalizeFixSession(
  target: GitHubTarget,
  session: FixSession,
  status: Exclude<FixSessionStatus, "running">,
  extra?: string
): Promise<void> {
  await target.db.fixSession.update({
    where: { id: session.id },
    data: { status },
  });
  try {
    await upsertLoopComment(target, session, terminalBody(status, session, extra));
  } catch {
    // best-effort — the session status is the source of truth
  }
}
