import { getPool } from "./pool";
import type { DbWeeklyReport } from "./types";

/**
 * 周成长报告仓储层（Phase 5）。
 * 幂等根基：UNIQUE(user_id, period_start) + ON CONFLICT，数据库层保证一周一份，
 * 并发双请求也只会存在一行（后写覆盖先写，LLM 可能被调多次但数据不重复）。
 */

export type UpsertWeeklyReportInput = {
  userId: string;
  periodStart: string; // YYYY-MM-DD（周一）
  periodEnd: string;   // YYYY-MM-DD（周日）
  summary: string;
  sourceCount: number;
  content: Record<string, unknown>;
};

/**
 * 幂等写入本周报。
 * 返回 { report, inserted }：inserted=true 表示本次新建，false 表示已存在（覆盖更新）。
 * inserted 由 SQL 侧 (xmax = 0) 计算（新插入行为 true），避免客户端二次解析系统列。
 */
export async function upsertWeeklyReport(
  input: UpsertWeeklyReportInput,
): Promise<{ report: DbWeeklyReport; inserted: boolean }> {
  const { rows } = await getPool().query<DbWeeklyReport & { inserted: boolean }>(
    `insert into public.weekly_reports (user_id, period_start, period_end, summary, content, source_count, generated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (user_id, period_start)
     do update set
       period_end = excluded.period_end,
       summary = excluded.summary,
       content = excluded.content,
       source_count = excluded.source_count,
       generated_at = now()
     returning id, user_id, period_start::text as period_start, period_end::text as period_end,
             summary, content, source_count, created_at, generated_at, (xmax = 0) as inserted`,
    [
      input.userId,
      input.periodStart,
      input.periodEnd,
      input.summary,
      JSON.stringify(input.content),
      input.sourceCount,
    ],
  );
  const row = rows[0];
  const { inserted, ...report } = row;
  return { report, inserted };
}

/** 查询某用户某周（period_start）的周报（不存在返回 null） */
export async function getWeeklyReportByPeriod(
  userId: string,
  periodStart: string,
): Promise<DbWeeklyReport | null> {
  const { rows } = await getPool().query<DbWeeklyReport>(
    `select id, user_id, period_start::text as period_start, period_end::text as period_end,
            summary, content, source_count, created_at, generated_at
     from public.weekly_reports
     where user_id = $1 and period_start = $2
     limit 1`,
    [userId, periodStart],
  );
  return rows[0] ?? null;
}

/** 历史周报分页（倒序，含 content）；limit/offset 由调用方校验 */
export async function listWeeklyReports(
  userId: string,
  limit: number,
  offset: number,
): Promise<DbWeeklyReport[]> {
  const { rows } = await getPool().query<DbWeeklyReport>(
    `select id, user_id, period_start::text as period_start, period_end::text as period_end,
            summary, content, source_count, created_at, generated_at
     from public.weekly_reports
     where user_id = $1
     order by period_start desc
     limit $2 offset $3`,
    [userId, limit, offset],
  );
  return rows;
}

/** 历史周报总数（分页元数据） */
export async function countWeeklyReports(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from public.weekly_reports where user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}
