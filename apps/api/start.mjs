import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

console.log("[start] Running database migrations...");
try {
  execSync("node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts", {
    cwd: path.join(root, "packages/db"),
    stdio: "inherit",
    env: { ...process.env },
  });
  console.log("[start] Migrations complete, starting API server...");
} catch (err) {
  console.error("[start] Migration error (continuing):", err.message);
}

await import("./apps/api/dist/index.js");
