import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

async function redisPlugin(app: FastifyInstance): Promise<void> {
  const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redis.on("error", (err) => {
    app.log.error({ err }, "Redis connection error");
  });

  app.decorate("redis", redis);

  app.addHook("onClose", async () => {
    await redis.quit();
  });
}

export const redisDecorator = fp(redisPlugin, {
  name: "redis",
  fastify: "5.x",
});
