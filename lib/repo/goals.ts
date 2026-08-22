import { getPool } from "./pool";
import type { DbGoal } from "./types";

export async function listGoals(userId: string): Promise<DbGoal[]> {
  const { rows } = await getPool().query<DbGoal>(
    `select * from public.goals
     where user_id = $1
     order by created_at asc`,
    [userId],
  );
  return rows;
}

/** 批量播种目标（首登时使用） */
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
