import { getPool } from "./pool";

/**
 * 执行记录仓储层（Smart Planner Step 5「执行闭环」）。
 * execution_records = schedule 完成的客观事实：自动生成、schedule_id UNIQUE、**永不入账**。
 * 写入只发生在 completeScheduleTx / revertScheduleTx（repo/planner.ts，与 schedules 同事务）；
 * 本文件只放只读聚合（5c stats/context 消费）。所有查询显式携带 user_id。
 */

export type DbExecution = {
  id: string;
  user_id: string;
  schedule_id: string;
  action_id: string | null;
  actual_minutes: number;
  note: string | null;
  completed_at: string; // timestamptz（pg 返回 Date，序列化后为 string）
  created_at: string;
};

const EXECUTION_COLUMNS = `id, user_id, schedule_id, action_id, actual_minutes, note,
  completed_at, created_at`;

/** 某排程的执行记录（撤销用 / 回显；无则 null） */
export async function getExecutionBySchedule(userId: string, scheduleId: string): Promise<DbExecution | null> {
  const { rows } = await getPool().query<DbExecution>(
    `select ${EXECUTION_COLUMNS}
     from public.execution_records
     where user_id = $1 and schedule_id = $2
     limit 1`,
    [userId, scheduleId],
  );
  return rows[0] ?? null;
}

/** 某天的执行记录（按 completed_at 排序；AgentContext「今日执行」用） */
export async function listExecutionsByDate(userId: string, shanghaiDate: string): Promise<DbExecution[]> {
  const { rows } = await getPool().query<DbExecution>(
    `select ${EXECUTION_COLUMNS}
     from public.execution_records
     where user_id = $1 and (completed_at at time zone 'Asia/Shanghai')::date = $2::date
     order by completed_at asc`,
    [userId, shanghaiDate],
  );
  return rows;
}

/** 若干 action 的累计实际投入（actionId → 分钟；5c 行动路线「投入 x/y」用） */
export async function sumExecutionMinutesByActions(
  userId: string,
  actionIds: string[],
): Promise<Array<{ action_id: string; minutes: number }>> {
  if (actionIds.length === 0) return [];
  const { rows } = await getPool().query<{ action_id: string; minutes: string }>(
    `select action_id, sum(actual_minutes)::text as minutes
     from public.execution_records
     where user_id = $1 and action_id = any($2::uuid[])
     group by action_id`,
    [userId, actionIds],
  );
  return rows.map((r) => ({ action_id: r.action_id, minutes: Number(r.minutes) }));
}
