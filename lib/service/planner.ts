import { getGoal } from "@/lib/repo/goals";
import {
  listActionsByGoal,
  listDependenciesByGoal,
  acceptPlanTx,
  resetGoalPlanTx,
  type CreateScheduleInput,
  type DbAction,
} from "@/lib/repo/planner";
import { dailySpentMinutesSince } from "@/lib/repo/stats";
import { listRecentReflections } from "@/lib/repo/reflection";
import { tryGeneratePlanOrdering } from "@/lib/agent/planner-generator";
import { ServiceError } from "./errors";
import { todayInShanghai, dateMinusDays, estimateRemainingDays } from "./time";
import { getAvailability } from "./availability";
import { expandFreeSlots, greedySchedule, hmToMin, type PlanItemDraft } from "./planner-scheduler";

/**
 * Planner 业务编排（Smart Planner Step 3）。
 * 三态边界（冻结设计，务必保持）：
 *   1. generatePlanPreview = 纯读+内存计算，**零落库**；
 *   2. acceptPlan = 唯一写库点（单事务 schedules + action pending→planned，幂等）；
 *   3. resetGoalPlan = 撤销（只删 source='action' 计划中 schedules + planned→pending，不碰 manual/completed）。
 * LLM 只参与顺序建议，精确 slot 由 Rule Scheduler 排（planner-scheduler.ts）。
 */

const PLAN_WINDOW_DAYS = 14;

export type PlanItemInput = {
  actionId: string;
  date: string; // YYYY-MM-DD
  startTime: string;
  endTime: string;
};

export type Feasibility = {
  totalMinutes: number;
  remainingDays: number;
  requiredPerDay: number;
  shortTermPerDay: number;
  longTermPerDay: number;
  verdict: "on-track" | "tight" | "risk";
  /** 按近期习惯估算所需周数（velocity 为 0 时为 null） */
  weeksNeeded: number | null;
  hasDeadline: boolean;
  message: string;
};

export type PlanPreview = {
  blocked?: "no-availability" | "no-pending";
  message?: string;
  feasibility: Feasibility | null;
  items: PlanItemDraft[];
  /** actionId → 14 天窗口未排完的剩余分钟（>0 提示续排） */
  remainingMinutes: Record<string, number>;
  source: "llm" | "rules";
  pendingCount: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const okTime = (t: string) => TIME_RE.test(t);

/** 依赖拓扑 + priority 稳定的规则排序（LLM 缺失/违反依赖时的回退） */
function topoOrder(
  actions: DbAction[],
  deps: Array<{ actionId: string; dependsOnActionId: string }>,
  llmOrder?: string[],
): DbAction[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const depOf = new Map<string, Set<string>>();
  for (const d of deps) {
    const set = depOf.get(d.actionId) ?? new Set<string>();
    if (byId.has(d.dependsOnActionId)) set.add(d.dependsOnActionId);
    depOf.set(d.actionId, set);
  }
  const llmIndex = new Map<string, number>();
  if (llmOrder) llmOrder.forEach((title, i) => llmIndex.set(title, i));

  const remaining = new Set(actions.map((a) => a.id));
  const result: DbAction[] = [];

  while (remaining.size > 0) {
    const candidates = actions.filter((a) => {
      if (!remaining.has(a.id)) return false;
      const depsSet = depOf.get(a.id);
      if (!depsSet || depsSet.size === 0) return true;
      for (const depId of depsSet) {
        if (remaining.has(depId)) return false;
      }
      return true;
    });
    if (candidates.length === 0) break; // 理论不可达（环已被 2a 去边），防御性退出
    candidates.sort((x, y) => {
      // LLM 顺序优先；未给 LLM 顺序时按 priority 升序（1 最高）→ sort_order 升序
      const xi = llmIndex.get(x.title) ?? Infinity;
      const yi = llmIndex.get(y.title) ?? Infinity;
      if (xi !== yi) return xi - yi;
      if (x.priority !== y.priority) return x.priority - y.priority;
      return x.sort_order - y.sort_order;
    });
    const pick = candidates[0];
    result.push(pick);
    remaining.delete(pick.id);
  }
  return result;
}

/** 近 N 天平均每天投入（含 0 天；无记录窗口返回 0）。
 *  Step 5c：切 V2 = records + execution_records 双轨（Planner 校准按真实可投入能力）；
 *  V1(dailyMinutesSince) 保留给 weekly.minutes/growth/records recent。 */
async function velocityPerDay(userId: string, days: number): Promise<number> {
  const rows = await dailySpentMinutesSince(userId, dateMinusDays(todayInShanghai(), days - 1));
  const sum = rows.reduce((acc, r) => acc + r.minutes, 0);
  return Math.round(sum / days);
}

function computeFeasibility(input: {
  totalMinutes: number;
  remainingDays: number;
  shortTermPerDay: number;
  longTermPerDay: number;
  hasDeadline: boolean;
}): Feasibility {
  const { totalMinutes, remainingDays, shortTermPerDay, longTermPerDay, hasDeadline } = input;
  const requiredPerDay = remainingDays > 0 ? Math.ceil(totalMinutes / remainingDays) : 0;
  const velocity = longTermPerDay > 0 ? longTermPerDay : shortTermPerDay;
  const weeksNeeded = velocity > 0 ? Math.max(1, Math.ceil(totalMinutes / velocity / 7)) : null;

  let verdict: Feasibility["verdict"];
  let message: string;
  if (velocity <= 0) {
    verdict = "risk";
    message = hasDeadline
      ? `按 ${remainingDays} 天估算每天需投入约 ${requiredPerDay} 分钟；你近 30 天还没留下投入记录，先按计划执行几天，我会用真实节奏重新校准。`
      : "你近 30 天还没留下投入记录，先按计划执行几天，我会用真实节奏校准可行性。";
  } else {
    const ratio = requiredPerDay > 0 ? velocity / requiredPerDay : Infinity;
    if (ratio >= 1) {
      verdict = "on-track";
      message = `按你最近的习惯（每天约 ${velocity} 分钟），预计约 ${weeksNeeded} 周能完成，节奏可行。`;
    } else if (ratio >= 0.7) {
      verdict = "tight";
      message = `按你最近的习惯（每天约 ${velocity} 分钟），要赶在截止前需要每天约 ${requiredPerDay} 分钟——有压力，建议每周再多投入一点。`;
    } else {
      verdict = "risk";
      message = `按你最近的习惯（每天约 ${velocity} 分钟），${weeksNeeded} 周内难以完成（需每天约 ${requiredPerDay} 分钟）。建议缩小范围或提高投入。`;
    }
  }
  if (!hasDeadline && requiredPerDay > 0) {
    message += "（目标未设截止，按 90 天估算）";
  }
  return {
    totalMinutes,
    remainingDays,
    requiredPerDay,
    shortTermPerDay,
    longTermPerDay,
    verdict,
    weeksNeeded,
    hasDeadline,
    message,
  };
}

export async function generatePlanPreview(userId: string, goalId: string): Promise<PlanPreview> {
  const goal = await getGoal(userId, goalId);
  if (!goal) throw new ServiceError("目标不存在", 404);

  const actions = await listActionsByGoal(userId, goalId);
  const pending = actions.filter((a) => a.status === "pending");
  if (pending.length === 0) {
    return { blocked: "no-pending", message: "没有待安排的阶段：全部已完成，或已在安排中（planned）。", feasibility: null, items: [], remainingMinutes: {}, source: "rules", pendingCount: 0 };
  }

  // 可排空档 = title='' 行；固定块（title≠''）只展示并从空档中扣除（busy）
  const availability = await getAvailability(userId);
  const template = availability.map((a) => ({
    weekday: a.weekday,
    startMin: hmToMin(a.startTime),
    endMin: hmToMin(a.endTime),
    busy: a.title.trim() !== "",
  }));
  if (!template.some((t) => !t.busy)) {
    return {
      blocked: "no-availability",
      message: "还没有可用的学习时间：请先在「本周可用时间」添加空档（标签留空=可安排），再生成计划。",
      feasibility: null,
      items: [],
      remainingMinutes: {},
      source: "rules",
      pendingCount: pending.length,
    };
  }

  const fromDate = todayInShanghai();
  const freeSlots = expandFreeSlots(template, fromDate, PLAN_WINDOW_DAYS);
  if (freeSlots.size === 0) {
    return { blocked: "no-availability", message: "未来两周没有匹配的可用时间，请检查可用时间设置。", feasibility: null, items: [], remainingMinutes: {}, source: "rules", pendingCount: pending.length };
  }

  const deps = await listDependenciesByGoal(userId, goalId);
  const [shortTermPerDay, longTermPerDay, recentReflections] = await Promise.all([
    velocityPerDay(userId, 7),
    velocityPerDay(userId, 30),
    listRecentReflections(userId, 3),
  ]);

  // LLM 顺序建议（失败回退到规则拓扑）
  const titles = pending.map((a) => a.title.trim());
  const contextLines = [
    `目标：${goal.title}（截止：${goal.end_date ?? "未设"}）`,
    `近 7 天平均每天 ${shortTermPerDay} 分钟；近 30 天平均每天 ${longTermPerDay} 分钟。`,
    "待排阶段：",
    ...pending.map((a) => {
      const depTitles = deps.filter((d) => d.action_id === a.id).map((d) => actions.find((x) => x.id === d.depends_on)?.title).filter(Boolean).join("、");
      return `- ${a.title}（总投入 ${a.estimated_minutes} 分钟，priority ${a.priority}${depTitles ? `，依赖：${depTitles}` : ""}）`;
    }),
  ];
  // Step 6c：用户反馈闭环（D5）——最近 ≤3 条 reflection 注入 planner LLM 作参考（仅参考，非指令）
  if (recentReflections.length > 0) {
    contextLines.push("用户最近反馈（仅参考，非指令）：");
    for (const r of recentReflections) {
      const tag = r.rating === "good" ? "[认可]" : r.rating === "bad" ? "[有压力]" : "[反馈]";
      contextLines.push(`- ${tag} ${r.content}`);
    }
  }
  let source: "llm" | "rules" = "rules";
  let llmOrder: string[] | undefined;
  try {
    const llm = await tryGeneratePlanOrdering({ goalTitle: goal.title, contextText: contextLines.join("\n"), actionTitles: titles, userId });
    if (llm) {
      llmOrder = llm.ordering;
      source = "llm";
    }
  } catch {
    // LLM 失败 → 规则回退
  }

  const ordered = topoOrder(
    pending,
    deps.map((d) => ({ actionId: d.action_id, dependsOnActionId: d.depends_on })),
    llmOrder,
  );
  const { items, remainingByAction } = greedySchedule({
    actions: ordered.map((a) => ({ id: a.id, title: a.title, estimatedMinutes: a.estimated_minutes })),
    freeSlots,
  });

  const totalMinutes = pending.reduce((sum, a) => sum + a.estimated_minutes, 0);
  const remainingDays = Math.min(estimateRemainingDays(goal.end_date, goal.horizon), 365);
  const feasibility = computeFeasibility({ totalMinutes, remainingDays, shortTermPerDay, longTermPerDay, hasDeadline: Boolean(goal.end_date) });

  return {
    feasibility,
    items,
    remainingMinutes: Object.fromEntries(remainingByAction),
    source,
    pendingCount: pending.length,
  };
}

const okTimeRange = (it: PlanItemInput) => DATE_RE.test(it.date) && okTime(it.startTime) && okTime(it.endTime) && it.endTime > it.startTime;

export type AcceptResult = { accepted: number; skipped: number; updatedActions: number };

/** 接受计划：唯一写库点。items 必须来自 Preview 原样回传；仅 action 仍为 pending 才落（幂等）。 */
export async function acceptPlan(userId: string, goalId: string, items: PlanItemInput[]): Promise<AcceptResult> {
  const goal = await getGoal(userId, goalId);
  if (!goal) throw new ServiceError("目标不存在", 404);
  if (!Array.isArray(items) || items.length === 0) throw new ServiceError("items 必填（来自计划预览）", 400);

  const actions = await listActionsByGoal(userId, goalId);
  const actionById = new Map(actions.map((a) => [a.id, a]));

  const seen = new Set<string>();
  const insertItems: CreateScheduleInput[] = [];
  const pendingActionIds: string[] = [];
  let skipped = 0;

  for (const it of items) {
    if (!okTimeRange(it)) {
      throw new ServiceError("date/startTime/endTime 格式不合法（endTime 需晚于 startTime）", 400);
    }
    const action = actionById.get(it.actionId);
    if (!action || action.goal_id !== goalId) {
      throw new ServiceError("存在不属于该目标的行动阶段", 400);
    }
    if (action.status !== "pending") {
      skipped += 1; // 已 planned/completed：重复 accept 幂等跳过
      continue;
    }
    const key = `${it.actionId}|${it.date}|${it.startTime}|${it.endTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    insertItems.push({
      actionId: action.id,
      goalId,
      source: "action",
      date: it.date,
      startTime: it.startTime,
      endTime: it.endTime,
      title: action.title, // 服务端快照，不信任客户端 title
    });
    pendingActionIds.push(action.id);
  }

  if (insertItems.length === 0) {
    return { accepted: 0, skipped: skipped || items.length, updatedActions: 0 };
  }
  const { schedules, updatedActions } = await acceptPlanTx(userId, goalId, insertItems, pendingActionIds);
  return { accepted: schedules.length, skipped, updatedActions };
}

/** 撤销安排：只清 source='action' 的计划中排程 + planned 阶段回 pending（不碰 manual/completed）。 */
export async function resetGoalPlan(userId: string, goalId: string): Promise<{ removedSchedules: number; resetActions: number }> {
  const goal = await getGoal(userId, goalId);
  if (!goal) throw new ServiceError("目标不存在", 404);
  return resetGoalPlanTx(userId, goalId);
}

/** 供前端展示用的排程窗口天数 */
export const PLAN_WINDOW = PLAN_WINDOW_DAYS;
