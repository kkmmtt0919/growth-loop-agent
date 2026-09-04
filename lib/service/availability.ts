import { listAvailability, replaceAvailability, type DbAvailability } from "@/lib/repo/planner";
import { ServiceError } from "./errors";

/**
 * 用户固定时间服务（Smart Planner Step 3「本周可用时间」）。
 * 字段语义（DESIGN_SMART_PLANNER_STEP3 §0.1，用户定稿，务必保持）：
 *   title=''  → 可用于 Planner 安排的自由时间（可排空档）
 *   title≠''  → 固定时间块（上课/会议/运动），Planner 不可占用，仅展示
 */

export type AvailabilityItem = {
  weekday: number; // 0=周一 … 6=周日
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  type: DbAvailability["type"];
  title: string;
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TYPE_SET = new Set<DbAvailability["type"]>(["learn", "work", "exercise", "life", "rest"]);

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export async function getAvailability(userId: string): Promise<AvailabilityItem[]> {
  const rows = await listAvailability(userId);
  return rows.map((r) => ({
    weekday: r.weekday,
    startTime: r.start_time.slice(0, 5),
    endTime: r.end_time.slice(0, 5),
    type: r.type,
    title: r.title,
  }));
}

/** 保存（整组替换）。校验：weekday 0-6、HH:MM 合法、end > start、type 白名单、title ≤40。 */
export async function saveAvailability(userId: string, items: AvailabilityItem[]): Promise<AvailabilityItem[]> {
  if (items.length > 50) throw new ServiceError("可用时间段最多 50 条", 400);
  const cleaned: Array<{ weekday: number; startTime: string; endTime: string; type: DbAvailability["type"]; title: string }> = [];
  for (const it of items) {
    if (!Number.isInteger(it.weekday) || it.weekday < 0 || it.weekday > 6) {
      throw new ServiceError("weekday 应为 0-6（0=周一 … 6=周日）", 400);
    }
    const start = it.startTime?.trim() ?? "";
    const end = it.endTime?.trim() ?? "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      throw new ServiceError(`时间格式应为 HH:MM（收到 ${start}-${end}）`, 400);
    }
    if (minutesOf(end) <= minutesOf(start)) {
      throw new ServiceError("endTime 必须晚于 startTime", 400);
    }
    const type = (it.type ?? "learn") as DbAvailability["type"];
    if (!TYPE_SET.has(type)) throw new ServiceError(`type 应为 ${[...TYPE_SET].join("/")}`, 400);
    const title = (it.title ?? "").trim();
    if (title.length > 40) throw new ServiceError("title 最多 40 字", 400);
    cleaned.push({ weekday: it.weekday, startTime: start, endTime: end, type, title });
  }
  const saved = await replaceAvailability(userId, cleaned);
  return saved.map((r) => ({
    weekday: r.weekday,
    startTime: r.start_time.slice(0, 5),
    endTime: r.end_time.slice(0, 5),
    type: r.type,
    title: r.title,
  }));
}
