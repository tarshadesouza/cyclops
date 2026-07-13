import yaml from "js-yaml";
import { CyclopsConfigSchema, type CyclopsConfig } from "./schema.js";

// 60-second TTL cache keyed by "repositoryId:ref"
const configCache = new Map<string, { value: CyclopsConfig; expiresAt: number }>();

export async function fetchConfig(
  octokit: { request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }> },
  owner: string,
  repo: string,
  ref: string,
  repositoryId: number
): Promise<CyclopsConfig> {
  const cacheKey = `${repositoryId}:${ref}`;
  const cached = configCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let config: CyclopsConfig;
  try {
    const resp = await (octokit as any).request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path: ".cyclops.yml", ref }
    );
    const data = resp.data as { content?: string };
    if (!data.content) throw new Error("empty content");
    const raw = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
    const parsed = yaml.load(raw);
    const result = CyclopsConfigSchema.safeParse(parsed);
    config = result.success ? result.data : CyclopsConfigSchema.parse({});
  } catch {
    config = CyclopsConfigSchema.parse({});
  }

  configCache.set(cacheKey, { value: config, expiresAt: Date.now() + 60_000 });
  return config;
}
