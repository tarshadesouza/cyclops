import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { encryptApiKey } from "@cyclops/internal";
import { getDb } from "@cyclops/db";

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  const setupSecret = process.env["CYCLOPS_SETUP_SECRET"];
  if (!setupSecret) {
    throw new Error("CYCLOPS_SETUP_SECRET environment variable is required");
  }

  app.post("/setup/:installationId", async (request, reply) => {
    // Authenticate via shared secret using timing-safe comparison
    const tokenHeader = request.headers["x-setup-token"] as string | undefined;
    if (!tokenHeader) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    let tokenValid = false;
    try {
      // Guard against length mismatch (timingSafeEqual requires equal lengths)
      if (tokenHeader.length === setupSecret.length) {
        tokenValid = timingSafeEqual(
          Buffer.from(tokenHeader),
          Buffer.from(setupSecret)
        );
      }
    } catch {
      tokenValid = false;
    }

    if (!tokenValid) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    // Validate installationId param
    const { installationId: installationIdStr } = request.params as { installationId: string };
    const installationId = parseInt(installationIdStr, 10);
    if (!Number.isFinite(installationId) || installationId <= 0) {
      return reply.status(400).send({ error: "Invalid installationId" });
    }

    // Validate API key format
    const body = request.body as Record<string, unknown>;
    const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"] : undefined;
    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      return reply.status(400).send({ error: "Invalid Anthropic API key format" });
    }

    // Encrypt the key
    const encryptedApiKey = encryptApiKey(apiKey);

    // Persist to DB
    const db = getDb();
    try {
      await db.installation.update({
        where: { id: installationId },
        data: { encryptedApiKey },
      });
    } catch (err: unknown) {
      // Prisma throws P2025 when the record is not found
      const isPrismaNotFound =
        err instanceof Error &&
        (err as any).code === "P2025";
      if (isPrismaNotFound) {
        return reply.status(404).send({ error: "Installation not found" });
      }
      throw err;
    }

    // Log only the installationId — never apiKey or encryptedApiKey
    app.log.info({ installationId }, "API key stored for installation");

    return reply.status(200).send({ ok: true });
  });
}
