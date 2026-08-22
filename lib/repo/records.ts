import { getPool } from "./pool";
import type { DbRecord } from "./types";

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
