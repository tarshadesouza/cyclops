import type { Finding, FixSession } from "@cyclops/db";
import type { CyclopsConfig } from "@cyclops/config";
import {
  finalizeFixSession,
  upsertLoopComment,
  progressBody,
  startingBody,
  resolveOpenPrForBranch,
  type GitHubTarget,
} from "./fix-loop.js";
import { fetchFailedJobs, fetchJobLogExcerpt } from "./github-actions.js";

// ---------------------------------------------------------------------------
// Phase 7 agent fix loop — the OUTER loop that turns the agent sandbox into a
// one-click "fix until CI is green" feature.
//
// One call = one whole fix session (a long-running job). Per iteration it:
//   1. repository_dispatch → the client's cyclops-agent stub → reusable agent.yml
//   2. poll the sandbox run to completion
//   3. read the throwaway ref refs/cyclops/session-<id> the agent pushed
//   4. promote that SHA onto the target branch via an installation-token ref
//      update (THIS push fires the client's real CI — the sandbox's own push
//      with the ambient GITHUB_TOKEN deliberately does not)
//   5. poll the REAL CI for that SHA — green → done; red → feed the fresh
//      failure back and re-dispatch, up to maxIterations
//
// The GitHub choreography here is deliberately free of BullMQ/DB-schema
// coupling so it can be exercised directly against a test repo.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Octokit = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Logger = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

const AGENT_WORKFLOW_FILE = "cyclops-agent.yml";
const DISPATCH_EVENT_TYPE = "cyclops-agent";

export interface AgentLoopTimings {
  pollIntervalMs: number;
  sandboxTimeoutMs: number;
  ciTimeoutMs: number;
  runAppearTimeoutMs: number;
  agentMaxTurns: number;
}

export const DEFAULT_TIMINGS: AgentLoopTimings = {
  pollIntervalMs: 10_000,
  sandboxTimeoutMs: 15 * 60_000,
  ciTimeoutMs: 15 * 60_000,
  runAppearTimeoutMs: 60_000,
  agentMaxTurns: 30,
};

export interface AgentLoopDeps {
  octokit: Octokit;
  db: Db;
  owner: string;
  repo: string;
  installationId: number;
  repositoryId: number;
  log: Logger;
  timings?: Partial<AgentLoopTimings>;
  // injectable for tests — defaults to real setTimeout
  sleep?: (ms: number) => Promise<void>;
  // injectable clock for tests — defaults to Date.now
  now?: () => number;
}

interface Seed {
  detector: string;
  summary: string;
  affectedFiles: string[];
  failedRunId?: number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// level string carried in the dispatch payload = the session mode for agent
// sessions ("agent-safe" | "agent-all-in").
function levelFor(session: FixSession): "agent-safe" | "agent-all-in" {
  return session.mode === "agent-all-in" ? "agent-all-in" : "agent-safe";
}

function seedFromFinding(finding: Finding): Seed {
  const violations =
    (finding.violations as Array<{ message?: string; path?: string }> | null) ?? [];
  const first = violations[0]?.message;
  const summary = first
    ? `${finding.detectorType} check failing: ${first}`
    : `${finding.detectorType} check is failing on this branch.`;
  return {
    detector: finding.detectorType,
    summary,
    affectedFiles: (finding.affectedFiles as string[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// GitHub choreography helpers (each a thin octokit.request wrapper).
// ---------------------------------------------------------------------------
async function dispatchAgent(
  deps: AgentLoopDeps,
  session: FixSession,
  seed: Seed,
  caps: Record<string, unknown>
): Promise<void> {
  await deps.octokit.request("POST /repos/{owner}/{repo}/dispatches", {
    owner: deps.owner,
    repo: deps.repo,
    event_type: DISPATCH_EVENT_TYPE,
    client_payload: {
      session_id: session.id,
      installation_id: deps.installationId,
      pr_number: session.prNumber ?? 0,
      // The agent checks out the branch that holds the FAILING code (the PR
      // head = baseBranch). Promotion decides where the fix lands.
      target_ref: session.baseBranch,
      level: levelFor(session),
      failed_run_id: seed.failedRunId ?? 0,
      seed: {
        detector: seed.detector,
        summary: seed.summary,
        affected_files: seed.affectedFiles,
      },
      caps,
    },
  });
}

// Find the sandbox run this dispatch produced: the newest repository_dispatch
// run of cyclops-agent.yml created at/after we dispatched (small skew allowed).
async function findSandboxRun(deps: AgentLoopDeps, sinceMs: number): Promise<number | null> {
  const resp = await deps.octokit.request(
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
    {
      owner: deps.owner,
      repo: deps.repo,
      workflow_id: AGENT_WORKFLOW_FILE,
      event: "repository_dispatch",
      per_page: 10,
    }
  );
  const runs = (resp.data.workflow_runs ?? []) as Array<{ id: number; created_at: string }>;
  for (const r of runs) {
    if (new Date(r.created_at).getTime() >= sinceMs - 10_000) return r.id;
  }
  return null;
}

type RunOutcome = "success" | "failure" | "timeout" | "other";

async function getRunStatus(
  deps: AgentLoopDeps,
  runId: number
): Promise<{ status: string; conclusion: string | null }> {
  const r = await deps.octokit.request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
    { owner: deps.owner, repo: deps.repo, run_id: runId }
  );
  return { status: r.data.status, conclusion: r.data.conclusion };
}

async function waitForRun(
  deps: AgentLoopDeps,
  runId: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<RunOutcome> {
  const start = now();
  const interval = deps.timings?.pollIntervalMs ?? DEFAULT_TIMINGS.pollIntervalMs;
  while (now() - start < timeoutMs) {
    const { status, conclusion } = await getRunStatus(deps, runId);
    if (status === "completed") {
      if (conclusion === "success") return "success";
      if (conclusion === "failure") return "failure";
      return "other";
    }
    await sleep(interval);
  }
  return "timeout";
}

// Read the throwaway session ref the agent pushed. Returns null if absent (404).
async function readSessionRef(deps: AgentLoopDeps, sessionId: string): Promise<string | null> {
  try {
    const r = await deps.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: deps.owner,
      repo: deps.repo,
      ref: `cyclops/session-${sessionId}`,
    });
    return r.data.object.sha as string;
  } catch (err: unknown) {
    if (isStatus(err, 404)) return null;
    throw err;
  }
}

async function getBranchHead(deps: AgentLoopDeps, branch: string): Promise<string | null> {
  try {
    const r = await deps.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: deps.owner,
      repo: deps.repo,
      ref: `heads/${branch}`,
    });
    return r.data.object.sha as string;
  } catch (err: unknown) {
    if (isStatus(err, 404)) return null;
    throw err;
  }
}

// Move (or create) refs/heads/<branch> to <sha>. This installation-token push
// is what fires the client's CI. {+ref} keeps the slash in heads/<branch>.
async function promoteToBranch(deps: AgentLoopDeps, branch: string, sha: string): Promise<void> {
  const exists = (await getBranchHead(deps, branch)) !== null;
  if (exists) {
    await deps.octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{+ref}", {
      owner: deps.owner,
      repo: deps.repo,
      ref: `heads/${branch}`,
      sha,
      force: true,
    });
  } else {
    await deps.octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: deps.owner,
      repo: deps.repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }
}

// Poll the REAL CI for a promoted SHA. Considers every workflow run for that
// SHA EXCEPT our own agent workflow; green only when all such runs succeed.
async function waitForRealCi(
  deps: AgentLoopDeps,
  sha: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<{ outcome: RunOutcome; failedRunId?: number }> {
  const start = now();
  const interval = deps.timings?.pollIntervalMs ?? DEFAULT_TIMINGS.pollIntervalMs;
  while (now() - start < timeoutMs) {
    const resp = await deps.octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
      owner: deps.owner,
      repo: deps.repo,
      head_sha: sha,
      per_page: 20,
    });
    const runs = (resp.data.workflow_runs ?? []).filter(
      (r: { path?: string; name?: string }) =>
        !(r.path ?? "").endsWith(AGENT_WORKFLOW_FILE) && r.name !== "Cyclops Agent"
    ) as Array<{ id: number; status: string; conclusion: string | null }>;

    if (runs.length > 0 && runs.every((r) => r.status === "completed")) {
      const failed = runs.find((r) => r.conclusion !== "success");
      if (failed) return { outcome: "failure", failedRunId: failed.id };
      return { outcome: "success" };
    }
    await sleep(interval);
  }
  return { outcome: "timeout" };
}

// Build the next-iteration seed from the red CI run's failed jobs/logs.
async function seedFromRedRun(
  deps: AgentLoopDeps,
  base: Seed,
  failedRunId: number
): Promise<Seed> {
  try {
    const jobs = await fetchFailedJobs(deps.octokit, deps.owner, deps.repo, failedRunId);
    const excerpt = jobs[0]
      ? await fetchJobLogExcerpt(deps.octokit, deps.owner, deps.repo, jobs[0].id)
      : "";
    const tail = excerpt.split("\n").slice(-20).join("\n");
    return {
      ...base,
      summary: `Your previous fix still fails CI (job "${jobs[0]?.name ?? "?"}"). Recent log tail:\n${tail}`,
      failedRunId,
    };
  } catch {
    return { ...base, summary: `${base.detector} still failing after the last fix.`, failedRunId };
  }
}

// ---------------------------------------------------------------------------
// ensureFixPrForSafe — in agent-safe mode the fix lands on a fresh
// cyclops/fix/* branch; open a review PR from it into baseBranch (once) so
// there's something green to merge. Best-effort and independent of the status
// comment (which stays on the ORIGINAL PR the user triggered from). No-op for
// all-in (the fix goes straight onto the PR's own branch).
// ---------------------------------------------------------------------------
async function ensureFixPrForSafe(deps: AgentLoopDeps, session: FixSession): Promise<void> {
  if (session.mode !== "agent-safe") return;
  const existing = await resolveOpenPrForBranch(
    deps.octokit,
    deps.owner,
    deps.repo,
    session.branchName
  );
  if (existing) return;
  try {
    await deps.octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: deps.owner,
      repo: deps.repo,
      title: `fix: cyclops automated fix for ${session.detectorType} [cyclops]`,
      body: [
        "🤖 Automated fix by cyclops — the coding agent iterated on this branch until CI was green.",
        "",
        `Detector: **${session.detectorType}**`,
      ].join("\n"),
      head: session.branchName,
      base: session.baseBranch,
      draft: false,
    });
  } catch {
    /* best-effort */
  }
}

// Best-effort cleanup of the throwaway session ref.
async function deleteSessionRef(deps: AgentLoopDeps, sessionId: string): Promise<void> {
  try {
    await deps.octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{+ref}", {
      owner: deps.owner,
      repo: deps.repo,
      ref: `cyclops/session-${sessionId}`,
    });
  } catch {
    /* disposable — ignore */
  }
}

// ---------------------------------------------------------------------------
// runAgentFixSession — the whole loop for one session. Mutates the FixSession
// row as it advances; posts progress/terminal comments via the shared helpers.
// ---------------------------------------------------------------------------
export async function runAgentFixSession(
  deps: AgentLoopDeps,
  params: { session: FixSession; finding: Finding; config: CyclopsConfig }
): Promise<{ status: string }> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const timings = { ...DEFAULT_TIMINGS, ...(deps.timings ?? {}) };
  const target: GitHubTarget = {
    octokit: deps.octokit,
    db: deps.db,
    owner: deps.owner,
    repo: deps.repo,
  };
  let session = params.session;
  const { finding, config } = params;

  const caps = {
    max_iterations: session.maxIterations,
    max_turns: timings.agentMaxTurns,
    model: config.autofix.agent.model,
    dry_run: config.autofix.dryRun,
  };
  let seed = seedFromFinding(finding);

  try {
    // Resolve the PR the user triggered from (the failing PR on baseBranch) and
    // post an IMMEDIATE acknowledgement, so there's instant feedback rather than
    // silence while the sandbox spins up. Status stays on this PR for both modes.
    if (!session.prNumber) {
      const pr = await resolveOpenPrForBranch(
        deps.octokit,
        deps.owner,
        deps.repo,
        session.baseBranch
      );
      if (pr) {
        session = await deps.db.fixSession.update({
          where: { id: session.id },
          data: { prNumber: pr },
        });
      }
    }
    try {
      await upsertLoopComment(target, session, startingBody(session.mode, session.maxIterations));
    } catch {
      /* cosmetic */
    }

    while (session.iteration < session.maxIterations) {
      const iteration = session.iteration + 1;
      deps.log.info({ sessionId: session.id, iteration }, "Agent fix: starting iteration");

      // Capture the target branch head BEFORE the agent runs, to detect a no-op.
      const beforeSha = await getBranchHead(deps, session.baseBranch);

      // 1. dispatch the sandbox
      const dispatchAtMs = now();
      await dispatchAgent(deps, session, seed, caps);

      // 2. locate + await the sandbox run
      let runId: number | null = null;
      const appearDeadline = now() + timings.runAppearTimeoutMs;
      while (now() < appearDeadline && runId === null) {
        await sleep(timings.pollIntervalMs);
        runId = await findSandboxRun(deps, dispatchAtMs);
      }
      if (runId === null) {
        await finalizeFixSession(target, session, "error", "Sandbox run never appeared.");
        return { status: "error" };
      }
      const sandbox = await waitForRun(deps, runId, timings.sandboxTimeoutMs, sleep, now);
      if (sandbox !== "success") {
        await finalizeFixSession(
          target,
          session,
          "error",
          `Agent sandbox run did not succeed (${sandbox}).`
        );
        return { status: "error" };
      }

      // 3. read the agent's result
      const sha = await readSessionRef(deps, session.id);
      if (!sha) {
        await finalizeFixSession(target, session, "error", "Agent produced no session ref.");
        return { status: "error" };
      }
      if (beforeSha && sha === beforeSha) {
        await finalizeFixSession(
          target,
          session,
          "failed_no_progress",
          "The agent made no changes."
        );
        await deleteSessionRef(deps, session.id);
        return { status: "failed_no_progress" };
      }

      // Dry run: never touch the real branch — just report the proposed SHA.
      if (config.autofix.dryRun) {
        await finalizeFixSession(
          target,
          session,
          "succeeded",
          `Dry run — proposed fix is at \`${sha.slice(0, 7)}\` on \`refs/cyclops/session-${session.id}\`. Nothing was promoted.`
        );
        return { status: "succeeded" };
      }

      // 4. promote → fires the real CI
      await promoteToBranch(deps, session.branchName, sha);
      await ensureFixPrForSafe(deps, session);
      session = await deps.db.fixSession.update({
        where: { id: session.id },
        data: { iteration, lastSha: sha },
      });
      try {
        await upsertLoopComment(
          target,
          session,
          progressBody(session.mode, iteration, session.maxIterations)
        );
      } catch {
        /* cosmetic */
      }

      // 5. poll the REAL CI
      const ci = await waitForRealCi(deps, sha, timings.ciTimeoutMs, sleep, now);
      if (ci.outcome === "success") {
        await finalizeFixSession(target, session, "succeeded");
        await deleteSessionRef(deps, session.id);
        return { status: "succeeded" };
      }
      if (ci.outcome === "timeout") {
        await finalizeFixSession(target, session, "error", "Timed out waiting for CI.");
        await deleteSessionRef(deps, session.id);
        return { status: "error" };
      }
      // red → prepare the next iteration's seed from the fresh failure
      deps.log.warn({ sessionId: session.id, iteration }, "Agent fix: CI still red, re-dispatching");
      seed = ci.failedRunId ? await seedFromRedRun(deps, seed, ci.failedRunId) : seed;
    }

    await finalizeFixSession(target, session, "failed_max_iterations");
    await deleteSessionRef(deps, session.id);
    return { status: "failed_max_iterations" };
  } catch (err) {
    deps.log.error({ sessionId: session.id, err }, "Agent fix: loop errored");
    await finalizeFixSession(target, session, "error", "An unexpected error interrupted the loop.");
    await deleteSessionRef(deps, session.id);
    return { status: "error" };
  }
}

function isStatus(err: unknown, status: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === status
  );
}
