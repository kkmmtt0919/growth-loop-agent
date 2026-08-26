/**
 * 记录查询业务服务（Phase 4）。
 * 职责：把 Repo 层的行查询组装成 API 可消费的结构（camelCase），校验收在此处（400 抛 ServiceError）。
 * 口径：
 *   - today.completionRate 沿用 Phase 2（今日完成 / 全部任务，all-time 分母）—— 不动 Phase 2 context。
 *   - recent.weeklyCompletionRate 用新口径（窗口内创建或截止的任务分母），与 Phase 2 completionRate7d 并存。
 * 多用户隔离：所有函数显式 userId；patch 用 id + user_id 双条件（跨用户 404）。
 */
import {
  listRecordsOnDay,
  listRecordsBetween,
  queryRecords,
  patchRecordFields,
  type RecordPatch,
} from "@/lib/repo/records";
import {
  countDoneTasksOnDay,
  countTasks,
  dailyMinutesSince,
  countDoneTasksPerDay,
  countWindowScopedTasks,
  countWindowScopedDoneTasks,
} from "@/lib/repo/stats";
import { todayInShanghai, dateMinusDays } from "./time";
import { ServiceError } from "./errors";
import type { DbRecord, Mood } from "@/lib/repo/types";

const MOOD_VALUES: Mood[] = ["great", "good", "normal", "bad", "terrible"];

/** API 统一记录形状（camelCase，前端直用） */
export type RecordItem = {
  id: string;
  text: string;
  topic: string;
  kind: DbRecord["kind"];
  minutes: number | null;
  output: string | null;
  mood: Mood | null;
  remark: string | null;
  intent: DbRecord["intent"];
  evidence: DbRecord["evidence"];
  xp: number;
  coin: number;
  mode: DbRecord["mode"];
  occurredAt: string;
  createdAt: string;
};

function dbRecordToItem(r: DbRecord): RecordItem {
  return {
    id: r.id,
    text: r.text,
    topic: r.topic,
    kind: r.kind,
    minutes: r.minutes,
    output: r.output,
    mood: r.mood,
    remark: r.remark,
    intent: r.intent,
    evidence: r.evidence,
    xp: r.xp,
    coin: r.coin,
    mode: r.mode,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
  };
}

/** 日期标签：今天/昨天/周X（服务端计算，避免前端时区/语言差异） */
function dayLabel(dateStr: string, today: string): string {
  if (dateStr === today) return "今天";
  if (dateStr === dateMinusDays(today, 1)) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${dateStr}T00:00:00Z`));
}

// ------------------------------------------------------------------
// GET /api/records/today
// ------------------------------------------------------------------
export type TodayRecordsResult = {
  items: RecordItem[];
  tasksDone: number;
  tasksTotal: number;
  /** 今日完成率（沿用 Phase 2 口径：今日完成 / max(1, 全部任务) * 100） */
  completionRate: number;
};

export async function listTodayRecords(userId: string): Promise<TodayRecordsResult> {
  const today = todayInShanghai();
  const [rows, tasksDone, tasksTotal] = await Promise.all([
    listRecordsOnDay(userId, today),
    countDoneTasksOnDay(userId, today),
    countTasks(userId),
  ]);
  return {
    items: rows.map(dbRecordToItem),
    tasksDone,
    tasksTotal,
    completionRate: tasksTotal === 0 ? 0 : Math.round((tasksDone / Math.max(1, tasksTotal)) * 100),
  };
}

// ------------------------------------------------------------------
// GET /api/records/history
// ------------------------------------------------------------------
export type HistoryQuery = {
  from?: string; // YYYY-MM-DD（上海时区口径）
  to?: string; // YYYY-MM-DD
  mood?: Mood | null;
  limit?: number;
  offset?: number;
};

export type HistoryRecordsResult = {
  items: RecordItem[];
  total: number;
  hasMore: boolean;
  offset: number;
};

export async function listHistoryRecords(userId: string, q: HistoryQuery): Promise<HistoryRecordsResult> {
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ServiceError("limit 须在 1-200", 400);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ServiceError("offset 须 >= 0", 400);
  }
  if (q.from && !/^\d{4}-\d{2}-\d{2}$/.test(q.from)) throw new ServiceError("from 格式非法（须 YYYY-MM-DD）", 400);
  if (q.to && !/^\d{4}-\d{2}-\d{2}$/.test(q.to)) throw new ServiceError("to 格式非法（须 YYYY-MM-DD）", 400);
  if (q.from && q.to && q.from > q.to) throw new ServiceError("from 不能晚于 to", 400);
  if (q.mood !== undefined && q.mood !== null && !MOOD_VALUES.includes(q.mood)) {
    throw new ServiceError("mood 非法枚举", 400);
  }

  const { rows } = await queryRecords(userId, {
    from: q.from,
    to: q.to,
    mood: q.mood ?? null,
    limit,
    offset,
  });
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return {
    items: rows.map(dbRecordToItem),
    total,
    hasMore: offset + rows.length < total,
    offset,
  };
}

// ------------------------------------------------------------------
// GET /api/records/recent?days=7
// ------------------------------------------------------------------
export type RecentDay = {
  date: string;
  label: string;
  records: RecordItem[];
  tasksDone: number;
  minutes: number;
};

export type RecentRecordsResult = {
  days: RecentDay[];
  /** 近 N 天完成的任务总数（与 Phase 2 countDoneTasksSince 同口径） */
  doneTasks7d: number;
  /** 新口径完成率：窗口内创建或截止的任务中已完成比例（不随总任务数膨胀） */
  weeklyCompletionRate: number;
  activeDays: number;
  totalMinutes7d: number;
};

export async function listRecentRecords(userId: string, days = 7): Promise<RecentRecordsResult> {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new ServiceError("days 须在 1-90", 400);
  }
  const today = todayInShanghai();
  const since = dateMinusDays(today, days - 1);

  const [records, donePerDay, minutesRows, windowScoped, windowDone] = await Promise.all([
    listRecordsBetween(userId, since, today),
    countDoneTasksPerDay(userId, since),
    dailyMinutesSince(userId, since),
    countWindowScopedTasks(userId, since),
    countWindowScopedDoneTasks(userId, since),
  ]);

  const doneMap = new Map(donePerDay.map((d) => [d.day, d.count]));
  const minutesMap = new Map(minutesRows.map((m) => [m.day, m.minutes]));
  const recordsByDay = new Map<string, DbRecord[]>();
  for (const r of records) {
    const arr = recordsByDay.get(r.shanghai_day) ?? [];
    arr.push(r);
    recordsByDay.set(r.shanghai_day, arr);
  }

  const daysArr: RecentDay[] = [];
  let activeDays = 0;
  let totalMinutes7d = 0;
  let doneTasks7d = 0;
  for (let i = 0; i < days; i++) {
    const date = dateMinusDays(today, i);
    const dayRecords = recordsByDay.get(date) ?? [];
    const tasksDone = doneMap.get(date) ?? 0;
    const minutes = minutesMap.get(date) ?? 0;
    if (dayRecords.length > 0) activeDays++;
    totalMinutes7d += minutes;
    doneTasks7d += tasksDone;
    daysArr.push({
      date,
      label: dayLabel(date, today),
      records: dayRecords.map(dbRecordToItem),
      tasksDone,
      minutes,
    });
  }

  const weeklyCompletionRate =
    windowScoped === 0 ? 0 : Math.round((windowDone / Math.max(1, windowScoped)) * 100);

  return { days: daysArr, doneTasks7d, weeklyCompletionRate, activeDays, totalMinutes7d };
}

// ------------------------------------------------------------------
// PATCH /api/records/[id]
// ------------------------------------------------------------------
export async function patchRecord(
  userId: string,
  recordId: string,
  patch: RecordPatch,
): Promise<RecordItem> {
  if (!("mood" in patch) && !("remark" in patch)) {
    throw new ServiceError("须提供 mood 或 remark 至少其一", 400);
  }
  if ("mood" in patch && patch.mood != null && !MOOD_VALUES.includes(patch.mood)) {
    throw new ServiceError("mood 非法枚举", 400);
  }
  if ("remark" in patch && patch.remark != null && patch.remark.length > 500) {
    throw new ServiceError("remark 超过 500 字符", 400);
  }

  const updated = await patchRecordFields(userId, recordId, patch);
  if (!updated) throw new ServiceError("记录不存在", 404);
  return dbRecordToItem(updated);
}
