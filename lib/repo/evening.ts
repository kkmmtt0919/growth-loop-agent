import { getPool } from "./pool";
import type { DbRecord } from "./types";

/**
 * 每日晚间晚报仓储层。
 * 幂等根基：UNIQUE(user_id, report_date) + ON CONFLICT，数据库层保证一天一份，
 * 并发双请求也只会存在一行（后写覆盖先写，LLM 可能被调多次但数据不重复）。
 */

export type DbEveningReport = {
  id: string;
  user_id: string;
  report_date: string; // YYYY-MM-DD（服务端按 Asia/Shanghai 计算）
  summary: string;
  questions: unknown;
  source_count: number;
  created_at: string;
  generated_at: string;
};

export type UpsertEveningReportInput = {
  userId: string;
  reportDate: string;
  summary: string;
  questions: unknown;
  sourceCount: number;
};

/** 查询某用户某天的记录（occurred_at 按 Asia/Shanghai 转换后匹配日期） */
export async function listRecordsByDate(userId: string, reportDate: string): Promise<DbRecord[]> {
  const { rows } = await getPool().query<DbRecord>(
    `select * from public.records
     where user_id = $1 and (occurred_at at time zone 'Asia/Shanghai')::date = $2
     order by occurred_at asc`,
    [userId, reportDate],
  );
  return rows;
}

/**
 * 幂等写入当天晚报。
 * 返回 { report, inserted }：inserted=true 表示本次新建，false 表示已存在（覆盖更新）。
 * inserted 由 SQL 侧 (xmax = 0) 计算（新插入行为 true），避免客户端二次解析系统列。
 */
export async function upsertTodayReport(
  input: UpsertEveningReportInput,
): Promise<{ report: DbEveningReport; inserted: boolean }> {
  const { rows } = await getPool().query<DbEveningReport & { inserted: boolean }>(
    `insert into public.evening_reports (user_id, report_date, summary, questions, source_count, generated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (user_id, report_date)
     do update set
       summary = excluded.summary,
       questions = excluded.questions,
       source_count = excluded.source_count,
       generated_at = now()
     returning id, user_id, report_date::text as report_date, summary, questions, source_count, created_at, generated_at, (xmax = 0) as inserted`,
    [input.userId, input.reportDate, input.summary, JSON.stringify(input.questions), input.sourceCount],
  );
  const row = rows[0];
  const { inserted, ...report } = row;
  return { report, inserted };
}

/** 查询某用户某天的晚报（不存在返回 null） */
export async function getReportByDate(userId: string, reportDate: string): Promise<DbEveningReport | null> {
  const { rows } = await getPool().query<DbEveningReport>(
    `select id, user_id, report_date::text as report_date, summary, questions, source_count, created_at, generated_at
     from public.evening_reports
     where user_id = $1 and report_date = $2
     limit 1`,
    [userId, reportDate],
  );
  return rows[0] ?? null;
}
