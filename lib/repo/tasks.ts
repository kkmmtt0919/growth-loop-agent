import type { PoolClient } from "pg";
import { getPool } from "./pool";
import type { DbTask } from "./types";

export async function listTasks(userId: string): Promise<DbTask[]> {
  const { rows } = await getPool().query<DbTask>(
    `select * from public.tasks
     where user_id = $1
     order by scheduled_time asc`,
    [userId],
  );
  return rows;
}

/** 批量播种任务（首登时使用） */
export async function createTasks(
  userId: string,
  items: Array<Pick<DbTask, "title" | "subtitle" | "scheduled_time" | "duration_minutes" | "xp" | "coin" | "status" | "kind">>,
): Promise<void> {
  for (const item of items) {
    await getPool().query(
      `insert into public.tasks
         (user_id, title, subtitle, scheduled_time, duration_minutes, xp, coin, status, kind)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        item.title,
        item.subtitle,
        item.scheduled_time,
        item.duration_minutes,
        item.xp,
        item.coin,
        item.status,
        item.kind,
      ],
    );
  }
}

/**
 * 切换任务完成状态并在同一事务内结算奖励（幂等）。
 * 完成 -> 入账 +xp/+coin（key 带 task id）；撤销 -> 冲正（负额，key 带 :undo）。
 * 重复调用因 idempotency_key 冲突不会重复入账。
 */
export async function toggleTask(
  userId: string,
  taskId: string,
  done: boolean,
): Promise<DbTask | null> {
  const client = await getPool().connect();
  try {
    await client.query("begin");

    const { rows: taskRows } = await client.query<DbTask>(
      `select * from public.tasks where id = $1 and user_id = $2 for update`,
      [taskId, userId],
    );
    const task = taskRows[0];
    if (!task) {
      await client.query("rollback");
      return null;
    }

    const nextStatus: DbTask["status"] = done ? "done" : "upcoming";
    // version+1：每次状态切换都拿到新版本号，账本 key 带版本，互不冲突
    const { rows: updatedRows } = await client.query<DbTask>(
      `update public.tasks set status = $3, version = version + 1
       where id = $1 and user_id = $2
       returning *`,
      [taskId, userId, nextStatus],
    );
    const updated = updatedRows[0];
    const version = updated.version;

    // key 语义：task:{id}:{account}:v{version}
    // 完成/撤销/再完成 各占一个唯一 key；重复请求由上方状态守卫挡住（幂等）
    if (done && task.status !== "done") {
      await applyLedgerInTx(client, userId, "XP", task.xp, `完成任务：${task.title}`, task.id, `task:${task.id}:xp:v${version}`);
      await applyLedgerInTx(client, userId, "COIN", task.coin, `完成任务：${task.title}`, task.id, `task:${task.id}:coin:v${version}`);
    } else if (!done && task.status === "done") {
      await applyLedgerInTx(client, userId, "XP", -task.xp, `撤销任务：${task.title}`, task.id, `task:${task.id}:xp:undo:v${version}`);
      await applyLedgerInTx(client, userId, "COIN", -task.coin, `撤销任务：${task.title}`, task.id, `task:${task.id}:coin:undo:v${version}`);
    }

    await client.query("commit");
    return updated;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** 事务内幂等入账（与 ledger.applyLedger 同逻辑，但复用当前事务连接） */
async function applyLedgerInTx(
  client: PoolClient,
  userId: string,
  account: "XP" | "COIN",
  amount: number,
  reason: string,
  sourceId: string,
  idempotencyKey: string,
) {
  const result = await client.query(
    `insert into public.ledger_entries (user_id, account, amount, reason, source_id, idempotency_key)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (idempotency_key) do nothing`,
    [userId, account, amount, reason, sourceId, idempotencyKey],
  );
  if ((result.rowCount ?? 0) > 0) {
    const column = account === "XP" ? "xp_balance" : "coin_balance";
    await client.query(
      `update public.profiles set ${column} = ${column} + $2 where id = $1`,
      [userId, amount],
    );
  }
}
