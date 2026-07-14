import { decryptApiKey } from "@cyclops/internal";

export interface SlackPostOptions {
  encryptedToken: string;
  channelIdOrName: string; // Either a C-prefixed ID or a channel name
  text: string;
  blocks?: unknown[];
}

/**
 * Resolves a channel name to a Slack channel ID.
 * Returns null if the channel cannot be found (caller should skip alert).
 * channelName: with or without leading '#'
 */
export async function resolveChannelId(
  botToken: string,
  channelName: string
): Promise<string | null> {
  // If it already looks like a channel ID (starts with C, D, G, or W + alphanumeric), return as-is
  if (/^[CDGW][A-Z0-9]+$/.test(channelName.trim())) {
    return channelName.trim();
  }

  const name = channelName.replace(/^#/, "").toLowerCase();

  // conversations.list paginates — fetch first page (limit=200) which covers most workspaces
  const resp = await fetch(
    "https://slack.com/api/conversations.list?limit=200&exclude_archived=true&types=public_channel,private_channel",
    {
      headers: { Authorization: `Bearer ${botToken}` },
    }
  );

  if (!resp.ok) {
    return null;
  }

  const data = (await resp.json()) as {
    ok: boolean;
    channels?: Array<{ id: string; name: string }>;
  };
  if (!data.ok) {
    return null;
  }

  const channel = (data.channels ?? []).find((c) => c.name === name);
  return channel?.id ?? null;
}

/**
 * Posts a Slack message using the bot token.
 * Returns { ok: true } on success.
 * Returns { ok: false, reason: string } on failure — never throws.
 */
export async function postSlackMessage(
  options: SlackPostOptions
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let botToken: string;
  try {
    botToken = decryptApiKey(options.encryptedToken);
  } catch {
    return { ok: false, reason: "token_decrypt_failed" };
  }

  const channelId = await resolveChannelId(botToken, options.channelIdOrName);
  if (!channelId) {
    return { ok: false, reason: "channel_not_found" };
  }

  const body: Record<string, unknown> = { channel: channelId, text: options.text };
  if (options.blocks) {
    body["blocks"] = options.blocks;
  }

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    return { ok: false, reason: `http_${resp.status}` };
  }

  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    return { ok: false, reason: data.error ?? "slack_api_error" };
  }

  return { ok: true };
}
