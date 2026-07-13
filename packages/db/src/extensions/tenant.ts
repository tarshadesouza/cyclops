import { getDb } from "../client.js";

/**
 * Returns a Prisma client extended with tenant isolation via RLS.
 * Every operation is wrapped in a transaction that sets app.current_installation_id
 * using set_config with TRUE (transaction-local) — safe with PgBouncer in transaction mode.
 *
 * Call this at the start of every worker job with the installationId from the job payload.
 * NEVER store the returned client across requests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTenantClient(installationId: number): any {
  const db = getDb();

  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({
          args,
          query,
        }: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          query: (args: any) => Promise<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }): Promise<any> {
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
