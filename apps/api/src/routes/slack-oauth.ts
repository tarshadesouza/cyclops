import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { getDb } from "@cyclops/db";
import { encryptApiKey } from "@cyclops/internal";

const SCOPES = "chat:write,channels:read,groups:read";
const STATE_TTL_SECONDS = 600; // 10 minutes

export async function slackOAuthRoutes(app: FastifyInstance): Promise<void> {
  const clientId = process.env["SLACK_CLIENT_ID"];
  const clientSecret = process.env["SLACK_CLIENT_SECRET"];
  const redirectUri = process.env["SLACK_REDIRECT_URI"];

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI env vars are required"
    );
  }

  // GET /slack/install?installationId=123
  app.get("/slack/install", async (request, reply) => {
    const { installationId } = request.query as { installationId?: string };
    if (!installationId || isNaN(Number(installationId))) {
      return reply.status(400).send({ error: "installationId query param required" });
    }

    const nonce = randomBytes(16).toString("hex");
    const state = `${installationId}:${nonce}`;
    await (app as any).redis.set(`slack:oauth:state:${state}`, "1", "EX", STATE_TTL_SECONDS);

    const params = new URLSearchParams({
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: redirectUri,
      state,
    });
    const authUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
    return reply.redirect(authUrl);
  });

  // GET /slack/oauth/callback?code=...&state=...
  app.get("/slack/oauth/callback", async (request, reply) => {
    const { code, state, error: oauthError } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (oauthError) {
      app.log.warn({ oauthError }, "Slack OAuth denied by user");
      return reply.status(400).send({ error: "Slack OAuth authorization denied" });
    }

    if (!code || !state) {
      return reply.status(400).send({ error: "Missing code or state" });
    }

    // Validate CSRF state
    const stored = await (app as any).redis.get(`slack:oauth:state:${state}`);
    if (!stored) {
      app.log.warn({ state }, "Slack OAuth state invalid or expired");
      return reply.status(400).send({ error: "Invalid or expired OAuth state" });
    }
    // Delete state immediately after validation (one-time use)
    await (app as any).redis.del(`slack:oauth:state:${state}`);

    // Extract installationId from state
    const [installationIdStr] = state.split(":");
    const installationId = Number(installationIdStr);
    if (!installationId || isNaN(installationId)) {
      return reply.status(400).send({ error: "Invalid state format" });
    }

    // Exchange code for bot token
    const tokenResp = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = (await tokenResp.json()) as any;
    if (!tokenData.ok) {
      app.log.error({ slackError: tokenData.error }, "Slack token exchange failed");
      return reply.status(502).send({ error: "Slack token exchange failed" });
    }

    const botToken: string = tokenData.access_token ?? "";
    if (!botToken.startsWith("xoxb-")) {
      app.log.error({ tokenPrefix: botToken.slice(0, 5) }, "Unexpected Slack token type");
      return reply.status(502).send({ error: "Unexpected Slack token type" });
    }

    const teamId: string = tokenData.team?.id ?? "";
    const teamName: string = tokenData.team?.name ?? "";

    // Encrypt token using same AES-256-GCM used for API keys
    const encryptedSlackToken = encryptApiKey(botToken);

    const db = getDb();
    await db.installation.update({
      where: { id: installationId },
      data: {
        encryptedSlackToken,
        slackTeamId: teamId,
        slackTeamName: teamName,
      },
    });

    app.log.info({ installationId, teamId, teamName }, "Slack workspace connected");
    return reply.status(200).send({ connected: true, teamName });
  });

  // DELETE /slack/disconnect?installationId=123
  app.delete("/slack/disconnect", async (request, reply) => {
    const { installationId } = request.query as { installationId?: string };
    if (!installationId || isNaN(Number(installationId))) {
      return reply.status(400).send({ error: "installationId query param required" });
    }

    const db = getDb();
    await db.installation.update({
      where: { id: Number(installationId) },
      data: {
        encryptedSlackToken: null,
        slackTeamId: null,
        slackTeamName: null,
      },
    });

    app.log.info({ installationId: Number(installationId) }, "Slack workspace disconnected");
    return reply.status(200).send({ disconnected: true });
  });
}
