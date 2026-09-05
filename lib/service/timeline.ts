import {
  createSchedules,
  deleteSchedule,
  getSchedule,
  listAvailability,
  listSchedulesByDate,
  updateScheduleStatus,
  type DbSchedule,
} from "@/lib/repo/planner";
import { dateToDbWeekday } from "./planner-scheduler";
import { todayInShanghai } from "./time";
import { ServiceError } from "./errors";

/**
 * 今日时间轴服务（Smart Planner Step 4「时间语义层」）。
 * 目标（DESIGN_SMART_PLANNER_STEP4 §1）：执行视图唯一数据源 = GET /api/schedules/today，
 * 只回答「今天真正安排了什么」，不再回答「数据库里还有什么没完成」。
 *
 * TimelineItem 三条来源（§3，后端聚合、前端零拼接）：
 *   action ← schedules(source='action', date=today)
 *   manual ← schedules(source='manual',  date=today)
 *   fixed  ← user_availability(weekday=today 且 title≠'')，实例化到今天日期
 *            title='' 是可排空档，不展示。
 */

export type TimelineItemType = "action" | "manual" | "fixed";
export type TimelineStatus = "planned" | "completed";

export type TimelineItem = {
  key: string; // 前端稳定 key：schedule 用 `s:{id}`，fixed 用 `f:{id}`
  type: TimelineItemType;
  title: string;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  status: TimelineStatus; // fixed 恒为 "planned"（只读展示）
  scheduleId?: string; // action/manual 有，fixed 无
  actionId?: string | null;
  goalId?: string | null;
  source?: "action" | "manual";
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function mapSchedule(s: DbSchedule): TimelineItem {
  // DB status 含 planned/doing/completed/overdue；时间轴 MVP 只暴露 planned/completed
  // （doing/overdue 生命周期留给 Step 5）→ 非 completed 一律归一为 planned。
  return {
    key: `s:${s.id}`,
    type: s.source,
    title: s.title,
    startTime: s.start_time.slice(0, 5),
    endTime: s.end_time.slice(0, 5),
    status: s.status === "completed" ? "completed" : "planned",
    scheduleId: s.id,
    actionId: s.action_id,
    goalId: s.goal_id,
    source: s.source,
  };
}

/** 今日时间轴聚合：今日 action/manual 排程 + 今日固定块，按 start_time 排序。 */
export async function buildTodayTimeline(userId: string): Promise<{ date: string; items: TimelineItem[] }> {
  const today = todayInShanghai();
  const [scheds, avail] = await Promise.all([
    listSchedulesByDate(userId, today),
    listAvailability(userId),
  ]);

  const items: TimelineItem[] = scheds.map(mapSchedule);

  // fixed：仅 title≠'' 且 weekday 命中今天（title='' = 可排空档，不展示）
  const weekday = dateToDbWeekday(today);
  for (const a of avail) {
    if (a.title.trim() === "") continue;
    if (a.weekday !== weekday) continue;
    items.push({
      key: `f:${a.id}`,
      type: "fixed",
      title: a.title,
      startTime: a.start_time.slice(0, 5),
      endTime: a.end_time.slice(0, 5),
      status: "planned",
    });
  }

  items.sort((x, y) => {
    if (x.startTime !== y.startTime) return x.startTime < y.startTime ? -1 : 1;
    // 同刻：action/manual 保持原序，fixed 靠后（纯展示）
    if (x.type === "fixed" && y.type !== "fixed") return 1;
    if (y.type === "fixed" && x.type !== "fixed") return -1;
    return 0;
  });

  return { date: today, items };
}

/**
 * 完成 / 撤销完成某个排程时段（时间轴勾选）。
 * 语义（§6）：只记 completed_at，不推进 action.status（Step 3 验收 E 同源），不写账本/records；
 * 白名单仅 planned/completed（doing/overdue 本期不暴露）。
 */
export async function setTimelineStatus(
  userId: string,
  scheduleId: string,
  status: "planned" | "completed",
): Promise<DbSchedule> {
  if (status !== "planned" && status !== "completed") {
    throw new ServiceError("status 应为 planned 或 completed", 400);
  }
  const updated = await updateScheduleStatus(userId, scheduleId, status);
  if (!updated) throw new ServiceError("排程不存在", 404);
  return updated;
}

export type CreateManualInput = { title: string; startTime: string; endTime: string };

/** 手动添加今日事项（source='manual'，不关联 action/goal）。时间必填（表约束 end>start NOT NULL）。 */
export async function createManualSchedule(userId: string, input: CreateManualInput): Promise<DbSchedule> {
  const title = (input.title ?? "").trim();
  const start = (input.startTime ?? "").trim();
  const end = (input.endTime ?? "").trim();
  if (title.length < 1 || title.length > 200) throw new ServiceError("标题应为 1-200 字", 400);
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
    throw new ServiceError("startTime/endTime 格式应为 HH:MM", 400);
  }
  if (minutesOf(end) <= minutesOf(start)) {
    throw new ServiceError("endTime 必须晚于 startTime", 400);
  }
  const rows = await createSchedules(userId, [
    { source: "manual", date: todayInShanghai(), title, startTime: start, endTime: end },
  ]);
  return rows[0];
}

/** 删除手动事项。**action 排程不可单条删除**（保护 planned 状态机，撤销请用 plan/reset）。 */
export async function deleteManualSchedule(userId: string, scheduleId: string): Promise<void> {
  const row = await getSchedule(userId, scheduleId);
  if (!row) throw new ServiceError("排程不存在", 404);
  if (row.source !== "manual") {
    throw new ServiceError("AI 安排的排程不能单条删除，请用「撤销安排」整批撤回", 409);
  }
  const removed = await deleteSchedule(userId, scheduleId);
  if (removed === 0) throw new ServiceError("排程不存在", 404);
}
