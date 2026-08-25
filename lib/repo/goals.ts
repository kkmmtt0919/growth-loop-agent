import { getPool } from "./pool";
import type { DbGoal } from "./types";

/**
 * 目标仓储层（Phase 1 扩展：CRUD）。
 * 红线：所有查询显式带 user_id；按 id 操作一律 id + user_id 双条件（多用户隔离）。
 * progress 列为 legacy cache，业务写入一律不碰（事实来源是 tasks.status）。
 */

export async function listGoals(userId: string): Promise<DbGoal[]> {
  const { rows } = await getPool().query<DbGoal>(
    `select id, user_id, title, description, progress, horizon, status,
            start_date::text as start_date, end_date::text as end_date, created_at, updated_at
     from public.goals
     where user_id = $1
     order by created_at asc`,
    [userId],
  );
  return rows;
}

/** 批量播种目标（首登时使用，保留 progress 以兼容既有 seed 行为） */
export async function createGoals(
  userId: string,
  items: Array<Pick<DbGoal, "title" | "description" | "progress" | "horizon" | "status">>,
): Promise<void> {
  for (const item of items) {
    await getPool().query(
      `insert into public.goals (user_id, title, description, progress, horizon, status)
       values ($1, $2, $3, $4, $5, $6)`,
      [userId, item.title, item.description, item.progress, item.horizon, item.status],
    );
  }
}

export type CreateGoalInput = Pick<DbGoal, "title" | "description" | "horizon" | "status"> & {
  startDate?: string | null;
  endDate?: string | null;
};

/** 创建目标（业务路径不写 progress 列，默认 0） */
export async function createGoal(userId: string, input: CreateGoalInput): Promise<DbGoal> {
  const { rows } = await getPool().query<DbGoal>(
    `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
     values ($1, $2, $3, 0, $4, $5, $6::date, $7::date)
     returning id, user_id, title, description, progress, horizon, status,
               start_date::text as start_date, end_date::text as end_date, created_at, updated_at`,
    [userId, input.title, input.description, input.horizon, input.status, input.startDate ?? null, input.endDate ?? null],
  );
  return rows[0];
}

export type UpdateGoalInput = {
  title?: string;
  description?: string;
  horizon?: string;
  status?: DbGoal["status"];
  startDate?: string | null;
  endDate?: string | null;
};

/** 更新目标元数据（拒绝 progress 字段；status 白名单由 Service 层校验） */
export async function updateGoal(userId: string, goalId: string, input: UpdateGoalInput): Promise<DbGoal | null> {
  const { rows } = await getPool().query<DbGoal>(
    `update public.goals set
       title = coalesce($3, title),
       description = coalesce($4, description),
       horizon = coalesce($5, horizon),
       status = coalesce($6, status),
       start_date = coalesce($7::date, start_date),
       end_date = coalesce($8::date, end_date)
     where id = $1 and user_id = $2
     returning id, user_id, title, description, progress, horizon, status,
               start_date::text as start_date, end_date::text as end_date, created_at, updated_at`,
    [
      goalId,
      userId,
      input.title ?? null,
      input.description ?? null,
      input.horizon ?? null,
      input.status ?? null,
      input.startDate === undefined ? null : input.startDate,
      input.endDate === undefined ? null : input.endDate,
    ],
  );
  return rows[0] ?? null;
}

/** 删除目标：事务内先置空关联任务 goal_id（历史任务保留），再删目标 */
export async function deleteGoal(userId: string, goalId: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`update public.tasks set goal_id = null where goal_id = $1 and user_id = $2`, [goalId, userId]);
    const { rowCount } = await client.query(`delete from public.goals where id = $1 and user_id = $2`, [goalId, userId]);
    await client.query("commit");
    return (rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** 按 id 取单个目标（user 隔离；跨用户返回 null） */
export async function getGoal(userId: string, goalId: string): Promise<DbGoal | null> {
  const { rows } = await getPool().query<DbGoal>(
    `select id, user_id, title, description, progress, horizon, status,
            start_date::text as start_date, end_date::text as end_date, created_at, updated_at
     from public.goals
     where id = $1 and user_id = $2
     limit 1`,
    [goalId, userId],
  );
  return rows[0] ?? null;
}

/** 统计某目标下任务完成情况（派生 progress 的事实来源） */
export async function countTasksByGoal(userId: string, goalId: string): Promise<{ total: number; done: number }> {
  const { rows } = await getPool().query<{ total: string; done: string }>(
    `select count(*)::text as total,
            count(*) filter (where status = 'done')::text as done
     from public.tasks
     where user_id = $1 and goal_id = $2`,
    [userId, goalId],
  );
  const row = rows[0];
  return { total: Number(row?.total ?? 0), done: Number(row?.done ?? 0) };
}

/** 某目标下已有任务标题列表（Agent Decompose 增量拆：避免生成重复步骤） */
export async function listTaskTitlesByGoal(userId: string, goalId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ title: string }>(
    `select title from public.tasks where user_id = $1 and goal_id = $2 order by created_at asc`,
    [userId, goalId],
  );
  return rows.map((r) => r.title);
}
