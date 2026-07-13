import type { FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";

export async function rawBodyPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,           // opt-in per route via config.rawBody: true
    encoding: "utf8",
    runFirst: true,          // run before content-type parser
  });
}
