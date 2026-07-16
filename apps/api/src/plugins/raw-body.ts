import type { FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";
import fp from "fastify-plugin";

// MUST be wrapped in fastify-plugin: without fp, fastify-raw-body's hook is
// encapsulated to this plugin's scope and never runs for sibling route plugins
// (e.g. webhookRoutes), so request.rawBody is undefined there.
async function rawBody(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,           // opt-in per route via config.rawBody: true
    encoding: "utf8",
    runFirst: true,          // run before content-type parser
  });
}

export const rawBodyPlugin = fp(rawBody, {
  name: "raw-body",
  fastify: "5.x",
});
