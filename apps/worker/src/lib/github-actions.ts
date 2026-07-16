import type { getInstallationClient } from "@cyclops/github";
import { stripLogFormatting } from "@cyclops/detectors";

// Derive the Octokit type from the installation client factory without importing @octokit/core directly
type Octokit = Awaited<ReturnType<typeof getInstallationClient>>;

// Module-level cache for stable repo info (owner/name never change for a given id)
const repoInfoCache = new Map<number, { owner: string; repo: string }>();

/**
 * Look up owner + repo name from a numeric repository ID.
 * Results are cached in memory — repository identity never changes.
 */
export async function getRepoInfo(
  octokit: Octokit,
  repositoryId: number
): Promise<{ owner: string; repo: string }> {
  const cached = repoInfoCache.get(repositoryId);
  if (cached) return cached;

  const resp = await (octokit as any).request("GET /repositories/{repository_id}", {
    repository_id: repositoryId,
  });

  const result = {
    owner: resp.data.owner.login as string,
    repo: resp.data.name as string,
  };
  repoInfoCache.set(repositoryId, result);
  return result;
}

/**
 * Return the failed jobs for a workflow run (latest attempt only).
 */
export async function fetchFailedJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number
): Promise<{ id: number; name: string }[]> {
  const resp = await (octokit as any).request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
    {
      owner,
      repo,
      run_id: runId,
      filter: "latest",
      per_page: 100,
    }
  );

  return (resp.data.jobs as Array<{ id: number; name: string; conclusion: string | null }>)
    .filter((j) => j.conclusion === "failure")
    .map((j) => ({ id: j.id, name: j.name }));
}

/**
 * Fetch the workflow YAML file content for a run.
 * Strips the `@branch` suffix from the workflow path before fetching.
 * Returns '' on 404 or any fetch error.
 */
export async function fetchWorkflowFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  sha: string
): Promise<string> {
  try {
    // Get the run to read the workflow path
    const runResp = await (octokit as any).request(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      { owner, repo, run_id: runId }
    );

    // Strip @branch suffix (e.g. ".github/workflows/ci.yml@main" -> ".github/workflows/ci.yml")
    const rawPath: string = runResp.data.path ?? "";
    const filePath = rawPath.split("@")[0];

    if (!filePath) return "";

    const fileResp = await (octokit as any).request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path: filePath, ref: sha }
    );

    const content: string = fileResp.data.content ?? "";
    // GitHub returns base64 with newlines — decode to utf-8
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return "";
    throw err;
  }
}

/**
 * Fetch and clean logs for a single job.
 * Handles both direct text responses and redirect-URL responses from the Octokit logs endpoint.
 * Strips ANSI + timestamps, caps at 150 lines.
 */
export async function fetchJobLogExcerpt(
  octokit: Octokit,
  owner: string,
  repo: string,
  jobId: number
): Promise<string> {
  const resp = await (octokit as any).request(
    "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
    { owner, repo, job_id: jobId }
  );

  let raw: string;
  if (typeof resp.data === "string" && resp.data.startsWith("http")) {
    // Octokit returned a redirect URL — follow it
    raw = await fetch(resp.data).then((r) => r.text());
  } else {
    raw = resp.data as string;
  }

  const stripped = stripLogFormatting(raw ?? "");
  // Failures appear at the END of a job log (setup/install noise dominates the
  // top), so keep the LAST 150 lines — that's where errors, assertions, and
  // lint output actually are.
  return stripped.split("\n").slice(-150).join("\n");
}

/**
 * Fetch the last N completed runs for a workflow+branch combination and find
 * matching job conclusions (used to classify flaky vs. consistently failing).
 * Returns [] on any error — history is best-effort.
 */
export async function fetchCheckRunHistory(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowId: number,
  jobName: string,
  branch: string
): Promise<{ conclusion: string | null }[]> {
  try {
    const history: { conclusion: string | null }[] = [];

    // Batch 1: last 5 runs on the same branch
    const branchRuns = await (octokit as any).request(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner,
        repo,
        workflow_id: workflowId,
        branch,
        status: "completed",
        per_page: 5,
      }
    );

    for (const run of branchRuns.data.workflow_runs ?? []) {
      const jobsResp = await (octokit as any).request(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
        { owner, repo, run_id: run.id, filter: "latest" }
      );
      const match = (
        jobsResp.data.jobs as Array<{ name: string; conclusion: string | null }>
      ).find((j) => j.name === jobName);
      if (match) history.push({ conclusion: match.conclusion });
    }

    // Batch 2: last 20 runs without branch filter (broader history)
    const allRuns = await (octokit as any).request(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner,
        repo,
        workflow_id: workflowId,
        status: "completed",
        per_page: 20,
      }
    );

    for (const run of allRuns.data.workflow_runs ?? []) {
      const jobsResp = await (octokit as any).request(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
        { owner, repo, run_id: run.id, filter: "latest" }
      );
      const match = (
        jobsResp.data.jobs as Array<{ name: string; conclusion: string | null }>
      ).find((j) => j.name === jobName);
      if (match) history.push({ conclusion: match.conclusion });
    }

    return history;
  } catch {
    // Best-effort — never throw; detectFlakyTest handles empty history gracefully
    return [];
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}
