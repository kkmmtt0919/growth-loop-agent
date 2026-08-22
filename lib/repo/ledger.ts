import { getPool } from "./pool";
import type { DbLedgerEntry } from "./types";

export type ApplyLedgerInput = {
  userId: string;
  account: "XP" | "COIN";
  amount: number;
  reason: string;
  sourceId?: string | null;
  idempotencyKey: string;
};

/**
 * 幂等入账：插入流水 + 更新余额在同一个事务内。
 * idempotency_key 冲突时跳过（返回 false），重复提交不会重复入账。
 */
export async function applyLedger(input: ApplyLedgerInput): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("begin");

    const result = await client.query(
      `insert into public.ledger_entries (user_id, account, amount, reason, source_id, idempotency_key)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (idempotency_key) do nothing`,
      [input.userId, input.account, input.amount, input.reason, input.sourceId ?? null, input.idempotencyKey],
    );
    const inserted = (result.rowCount ?? 0) > 0;

    if (inserted) {
      const column = input.account === "XP" ? "xp_balance" : "coin_balance";
      await client.query(
        `update public.profiles set ${column} = ${column} + $2 where id = $1`,
        [input.userId, input.amount],
      );
    }

    await client.query("commit");
    return inserted;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listLedger(userId: string, limit = 50): Promise<DbLedgerEntry[]> {
  const { rows } = await getPool().query<DbLedgerEntry>(
    `select * from public.ledger_entries
     where user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit],
  );
  return rows;
}
