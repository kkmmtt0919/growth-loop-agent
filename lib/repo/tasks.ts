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
    // completed_at：MVP 记录「最后完成时间」（done → now()，undo → null），账本逻辑零改动
    const { rows: updatedRows } = await client.query<DbTask>(
      `update public.tasks set status = $3, version = version + 1, completed_at = $4
       where id = $1 and user_id = $2
       returning *`,
      [taskId, userId, nextStatus, done ? new Date() : null],
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

/* =============================================================
 * Phase 1 扩展：任务 CRUD（元数据层，不触碰账本）
 * 红线：所有查询显式带 user_id；按 id 操作 id + user_id 双条件。
 * 规则：createTask/updateTask 不写 xp/coin；状态变更只走 toggleTask（PATCH）。
 * ============================================================= */

const TASK_SELECT = `id, user_id, goal_id, title, subtitle, scheduled_time, duration_minutes, xp, coin,
  status, kind, version, deadline::text as deadline, frequency, completed_at, created_at, updated_at`;

export type CreateTaskInput = {
  title: string;
  goalId?: string | null;
  subtitle?: string;
  scheduledTime?: string;
  durationMinutes?: number | null;
  deadline?: string | null;
  frequency?: string | null;
  kind?: DbTask["kind"];
  xp?: number;
  coin?: number;
};

/** 创建任务（status 默认 upcoming；xp/coin 默认 0） */
export async function createTask(userId: string, input: CreateTaskInput): Promise<DbTask> {
  const { rows } = await getPool().query<DbTask>(
    `insert into public.tasks
       (user_id, goal_id, title, subtitle, scheduled_time, duration_minutes, deadline, frequency, kind, xp, coin, status)
     values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, 'upcoming')
     returning ${TASK_SELECT}`,
    [
      userId,
      input.goalId ?? null,
      input.title,
      input.subtitle ?? "",
      input.scheduledTime ?? "",
      input.durationMinutes ?? null,
      input.deadline ?? null,
      input.frequency ?? null,
      input.kind ?? "focus",
      input.xp ?? 0,
      input.coin ?? 0,
    ],
  );
  return rows[0];
}

/** 查询任务（可选按 goalId / status 过滤），按 scheduled_time 升序 */
export async function listTasksByFilter(
  userId: string,
  filter: { goalId?: string | null; status?: DbTask["status"] } = {},
): Promise<DbTask[]> {
  const conditions = ["user_id = $1"];
  const params: unknown[] = [userId];
  if (filter.goalId !== undefined && filter.goalId !== null) {
    params.push(filter.goalId);
    conditions.push(`goal_id = $${params.length}`);
  }
  if (filter.status !== undefined && filter.status !== null) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  const { rows } = await getPool().query<DbTask>(
    `select ${TASK_SELECT} from public.tasks where ${conditions.join(" and ")} order by scheduled_time asc`,
    params,
  );
  return rows;
}

export type UpdateTaskInput = {
  title?: string;
  subtitle?: string;
  scheduledTime?: string;
  durationMinutes?: number | null;
  deadline?: string | null;
  frequency?: string | null;
  kind?: DbTask["kind"];
  goalId?: string | null;
};

/**
 * 更新任务元数据。
 * 硬规则：不接受 xp/coin/status（防绕过账本与状态机）——Service 层白名单保证；
 * status 变更必须走 toggleTask。
 */
export async function updateTask(userId: string, taskId: string, input: UpdateTaskInput): Promise<DbTask | null> {
  const { rows } = await getPool().query<DbTask>(
    `update public.tasks set
       title = coalesce($3, title),
       subtitle = coalesce($4, subtitle),
       scheduled_time = coalesce($5, scheduled_time),
       duration_minutes = coalesce($6, duration_minutes),
       deadline = coalesce($7::date, deadline),
       frequency = coalesce($8, frequency),
       kind = coalesce($9, kind),
       goal_id = coalesce($10, goal_id)
     where id = $1 and user_id = $2
     returning ${TASK_SELECT}`,
    [
      taskId,
      userId,
      input.title ?? null,
      input.subtitle ?? null,
      input.scheduledTime ?? null,
      input.durationMinutes === undefined ? null : input.durationMinutes,
      input.deadline === undefined ? null : input.deadline,
      input.frequency === undefined ? null : input.frequency,
      input.kind ?? null,
      input.goalId === undefined ? null : input.goalId,
    ],
  );
  return rows[0] ?? null;
}

/** 删除任务（不冲正账本：产品设计 §6.5「删除任务不扣分」） */
export async function deleteTask(userId: string, taskId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`delete from public.tasks where id = $1 and user_id = $2`, [taskId, userId]);
  return (rowCount ?? 0) > 0;
}

/** 按 id 取单个任务（user 隔离；跨用户返回 null） */
export async function getTask(userId: string, taskId: string): Promise<DbTask | null> {
  const { rows } = await getPool().query<DbTask>(
    `select ${TASK_SELECT} from public.tasks where id = $1 and user_id = $2 limit 1`,
    [taskId, userId],
  );
  return rows[0] ?? null;
}
