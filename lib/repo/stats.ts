import { getPool } from "./pool";
import type { DbGoal } from "./types";

/**
 * 成长统计仓储层：纯 SQL 聚合（不涉及任何 AI）。
 * 所有查询显式携带 user_id；日期统一按 Asia/Shanghai 转换。
 */

/** 某用户某天（上海时区）创建的记录数 */
export async function countRecordsOnDay(userId: string, shanghaiDate: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.records
     where user_id = $1 and (occurred_at at time zone 'Asia/Shanghai')::date = $2`,
    [userId, shanghaiDate],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 某用户有记录的日期集合（上海时区，去重倒序）——streak 计算基础 */
export async function listRecordDates(userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ day: string }>(
    `select distinct (occurred_at at time zone 'Asia/Shanghai')::date::text as day
     from public.records
     where user_id = $1
     order by day desc`,
    [userId],
  );
  return rows.map((r) => r.day);
}

/** 近 N 天每日投入分钟（上海时区，按天分组；无记录的天不返回） */
export async function dailyMinutesSince(
  userId: string,
  sinceShanghaiDate: string,
): Promise<Array<{ day: string; minutes: number }>> {
  const { rows } = await getPool().query<{ day: string; minutes: string }>(
    `select (occurred_at at time zone 'Asia/Shanghai')::date::text as day, sum(minutes)::text as minutes
     from public.records
     where user_id = $1 and minutes > 0 and (occurred_at at time zone 'Asia/Shanghai')::date >= $2
     group by day
     order by day asc`,
    [userId, sinceShanghaiDate],
  );
  return rows.map((r) => ({ day: r.day, minutes: Number(r.minutes) }));
}

/**
 * 双轨每日投入分钟（V2，DESIGN_SMART_PLANNER_STEP5C §2）：records.minutes ∪ execution.actual_minutes。
 * - **新增函数不替换 V1**：V1 保留给 weekly.minutes / growth 仪表盘 / records recent（旧口径不跳动）。
 * - 消费方：planner feasibility（校准）+ AgentContext.minutes7d（晚报实际投入）。
 * - 时区正确性约束（非优化项）：occurred_at / completed_at 必须显式 `at time zone 'Asia/Shanghai'`，
 *   否则 UTC 23:30（=上海次日 07:30）会记入错误日期。
 * - **不去重（补充 B）**：union all 简单加总；records（主动反思）与 execution（执行事实）重叠按设计允许。
 * 无 execution 数据时 V2 === V1（回归护栏）。
 */
export async function dailySpentMinutesSince(
  userId: string,
  sinceShanghaiDate: string,
): Promise<Array<{ day: string; minutes: number }>> {
  const { rows } = await getPool().query<{ day: string; minutes: string }>(
    `select day, sum(minutes)::text as minutes
     from (
       select (occurred_at at time zone 'Asia/Shanghai')::date::text as day, minutes
       from public.records
       where user_id = $1 and minutes > 0
       union all
       select (completed_at at time zone 'Asia/Shanghai')::date::text as day, actual_minutes
       from public.execution_records
       where user_id = $1
     ) t
     where day >= $2
     group by day
     order by day asc`,
    [userId, sinceShanghaiDate],
  );
  return rows.map((r) => ({ day: r.day, minutes: Number(r.minutes) }));
}

/** 输入证据：有分类（kind）的记录数 */
export async function countInputEvidence(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.records where user_id = $1 and kind is not null`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 理解证据：测验通过数（score >= 阈值，与 bonus 分数线一致） */
export async function countUnderstandingEvidence(userId: string, threshold = 60): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.quiz_sessions
     where user_id = $1 and score is not null and score >= $2`,
    [userId, threshold],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 应用证据：已完成任务数 */
export async function countApplicationEvidence(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.tasks where user_id = $1 and status = 'done'`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 计划页重点目标：进行中 → 最近创建 → 前 N 个 */
export async function listFocusGoals(userId: string, limit = 3): Promise<DbGoal[]> {
  const { rows } = await getPool().query<DbGoal>(
    `select * from public.goals
     where user_id = $1 and status = '进行中'
     order by created_at desc
     limit $2`,
    [userId, limit],
  );
  return rows;
}

/** 某用户自某时间点起完成的任务数（Phase 2 Context：completed_at 口径） */
export async function countDoneTasksSince(userId: string, sinceDate: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.tasks
     where user_id = $1 and status = 'done' and completed_at is not null
       and (completed_at at time zone 'Asia/Shanghai')::date >= $2`,
    [userId, sinceDate],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 某用户今日完成的任务数（completed_at 落在今天） */
export async function countDoneTasksOnDay(userId: string, shanghaiDate: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.tasks
     where user_id = $1 and status = 'done' and completed_at is not null
       and (completed_at at time zone 'Asia/Shanghai')::date = $2`,
    [userId, shanghaiDate],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 某用户当前任务总数 */
export async function countTasks(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.tasks where user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 近 N 天每日完成任务数（一次聚合，替代 N 次 countDoneTasksOnDay；completed_at 落窗口径） */
export async function countDoneTasksPerDay(
  userId: string,
  sinceShanghaiDate: string,
): Promise<Array<{ day: string; count: number }>> {
  const { rows } = await getPool().query<{ day: string; count: string }>(
    `select (completed_at at time zone 'Asia/Shanghai')::date::text as day,
            count(*)::text as count
     from public.tasks
     where user_id = $1 and status = 'done' and completed_at is not null
       and (completed_at at time zone 'Asia/Shanghai')::date >= $2
     group by day`,
    [userId, sinceShanghaiDate],
  );
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}

/** Phase 4 新口径分母：近 N 天创建或截止的任务数（去重，OR 谓词按行计数天然不重复） */
export async function countWindowScopedTasks(userId: string, sinceShanghaiDate: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.tasks
     where user_id = $1
       and (
         (created_at at time zone 'Asia/Shanghai')::date >= $2
         or (deadline is not null and deadline >= $2::date)
       )`,
    [userId, sinceShanghaiDate],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Phase 4 新口径分子：近 N 天创建或截止的任务中已完成的数量（status='done'） */
export async function countWindowScopedDoneTasks(userId: string, sinceShanghaiDate: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.tasks
     where user_id = $1 and status = 'done'
       and (
         (created_at at time zone 'Asia/Shanghai')::date >= $2
         or (deadline is not null and deadline >= $2::date)
       )`,
    [userId, sinceShanghaiDate],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 某用户某区间（含端点，上海时区）有记录的去重天数（周活跃天数用） */
export async function countRecordDaysBetween(
  userId: string,
  startShanghaiDate: string,
  endShanghaiDate: string,
): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(distinct (occurred_at at time zone 'Asia/Shanghai')::date)::text as count
     from public.records
     where user_id = $1
       and (occurred_at at time zone 'Asia/Shanghai')::date >= $2
       and (occurred_at at time zone 'Asia/Shanghai')::date <= $3`,
    [userId, startShanghaiDate, endShanghaiDate],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 某区间（上海时区）内完成的任务按 goal_id 分组计数（周报 goalProgress.doneThisWeek 用） */
export async function countDoneTasksByGoalSince(
  userId: string,
  sinceShanghaiDate: string,
): Promise<Array<{ goal_id: string | null; count: number }>> {
  const { rows } = await getPool().query<{ goal_id: string | null; count: string }>(
    `select goal_id, count(*)::text as count
     from public.tasks
     where user_id = $1 and status = 'done' and completed_at is not null
       and (completed_at at time zone 'Asia/Shanghai')::date >= $2
     group by goal_id`,
    [userId, sinceShanghaiDate],
  );
  return rows.map((r) => ({ goal_id: r.goal_id, count: Number(r.count) }));
}
