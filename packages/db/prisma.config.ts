import path from "node:path";
import { defineConfig } from "prisma/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

export default defineConfig({
  earlyAccess: true,
  schema: path.join(import.meta.dirname, "prisma/schema.prisma"),
  migrate: {
    async adapter() {
      const pool = new pg.Pool({
        connectionString: process.env["DATABASE_URL"],
      });
      return new PrismaPg(pool);
    },
  },
});
