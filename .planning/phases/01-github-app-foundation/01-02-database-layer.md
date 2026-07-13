---
phase: 01-github-app-foundation
plan: 02
type: execute
wave: 2
depends_on: ["01-01"]
files_modified:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/0001_initial/migration.sql
  - packages/db/prisma/migrations/0002_rls/migration.sql
  - packages/db/prisma.config.ts
  - packages/db/src/client.ts
  - packages/db/src/extensions/tenant.ts
  - packages/db/src/index.ts
autonomous: true

must_haves:
  truths:
    - "prisma migrate dev runs without error against a local PostgreSQL database"
    - "getTenantClient(installationId) returns a Prisma client that injects installationId on every query"
    - "RLS policies exist on the installations table enforced at the database layer"
    - "SET LOCAL via set_config is used for RLS context — not plain SET — to be safe with PgBouncer"
    - "Prisma client is generated to packages/db/src/generated (not node_modules) using prisma-client generator name"
  artifacts:
    - path: "packages/db/prisma/schema.prisma"
      provides: "Installation and WebhookDelivery models"
      contains: "generator prisma-client"
    - path: "packages/db/prisma.config.ts"
      provides: "Prisma 7 required config file"
    - path: "packages/db/src/client.ts"
      provides: "getDb() singleton using @prisma/adapter-pg"
    - path: "packages/db/src/extensions/tenant.ts"
      provides: "getTenantClient(installationId) with $allOperations injection"
    - path: "packages/db/src/index.ts"
      provides: "Public exports: getDb, getTenantClient, Prisma types"
  key_links:
    - from: "packages/db/src/extensions/tenant.ts"
      to: "packages/db/src/client.ts"
      via: "import getDb"
      pattern: "getDb"
    - from: "packages/db/src/client.ts"
      to: "@prisma/adapter-pg"
      via: "PrismaPg adapter constructor"
      pattern: "PrismaPg"
    - from: "packages/db/prisma/migrations/0002_rls/migration.sql"
      to: "installations table"
      via: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY"
      pattern: "ENABLE ROW LEVEL SECURITY"
---

<objective>
Implement the complete @ciintel/db package: Prisma 7 schema with Installation and WebhookDelivery models, PostgreSQL Row-Level Security migration, client factory using @prisma/adapter-pg, and a tenant extension that injects installationId on every query using $allOperations.

Purpose: Every worker job and API handler needs a tenant-scoped database client. This package is the single source of truth for data isolation — get RLS and the tenant extension right here and the rest of the system inherits correctness.

Output: A @ciintel/db package that exports getDb() and getTenantClient(installationId), compiles cleanly, and enforces tenant isolation at both the Prisma extension layer and the PostgreSQL RLS layer.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/tsouza/Projects/ciintel/.planning/PROJECT.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-RESEARCH.md
@/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-01-SUMMARY.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Prisma 7 schema, config file, and initial migration</name>
  <files>
    packages/db/prisma/schema.prisma
    packages/db/prisma.config.ts
    packages/db/prisma/migrations/0001_initial/migration.sql
    packages/db/prisma/migrations/0002_rls/migration.sql
  </files>
  <action>
Create the Prisma 7 schema, required prisma.config.ts, and two migration SQL files.

**CRITICAL Prisma 7 breaking changes to apply:**
- Generator name MUST be `prisma-client` (not `prisma-client-js`)
- `output` field is required in the generator block
- `@prisma/adapter-pg` is mandatory (driver adapters no longer optional)
- `prisma generate` does NOT auto-run after `migrate dev` — must run explicitly

**packages/db/prisma/schema.prisma:**
```prisma
generator prisma-client {
  provider        = "prisma-client"
  output          = "../src/generated"
  previewFeatures = []
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Installation {
  id                Int       @id
  accountLogin      String
  accountType       String    // "Organization" | "User"
  appId             Int
  targetId          Int
  targetType        String
  suspended         Boolean   @default(false)
  deletedAt         DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  webhookDeliveries WebhookDelivery[]

  @@map("installations")
}

model WebhookDelivery {
  id             String   @id @default(uuid())
  deliveryId     String   @unique  // X-GitHub-Delivery header — idempotency key
  installationId Int
  eventName      String
  action         String?
  payload        Json
  enqueuedAt     DateTime @default(now())
  processedAt    DateTime?

  installation   Installation @relation(fields: [installationId], references: [id])

  @@index([installationId])
  @@index([deliveryId])
  @@map("webhook_deliveries")
}
```

**packages/db/prisma.config.ts** (Prisma 7 — required file):
```typescript
import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  earlyAccess: true,
  schema: path.join(import.meta.dirname, "prisma/schema.prisma"),
});
```

**packages/db/prisma/migrations/0001_initial/migration.sql:**
Write the CREATE TABLE statements matching the schema above. Include:
- `CREATE TABLE installations` with all columns, primary key on id
- `CREATE TABLE webhook_deliveries` with UNIQUE constraint on delivery_id
- Both tables default to UTC timestamps

```sql
-- 0001_initial: Create installations and webhook_deliveries tables

CREATE TABLE "installations" (
  "id"           INTEGER       NOT NULL,
  "accountLogin" TEXT          NOT NULL,
  "accountType"  TEXT          NOT NULL,
  "appId"        INTEGER       NOT NULL,
  "targetId"     INTEGER       NOT NULL,
  "targetType"   TEXT          NOT NULL,
  "suspended"    BOOLEAN       NOT NULL DEFAULT false,
  "deletedAt"    TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
  "id"             TEXT          NOT NULL,
  "deliveryId"     TEXT          NOT NULL,
  "installationId" INTEGER       NOT NULL,
  "eventName"      TEXT          NOT NULL,
  "action"         TEXT,
  "payload"        JSONB         NOT NULL,
  "enqueuedAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"    TIMESTAMP(3),

  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_deliveries_deliveryId_key" ON "webhook_deliveries"("deliveryId");
CREATE INDEX "webhook_deliveries_installationId_idx" ON "webhook_deliveries"("installationId");
CREATE INDEX "webhook_deliveries_deliveryId_idx" ON "webhook_deliveries"("deliveryId");

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

**packages/db/prisma/migrations/0002_rls/migration.sql:**

CRITICAL: Use `set_config('app.current_installation_id', $1, TRUE)` (third argument TRUE = transaction-local). Plain `SET` leaks context across connections when PgBouncer runs in transaction mode.

```sql
-- 0002_rls: Enable Row-Level Security on tenant tables

-- Enable RLS
ALTER TABLE "installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;

-- Allow service role to bypass (for migrations and admin operations)
ALTER TABLE "installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;

-- Create a function to get current installation ID from session config
CREATE OR REPLACE FUNCTION current_installation_id() RETURNS INTEGER AS $$
  SELECT NULLIF(current_setting('app.current_installation_id', true), '')::INTEGER;
$$ LANGUAGE SQL STABLE;

-- RLS policy: installations visible only to their own installation
CREATE POLICY "installations_tenant_isolation" ON "installations"
  USING (id = current_installation_id());

-- RLS policy: webhook_deliveries scoped to installation
CREATE POLICY "webhook_deliveries_tenant_isolation" ON "webhook_deliveries"
  USING ("installationId" = current_installation_id());

-- Bypass policy for superuser / service role (needed for migrations)
CREATE POLICY "installations_service_bypass" ON "installations"
  TO "postgres"
  USING (true);

CREATE POLICY "webhook_deliveries_service_bypass" ON "webhook_deliveries"
  TO "postgres"
  USING (true);
```
  </action>
  <verify>
1. `cat packages/db/prisma/schema.prisma | grep "generator prisma-client"` — returns the generator block with name prisma-client (not prisma-client-js)
2. `cat packages/db/prisma.config.ts` — file exists and imports defineConfig from "prisma/config"
3. `cat packages/db/prisma/migrations/0002_rls/migration.sql | grep "set_config"` — returns the set_config function
4. `cat packages/db/prisma/migrations/0002_rls/migration.sql | grep "ENABLE ROW LEVEL SECURITY"` — returns 2 lines
  </verify>
  <done>Prisma schema uses prisma-client generator with explicit output, prisma.config.ts exists, two migration files exist with correct RLS setup using set_config for transaction-local context.</done>
</task>

<task type="auto">
  <name>Task 2: Prisma client factory with adapter-pg and tenant extension</name>
  <files>
    packages/db/src/client.ts
    packages/db/src/extensions/tenant.ts
    packages/db/src/index.ts
  </files>
  <action>
Implement the three source files that form the public API of @ciintel/db.

**packages/db/src/client.ts** — singleton Prisma client using @prisma/adapter-pg:

```typescript
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
// Note: after `pnpm --filter @ciintel/db run db:generate`, the generated client
// will be at ./generated/index.js. Until first generate, this import may show
// a type error — that is expected and resolved by running db:generate.
import { PrismaClient } from "./generated/index.js";

let client: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!client) {
    const pool = new pg.Pool({
      connectionString: process.env["DATABASE_URL"],
    });
    const adapter = new PrismaPg(pool);
    client = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);
  }
  return client;
}
```

**packages/db/src/extensions/tenant.ts** — tenant-scoped client factory:

The $allOperations extension intercepts every Prisma query and wraps it in a transaction that first sets the RLS context using set_config with TRUE (transaction-local). This ensures PgBouncer in transaction mode never leaks tenant context across connections.

```typescript
import type { PrismaClient } from "./generated/index.js";
import { getDb } from "../client.js";

export function getTenantClient(installationId: number) {
  const db = getDb();

  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ operation, model, args, query }) {
          // Set installation ID as transaction-local (TRUE = local to transaction)
          // This is safe with PgBouncer in transaction mode — plain SET would leak.
          const [, result] = await db.$transaction([
            db.$executeRaw`SELECT set_config('app.current_installation_id', ${installationId.toString()}, TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}
```

**packages/db/src/index.ts** — public exports:

```typescript
export { getDb } from "./client.js";
export { getTenantClient } from "./extensions/tenant.js";
// Re-export Prisma types for consumers
// (PrismaClient type available after db:generate)
export type { Installation, WebhookDelivery } from "./generated/index.js";
```

NOTE: The imports from `./generated/index.js` will fail TypeScript compilation until `pnpm --filter @ciintel/db run db:generate` is executed. Add a comment in each file noting this dependency. The generated output path is `packages/db/src/generated` as declared in schema.prisma.

Add a note in packages/db/README.md (create if needed):
```
# @ciintel/db

Setup sequence:
1. Set DATABASE_URL in .env
2. pnpm --filter @ciintel/db run db:migrate:dev  (creates tables)
3. pnpm --filter @ciintel/db run db:generate     (generates client)
4. pnpm --filter @ciintel/db run build           (compiles TypeScript)

Note: prisma generate does NOT auto-run after migrate dev in Prisma 7.
Always run db:generate explicitly after schema changes.
```
  </action>
  <verify>
1. `cat packages/db/src/client.ts | grep "PrismaPg"` — returns PrismaPg import and usage
2. `cat packages/db/src/extensions/tenant.ts | grep "set_config"` — returns the set_config line with TRUE argument
3. `cat packages/db/src/extensions/tenant.ts | grep "allOperations"` — returns $allOperations usage
4. `cat packages/db/src/index.ts | grep "getTenantClient"` — confirms export
  </verify>
  <done>getDb() returns a singleton PrismaClient using @prisma/adapter-pg. getTenantClient(installationId) returns an extended client that sets RLS context transaction-locally before every operation. Public exports declared in index.ts.</done>
</task>

</tasks>

<verification>
1. Schema uses `generator prisma-client` (not `prisma-client-js`)
2. prisma.config.ts exists at packages/db/prisma.config.ts
3. Migration 0002_rls uses `set_config(..., TRUE)` not plain `SET`
4. `ENABLE ROW LEVEL SECURITY` appears on both tenant tables
5. `getTenantClient` uses `$allOperations` to inject context on every query
6. `getDb()` uses `PrismaPg` adapter from `@prisma/adapter-pg`
7. All imports in .ts files use .js extensions (nodenext requirement)
</verification>

<success_criteria>
- Prisma schema compiles (prisma validate passes once prisma is installed)
- Two migration SQL files exist with correct DDL
- RLS policies use set_config with transaction-local TRUE flag
- getTenantClient wraps all operations in a transaction that sets installationId
- getDb singleton pattern prevents connection pool exhaustion
- All .ts files use .js extensions in imports (TypeScript nodenext)
- README documents the required generate-after-migrate step
</success_criteria>

<output>
After completion, create `/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-02-SUMMARY.md` with:
- frontmatter: phase, plan, subsystem: database, affects: [apps/api, apps/worker], tech-stack.added: [prisma@7, @prisma/adapter-pg, pg@8]
- What was built (schema, migrations, client factory, tenant extension)
- Key decisions: set_config with TRUE for PgBouncer safety, prisma-client generator name, generated output path
</output>
