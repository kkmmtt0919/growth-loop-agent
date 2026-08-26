import { getPool } from "./pool";
import type { DbRecord, Mood } from "./types";

export type NewRecordInput = {
  userId: string;
  topic: string;
  text: string;
  kind?: DbRecord["kind"] | null;
  minutes?: number | null;
  output?: string | null;
  intent?: DbRecord["intent"];
  evidence?: DbRecord["evidence"] | null;
  xp?: number;
  coin?: number;
  mode?: DbRecord["mode"];
  occurredAt?: string;
};

/** 创建记录（不含入账——入账走 ledger.applyLedger，职责分离） */
export async function createRecord(input: NewRecordInput): Promise<DbRecord> {
  const { rows } = await getPool().query<DbRecord>(
    `insert into public.records
       (user_id, topic, text, kind, minutes, output, intent, evidence, xp, coin, mode, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning *`,
    [
      input.userId,
      input.topic,
      input.text,
      input.kind ?? null,
      input.minutes ?? null,
      input.output ?? null,
      input.intent ?? "quick_log",
      input.evidence ?? null,
      input.xp ?? 3,
      input.coin ?? 1,
      input.mode ?? "demo",
      input.occurredAt ?? new Date().toISOString(),
    ],
  );
  return rows[0];
}

export async function updateRecord(
  userId: string,
  recordId: string,
  patch: Partial<Pick<DbRecord, "topic" | "kind" | "minutes" | "output" | "intent" | "mode">>,
): Promise<DbRecord | null> {
  const current = patch;
  const { rows } = await getPool().query<DbRecord>(
    `update public.records set
       topic = coalesce($3, topic),
       kind = coalesce($4, kind),
       minutes = coalesce($5, minutes),
       output = coalesce($6, output),
       intent = coalesce($7, intent),
       mode = coalesce($8, mode)
     where id = $1 and user_id = $2
     returning *`,
    [
      recordId,
      userId,
      current.topic ?? null,
      current.kind ?? null,
      current.minutes ?? null,
      current.output ?? null,
      current.intent ?? null,
      current.mode ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function listRecords(userId: string, limit = 100): Promise<DbRecord[]> {
  const { rows } = await getPool().query<DbRecord>(
    `select * from public.records
     where user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit],
  );
  return rows;
}

/** 某用户某天（上海时区 YYYY-MM-DD）的记录，occurred_at asc */
export async function listRecordsOnDay(userId: string, day: string): Promise<DbRecord[]> {
  const { rows } = await getPool().query<DbRecord>(
    `select * from public.records
     where user_id = $1 and (occurred_at at time zone 'Asia/Shanghai')::date = $2
     order by occurred_at asc`,
    [userId, day],
  );
  return rows;
}

/** 某用户区间记录（上海时区，from/to 为 YYYY-MM-DD），行带 shanghai_day 分组键，occurred_at asc */
export async function listRecordsBetween(
  userId: string,
  from: string,
  to: string,
): Promise<(DbRecord & { shanghai_day: string })[]> {
  const { rows } = await getPool().query<DbRecord & { shanghai_day: string }>(
    `select *, (occurred_at at time zone 'Asia/Shanghai')::date::text as shanghai_day
     from public.records
     where user_id = $1
       and (occurred_at at time zone 'Asia/Shanghai')::date >= $2
       and (occurred_at at time zone 'Asia/Shanghai')::date <= $3
     order by occurred_at asc`,
    [userId, from, to],
  );
  return rows;
}

export type RecordsQuery = {
  from?: string; // YYYY-MM-DD（上海时区口径）
  to?: string; // YYYY-MM-DD
  mood?: Mood | null;
  limit: number;
  offset: number;
};

export type RecordsQueryResult = {
  rows: (DbRecord & { total: string })[];
};

/** 分页+筛选查询（无 kind 参数；单条 SQL 用 count(*) over() 带总数） */
export async function queryRecords(userId: string, q: RecordsQuery): Promise<RecordsQueryResult> {
  const { rows } = await getPool().query<DbRecord & { total: string }>(
    `select r.*, count(*) over()::text as total
     from public.records r
     where r.user_id = $1
       and (r.occurred_at at time zone 'Asia/Shanghai')::date >= coalesce($2::date, '1970-01-01')
       and (r.occurred_at at time zone 'Asia/Shanghai')::date <= coalesce($3::date, '9999-12-31')
       and (r.mood = $4 or $4 is null)
     order by r.occurred_at desc, r.id desc
     limit $5 offset $6`,
    [userId, q.from ?? null, q.to ?? null, q.mood ?? null, q.limit, q.offset],
  );
  return { rows };
}

export type RecordPatch = { mood?: Mood | null; remark?: string | null };

/** 动态白名单更新 mood/remark（只 SET 提供的 key，显式 null = 清除；id+user_id 双条件防越权） */
export async function patchRecordFields(
  userId: string,
  recordId: string,
  patch: RecordPatch,
): Promise<DbRecord | null> {
  const sets: string[] = [];
  const values: (string | null)[] = [recordId, userId]; // $1=id, $2=user_id
  let idx = 3;
  if ("mood" in patch) {
    sets.push(`mood = $${idx}`);
    values.push(patch.mood ?? null);
    idx++;
  }
  if ("remark" in patch) {
    sets.push(`remark = $${idx}`);
    values.push(patch.remark ?? null);
    idx++;
  }
  if (sets.length === 0) return null;
  const { rows } = await getPool().query<DbRecord>(
    `update public.records set ${sets.join(", ")}
     where id = $1 and user_id = $2
     returning *`,
    values,
  );
  return rows[0] ?? null;
}
