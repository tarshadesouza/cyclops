import type { FastifyInstance } from "fastify";
import { getDb } from "@cyclops/db";
import { billingQueue, actionExecutionQueue } from "@cyclops/queue";

interface ComponentHealth {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/status", async (_request, reply) => {
    const checks: Record<string, ComponentHealth> = {};

    // DB check
    const dbStart = Date.now();
    try {
      const db = getDb();
      await db.$queryRaw`SELECT 1`;
      checks["db"] = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (err: any) {
      checks["db"] = { status: "error", latencyMs: Date.now() - dbStart, error: String(err?.message ?? err) };
    }

    // Redis check
    const redisStart = Date.now();
    try {
      await (app as any).redis.ping();
      checks["redis"] = { status: "ok", latencyMs: Date.now() - redisStart };
    } catch (err: any) {
      checks["redis"] = { status: "error", latencyMs: Date.now() - redisStart, error: String(err?.message ?? err) };
    }

    // Queue depth check
    const queueStart = Date.now();
    try {
      const [billingWaiting, actionWaiting] = await Promise.all([
        billingQueue.getWaitingCount(),
        actionExecutionQueue.getWaitingCount(),
      ]);
      checks["queues"] = {
        status: "ok",
        latencyMs: Date.now() - queueStart,
      };
      (checks["queues"] as any).depth = {
        billing: billingWaiting,
        actionExecution: actionWaiting,
      };
    } catch (err: any) {
      checks["queues"] = { status: "error", latencyMs: Date.now() - queueStart, error: String(err?.message ?? err) };
    }

    const allOk = Object.values(checks).every((c) => c.status === "ok");
    const httpStatus = allOk ? 200 : 503;

    return reply.status(httpStatus).send({
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      service: "api",
      checks,
    });
  });
}
