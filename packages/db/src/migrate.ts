import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

console.log("[migrate] Running Prisma migrations...");
try {
  execSync("prisma migrate deploy --config prisma.config.ts", {
    cwd: dbDir,
    stdio: "inherit",
    env: { ...process.env },
  });
  console.log("[migrate] Migrations complete.");
} catch (err) {
  console.error("[migrate] Migration failed:", err);
  throw err;
}
