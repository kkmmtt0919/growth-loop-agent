import { getPool } from "./pool";

/**
 * Reflection 仓储层（Smart Planner Step 6a）。
 * reflection_records = 用户反馈进 Agent Loop 的唯一入口：MVP 只记录 + 查询，
 * planner prompt 注入最近 ≤3 条作「仅参考」文本（D5）；**不进 XP/coin**。
 * 所有查询显式携带 user_id。
 */

export type DbReflection = {
  id: string;
  user_id: string;
  goal_id: string | null;
  action_id: string | null;
  source: "planner" | "weekly" | "manual";
  content: string;
  rating: "good" | "bad" | null;
  created_at: string;
};

const REFLECTION_COLUMNS = `id, user_id, goal_id, action_id, source, content, rating, created_at`;

export type CreateReflectionInput = {
  goalId?: string | null;
  actionId?: string | null;
  source: DbReflection["source"];
  content: string;
  rating?: DbReflection["rating"];
};

/** 新增反馈（归属校验在 Service 层；本函数只做参数化写入） */
export async function createReflection(
  userId: string,
  input: CreateReflectionInput,
): Promise<DbReflection> {
  const { rows } = await getPool().query<DbReflection>(
    `insert into public.reflection_records (user_id, goal_id, action_id, source, content, rating)
     values ($1, $2, $3, $4, $5, $6)
     returning ${REFLECTION_COLUMNS}`,
    [userId, input.goalId ?? null, input.actionId ?? null, input.source, input.content, input.rating ?? null],
  );
  return rows[0];
}

/** 用户的反馈列表（created_at 倒序；可选按 goal 过滤；limit ≤20） */
export async function listReflections(
  userId: string,
  options?: { goalId?: string; limit?: number },
): Promise<DbReflection[]> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 20);
  if (options?.goalId) {
    const { rows } = await getPool().query<DbReflection>(
      `select ${REFLECTION_COLUMNS}
       from public.reflection_records
       where user_id = $1 and goal_id = $2
       order by created_at desc
       limit $3`,
      [userId, options.goalId, limit],
    );
    return rows;
  }
  const { rows } = await getPool().query<DbReflection>(
    `select ${REFLECTION_COLUMNS}
     from public.reflection_records
     where user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit],
  );
  return rows;
}

/** 最近 N 条反馈（Planner prompt「仅参考」注入用；D5） */
export async function listRecentReflections(userId: string, limit = 3): Promise<DbReflection[]> {
  return listReflections(userId, { limit: Math.min(limit, 3) });
}
