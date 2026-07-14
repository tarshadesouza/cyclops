# @cyclops/db

Prisma 7 database package for CyclOps. Provides tenant-scoped database clients with Row-Level Security enforcement.

## Setup sequence

1. Set DATABASE_URL in .env
2. `pnpm --filter @cyclops/db run db:migrate:dev`  (creates tables)
3. `pnpm --filter @cyclops/db run db:generate`     (generates client to src/generated/)
4. `pnpm --filter @cyclops/db run build`           (compiles TypeScript)

**Note:** `prisma generate` does NOT auto-run after `migrate dev` in Prisma 7.
Always run `db:generate` explicitly after schema changes.

After running `db:generate`, update `src/index.ts` to uncomment the type exports.

## Usage

```typescript
import { getDb, getTenantClient } from "@cyclops/db";

// Singleton client for service-level operations (bypasses RLS via postgres role)
const db = getDb();

// Per-request/job tenant-scoped client — injects installationId via set_config
// NEVER store this client across requests.
const tenantDb = getTenantClient(installationId);
const deliveries = await tenantDb.webhookDelivery.findMany();
```

## Architecture

- `getDb()` — singleton `PrismaClient` using `@prisma/adapter-pg` (driver adapter required in Prisma 7)
- `getTenantClient(installationId)` — extends the client with `$allOperations` to run every query inside a transaction that calls `set_config('app.current_installation_id', ..., TRUE)` (TRUE = transaction-local, safe with PgBouncer in transaction mode)
- RLS policies in migration 0002_rls enforce tenant isolation at the PostgreSQL level
- Service bypass policies allow the `postgres` superuser role to skip RLS (for migrations, admin ops)
