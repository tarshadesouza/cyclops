import Fastify from "fastify";
import { rawBodyPlugin } from "./plugins/raw-body.js";
import { redisDecorator } from "./plugins/redis.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { healthRoutes } from "./routes/health.js";

const app = Fastify({
  logger: {
    level: process.env["LOG_LEVEL"] ?? "info",
  },
});

// CRITICAL: raw-body MUST be registered before any routes
await app.register(rawBodyPlugin);
await app.register(redisDecorator);

await app.register(healthRoutes);
await app.register(webhookRoutes);

const port = parseInt(process.env["PORT"] ?? "3000", 10);
const host = process.env["HOST"] ?? "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info(`API server listening on ${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
