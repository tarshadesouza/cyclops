import type { Octokit } from "@octokit/core";
import { getApp } from "./app.js";

/**
 * Returns an App-level Octokit authenticated with a JWT.
 * Use for: listing installations, accessing app metadata.
 */
export function getAppClient(): Octokit {
  return getApp().octokit;
}

/**
 * Returns an installation-scoped Octokit authenticated with an installation token.
 * Token is automatically refreshed by @octokit/auth-app (59-min LRU cache).
 * NEVER store the returned token. Call at job-start time.
 */
export async function getInstallationClient(installationId: number): Promise<Octokit> {
  const app = getApp();
  return app.getInstallationOctokit(installationId);
}
