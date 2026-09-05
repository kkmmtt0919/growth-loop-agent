import {
  buildWeeklyContent,
  generateWeeklyDigest,
  isValidGoalSuggestion,
  type WeeklyContent,
  type WeeklyStats,
} from "@/lib/agent/weekly-generator";
import { hasMeaningfulContext } from "@/lib/agent/core/pure";
import {
  countDoneTasksByGoalSince,
  countDoneTasksSince,
  countRecordDaysBetween,
  countWindowScopedDoneTasks,
  countWindowScopedTasks,
  dailyMinutesSince,
  listRecordDates,
} from "@/lib/repo/stats";
import { getWeeklyReportByPeriod, listWeeklyReports, upsertWeeklyReport, countWeeklyReports } from "@/lib/repo/weekly";
import { countTasksByGoal, getGoal, listGoals } from "@/lib/repo/goals";
import { sumScheduleMinutesBetween } from "@/lib/repo/planner";
import { sumExecutionMinutesBetween } from "@/lib/repo/execution";
import type { DbGoal } from "@/lib/repo/types";
import { GOAL_STATUS } from "./goals";
import { computeStreak } from "./stats";
import { dateMinusDays, todayInShanghai, weekEndOf, weekStartOf } from "./time";

/**
 * 周成长报告业务服务（Phase 5）。
 * 生成链路：buildWeeklyContext 的规则统计 → weeklyContextToText → generateWeeklyDigest（LLM，失败规则回退）
 *           → 组装 content（stats 永远用规则值）→ 幂等落库。
 * 幂等：UNIQUE(user_id, period_start)，重复/并发生成只有一行。
 */

export type WeeklyContext = {
  periodStart: string;
  periodEnd: string;
  activeGoals: Array<{ goal: DbGoal; progress: number; doneThisWeek: number }>;
};

async function deriveGoalProgress(goal: DbGoal): Promise<{ progress: number }> {
  const { total, done } = await countTasksByGoal(goal.user_id, goal.id);
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  return { progress };
}

/** 规则统计：本周 + 环比上周窗口，全部纯 SQL 聚合 */
async function computeWeeklyStats(
  userId: string,
  periodStart: string,
  periodEnd: string,
  recordDates: string[],
  today: string,
): Promise<WeeklyStats> {
  const prevStart = dateMinusDays(periodStart, 7);
  const prevEnd = dateMinusDays(periodStart, 1);

  const [
    activeDays,
    prevActiveDays,
    minutesRows,
    prevMinutesRows,
    doneTasks,
    prevDoneTasks,
    windowTotal,
    prevWindowTotal,
    windowDone,
    prevWindowDone,
    goalIds,
    planMinutes,
    actualMinutes,
  ] = await Promise.all([
    countRecordDaysBetween(userId, periodStart, periodEnd),
    countRecordDaysBetween(userId, prevStart, prevEnd),
    dailyMinutesSince(userId, periodStart),
    dailyMinutesSince(userId, prevStart),
    countDoneTasksSince(userId, periodStart),
    countDoneTasksSince(userId, prevStart),
    countWindowScopedTasks(userId, periodStart),
    countWindowScopedTasks(userId, prevStart),
    countWindowScopedDoneTasks(userId, periodStart),
    countWindowScopedDoneTasks(userId, prevStart),
    listGoals(userId),
    // Step 5c：排程执行维度（平行扩展；计划=排了就算，分母固定 schedule 时长）
    sumScheduleMinutesBetween(userId, periodStart, periodEnd),
    sumExecutionMinutesBetween(userId, periodStart, periodEnd),
  ]);

  const recordCount = activeDays; // activeDays = 区间内有记录的去重天数
  const prevRecordCount = prevActiveDays;
  const minutes = minutesRows.reduce((sum, r) => sum + r.minutes, 0);
  const prevMinutes = prevMinutesRows.reduce((sum, r) => sum + r.minutes, 0);
  const completionRate = windowTotal === 0 ? 0 : Math.round((windowDone / windowTotal) * 100);
  const prevCompletionRate = prevWindowTotal === 0 ? 0 : Math.round((prevWindowDone / prevWindowTotal) * 100);
  // Step 5c：执行率 = round(actual/plan*100)；plan=0 → null（本周无排程，绝不显示 0%）
  const executionRate = planMinutes === 0 ? null : Math.round((actualMinutes / planMinutes) * 100);

  const activeGoalIds = goalIds.filter((g) => g.status === GOAL_STATUS.ACTIVE);
  const doneByGoal = await countDoneTasksByGoalSince(userId, periodStart);
  const doneByGoalMap = new Map(doneByGoal.map((d) => [d.goal_id, d.count]));

  const goalProgress = await Promise.all(
    activeGoalIds.map(async (goal) => {
      const { progress } = await deriveGoalProgress(goal);
      return {
        goalId: goal.id,
        title: goal.title,
        status: goal.status,
        progress,
        doneThisWeek: doneByGoalMap.get(goal.id) ?? 0,
      };
    }),
  );

  return {
    periodStart,
    periodEnd,
    activeDays: recordCount,
    recordCount,
    minutes,
    doneTasks,
    windowTotal,
    completionRate,
    streak: computeStreak(recordDates, today),
    goalProgress,
    vsPrevWeek: {
      recordCount: prevRecordCount,
      minutes: prevMinutes,
      doneTasks: prevDoneTasks,
      completionRate: prevCompletionRate,
    },
    planMinutes,
    actualMinutes,
    executionRate,
  };
}

/** 排程执行描述（T44：executionRate 非 null 显示安排/实际/执行率；null = 本周暂无排程，不显示 0%） */
function scheduleExecText(stats: WeeklyStats): string {
  if (stats.executionRate === null) return " 本周暂无 AI 排程。";
  return ` 本周安排 ${stats.planMinutes} 分钟，实际投入 ${stats.actualMinutes} 分钟，执行率 ${stats.executionRate}%。`;
}

/** 规则回退内容（基于真实 stats 构造，LLM 不可用时用户仍获得结构化完整周报） */
export function ruleFallback(
  stats: WeeklyStats,
): Pick<WeeklyContent, "summary" | "achievement" | "problem" | "suggestion"> {
  const problem =
    stats.completionRate < 50
      ? [`本周计划执行率偏低（${stats.completionRate}%），可能有计划偏大或精力分散。`]
      : [];
  return {
    summary:
      stats.recordCount === 0
        ? `本周还没有留下任何记录。${scheduleExecText(stats)}`
        : `本周记录 ${stats.recordCount} 条，投入 ${stats.minutes} 分钟，完成 ${stats.doneTasks}/${stats.windowTotal} 个计划任务（计划执行率 ${stats.completionRate}%），连续记录 ${stats.streak} 天。${scheduleExecText(stats)}`,
    achievement: [],
    problem,
    suggestion: ["从计划执行率最低的目标里挑一件 10 分钟能完成的小事先做"],
  };
}

function mapReport(report: {
  id: string;
  period_start: string;
  period_end: string;
  summary: string;
  content: Record<string, unknown> | null;
  source_count: number;
  generated_at: string;
}) {
  return {
    id: report.id,
    periodStart: report.period_start,
    periodEnd: report.period_end,
    summary: report.summary,
    sourceCount: report.source_count,
    content: report.content,
    generatedAt: report.generated_at,
  };
}

export type WeeklyReportResult = {
  report: ReturnType<typeof mapReport>;
  created: boolean;
};

/** 生成（或覆盖更新）用户本周报告；已存在时返回现有报告并 created=false */
export async function generateWeeklyReport(userId: string): Promise<WeeklyReportResult> {
  const today = todayInShanghai();
  const periodStart = weekStartOf(today);
  const periodEnd = weekEndOf(periodStart);

  const recordDates = await listRecordDates(userId);
  const stats = await computeWeeklyStats(userId, periodStart, periodEnd, recordDates, today);

  const activeGoals = await listGoals(userId);
  const activeGoalViews = activeGoals.filter((g) => g.status === GOAL_STATUS.ACTIVE);
  const doneByGoal = await countDoneTasksByGoalSince(userId, periodStart);
  const doneByGoalMap = new Map(doneByGoal.map((d) => [d.goal_id, d.count]));
  const context: WeeklyContext = {
    periodStart,
    periodEnd,
    activeGoals: await Promise.all(
      activeGoalViews.map(async (goal) => {
        const { progress } = await deriveGoalProgress(goal);
        return { goal, progress, doneThisWeek: doneByGoalMap.get(goal.id) ?? 0 };
      }),
    ),
  };

  const contextText = weeklyContextToText(context);
  const fallback = ruleFallback(stats);

  // 空上下文短路：无任何业务数据时跳过 LLM 调用，直接规则回退
  const meaningful = hasMeaningfulContext({
    hasGoal: stats.goalProgress.length > 0,
    hasTasks: stats.windowTotal > 0,
    hasRecords: stats.recordCount > 0,
  });

  const digest = meaningful
    ? await generateWeeklyDigest(contextText, statsToText(stats), userId)
    : { text: null, goalSuggestions: [], replySource: "rules" as const };
  const { text, goalSuggestions, replySource } = digest;
  const finalReplySource = text ? replySource : ("rules" as const);

  const goalSuggestionsValid: NonNullable<WeeklyContent["goalSuggestions"]> = [];
  if (text) {
    for (const raw of goalSuggestions) {
      if (!isValidGoalSuggestion(raw)) continue;
      // 二次校验：goalId 必须存在且属于本人
      const owned = await getGoal(userId, raw.goalId);
      if (!owned) continue;
      goalSuggestionsValid.push({ ...raw, newTitle: raw.newTitle.trim() });
    }
  }

  const finalText = text ?? fallback;
  const content = buildWeeklyContent(stats, finalText, goalSuggestionsValid, finalReplySource);

  const { report, inserted } = await upsertWeeklyReport({
    userId,
    periodStart,
    periodEnd,
    summary: content.summary,
    sourceCount: stats.recordCount,
    content: content as unknown as Record<string, unknown>,
  });

  return { report: mapReport(report), created: inserted };
}

/** 查询用户本周报告（未生成返回 null） */
export async function getThisWeekReport(userId: string): Promise<ReturnType<typeof mapReport> | null> {
  const periodStart = weekStartOf(todayInShanghai());
  const report = await getWeeklyReportByPeriod(userId, periodStart);
  return report ? mapReport(report) : null;
}

/** 历史周报分页（倒序，含 content） */
export async function listWeeklyReportsForUser(
  userId: string,
  limit: number,
  offset: number,
): Promise<{ total: number; reports: ReturnType<typeof mapReport>[] }> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const safeOffset = Math.max(offset, 0);
  const [total, reports] = await Promise.all([
    countWeeklyReports(userId),
    listWeeklyReports(userId, safeLimit, safeOffset),
  ]);
  return { total, reports: reports.map(mapReport) };
}

/** 周统计文本（供 LLM prompt 参考，明确标注由系统核实） */
function statsToText(stats: WeeklyStats): string {
  const vs = stats.vsPrevWeek;
  const execLine =
    stats.executionRate === null
      ? "排程执行：本周暂无 AI 排程"
      : `排程执行：本周安排 ${stats.planMinutes} 分钟，实际投入 ${stats.actualMinutes} 分钟，执行率 ${stats.executionRate}%`;
  return [
    `周期：${stats.periodStart} ~ ${stats.periodEnd}`,
    `活跃天数：${stats.activeDays} 天，记录数：${stats.recordCount} 条，投入：${stats.minutes} 分钟`,
    `完成计划任务：${stats.doneTasks}/${stats.windowTotal}，计划执行率：${stats.completionRate}%`,
    execLine,
    `连续记录：${stats.streak} 天`,
    `目标推进：${stats.goalProgress.map((g) => `${g.title}（${g.progress}%，本周完成 ${g.doneThisWeek}）`).join("；") || "暂无进行中目标"}`,
    `环比上周：记录 ${vs.recordCount} 条 / 投入 ${vs.minutes} 分钟 / 完成 ${vs.doneTasks} / 执行率 ${vs.completionRate}%`,
  ].join("\n");
}

/** WeeklyContext → token 可控文本（目标抽样文本化） */
function weeklyContextToText(ctx: WeeklyContext): string {
  const lines: string[] = [];
  if (ctx.activeGoals.length > 0) {
    lines.push(`进行中目标（${ctx.activeGoals.length} 个）：`);
    for (const g of ctx.activeGoals.slice(0, 8)) {
      lines.push(`- [id=${g.goal.id}] ${g.goal.title}（进度 ${g.progress}%，本周完成 ${g.doneThisWeek} 个任务）`);
    }
  } else {
    lines.push("进行中目标：暂无");
  }
  lines.push(`本周统计区间：${ctx.periodStart} ~ ${ctx.periodEnd}`);
  return lines.join("\n");
}
