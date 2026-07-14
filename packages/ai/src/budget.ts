export type BudgetStatus = { exceeded: boolean; used: number; cap: number };

// Accept a loosely-typed db client so @cyclops/ai does NOT import @cyclops/db.
// IMPORTANT: caller MUST pass a tenant-scoped client so RLS + the WHERE both resolve correctly.
export async function checkTokenBudget(
  db: { $queryRaw: <T = unknown>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T> },
  installationId: number
): Promise<BudgetStatus> {
  const cap = parseInt(process.env['CYCLOPS_MONTHLY_TOKEN_BUDGET'] ?? '1000000', 10);

  const result = await db.$queryRaw<[{ total: bigint }]>`
    SELECT COALESCE(SUM("inputTokens" + "outputTokens"), 0) AS total
    FROM "token_usages"
    WHERE "installationId" = ${installationId}
      AND "timestamp" >= date_trunc('month', NOW())
  `;

  const used = Number(result[0]?.total ?? 0);
  return { exceeded: used >= cap, used, cap };
}
