import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolve repo root: this file is at apps/api/start.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

console.log("[start] Running database migrations...");
try {
  execSync("pnpm --filter @cyclops/db run db:migrate", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  console.log("[start] Migrations complete.");
} catch (err) {
  console.error("[start] Migration failed:", err.message);
  process.exit(1);
}

console.log("[start] Starting API server...");
await import("./dist/index.js");
