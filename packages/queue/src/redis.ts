import { Redis } from "ioredis";

let redisInstance: Redis | undefined;

export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null, // REQUIRED for BullMQ
      enableReadyCheck: false,
    });
  }
  return redisInstance;
}
