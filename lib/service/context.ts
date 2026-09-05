import { getLatestReport, listRecordsByDate } from "@/lib/repo/evening";
import { countDoneTasksOnDay, countDoneTasksSince, countTasks, dailySpentMinutesSince, listRecordDates } from "@/lib/repo/stats";
import { listTasksByFilter } from "@/lib/repo/tasks";
import { listSchedulesByDate } from "@/lib/repo/planner";
import { listExecutionsBySchedules } from "@/lib/repo/execution";
import { listGoalsForUser } from "./goals";
import { computeStreak } from "./stats";
import { dateMinusDays, todayInShanghai } from "./time";

/**
 * Agent Context Builder（Phase 2，核心）。
 * 职责：把用户的真实数据组装成 Agent 可消费的上下文（纯 SQL + 纯函数，不调 LLM）。
 * 输出口径与 0.3.0 闭环一致：目标 → 任务 → 记录 → 7 天统计 → 最近晚报。
 */

export type AgentContext = {
  /** 进行中目标（取最近创建的 1 个） */
  goal: { title: string; progress: number; taskCount: number; doneCount: number } | null;
  /** 未完成任务（upcoming + current），最多 10 */
  tasks: Array<{ title: string; status: "done" | "current" | "upcoming"; kind: string }>;
  /** 今日记录，最多 20 */
  todayRecords: Array<{ topic: string; text: string; kind: string | null; minutes: number }>;
  weeklyStats: {
    activeDays: number;
    minutes7d: number;
    doneTasks7d: number;
    /** 7 天完成率 = doneTasks7d / max(1, todayTotal)，百分比取整 */
    completionRate7d: number;
    todayDone: number;
    todayTotal: number;
  };
  /** 最近一条晚报 summary（getLatestReport，按 report_date 倒序取 1 条），供 Agent 参考连续性 */
  recentReport: string | null;
  /**
   * 今日执行（Step 5c：今日已完成的 action 排程 join execution_records）。
   * manual 排程（action_id=null）**不进入**——本字段描述「安排→实际」的 Action 执行投入；
   * 无任何完成 → []。execution 是唯一事实来源。
   */
  todayExecutions: Array<{ title: string; plannedMinutes: number; actualMinutes: number }>;
};

export async function buildAgentContext(userId: string): Promise<AgentContext> {
  const today = todayInShanghai();
  const since7d = dateMinusDays(today, 6);

  const [goalViews, tasks, todayRecords, done7d, doneToday, totalTasks, recordDates, minutesRows, latest] =
    await Promise.all([
      listGoalsForUser(userId, { status: "进行中" }),
      listTasksByFilter(userId).then((ts) => ts.filter((t) => t.status !== "done").slice(0, 10)),
      listRecordsByDate(userId, today),
      countDoneTasksSince(userId, since7d),
      countDoneTasksOnDay(userId, today),
      countTasks(userId),
      listRecordDates(userId),
      dailySpentMinutesSince(userId, since7d),
      getLatestReport(userId),
    ]);

  const goal = goalViews.length > 0 ? goalViews[goalViews.length - 1] : null;
  const minutes7d = minutesRows.reduce((sum, r) => sum + r.minutes, 0);

  // todayExecutions：今日完成的 action 排程 join execution（manual 不进；无执行空数组）
  const doneActionScheds = (await listSchedulesByDate(userId, today)).filter(
    (s) => s.status === "completed" && s.source === "action",
  );
  let todayExecutions: AgentContext["todayExecutions"] = [];
  if (doneActionScheds.length > 0) {
    const execs = await listExecutionsBySchedules(
      userId,
      doneActionScheds.map((s) => s.id),
    );
    const execBySchedule = new Map(execs.map((e) => [e.schedule_id, e]));
    todayExecutions = doneActionScheds.flatMap((s) => {
      const exec = execBySchedule.get(s.id);
      if (!exec) return [];
      const [hs, ms] = s.start_time.split(":").map(Number);
      const [he, me] = s.end_time.split(":").map(Number);
      return [
        {
          title: s.title,
          plannedMinutes: (he * 60 + (me || 0)) - (hs * 60 + (ms || 0)),
          actualMinutes: exec.actual_minutes,
        },
      ];
    });
  }

  return {
    goal: goal
      ? { title: goal.title, progress: goal.progress, taskCount: goal.taskCount, doneCount: goal.doneCount }
      : null,
    tasks: tasks.map((t) => ({ title: t.title, status: t.status, kind: t.kind })),
    todayRecords: todayRecords.map((r) => ({
      topic: r.topic,
      text: r.text,
      kind: r.kind,
      minutes: r.minutes ?? 0,
    })),
    weeklyStats: {
      activeDays: computeStreak(recordDates, today),
      minutes7d,
      doneTasks7d: done7d,
      completionRate7d: totalTasks === 0 ? 0 : Math.round((done7d / Math.max(1, totalTasks)) * 100),
      todayDone: doneToday,
      todayTotal: totalTasks,
    },
    recentReport: latest?.summary ?? null,
    todayExecutions,
  };
}

/**
 * contextToText —— 纯函数：AgentContext → token 可控的文本。
 * 分组/截断，不把原始敏感内容灌给 LLM（沿用 summarizeRecords 的克制风格）。
 */
export function contextToText(ctx: AgentContext): string {
  const lines: string[] = [];

  if (ctx.goal) {
    lines.push(`目标：${ctx.goal.title}（进度 ${ctx.goal.progress}%，${ctx.goal.doneCount}/${ctx.goal.taskCount} 任务完成）`);
  } else {
    lines.push("目标：暂无进行中的目标");
  }

  if (ctx.tasks.length > 0) {
    lines.push(`未完成任务（${ctx.tasks.length} 条）：`);
    for (const t of ctx.tasks) lines.push(`- ${t.title}${t.status === "current" ? "（进行中）" : ""}`);
  }

  if (ctx.todayRecords.length > 0) {
    lines.push(`今日记录（${ctx.todayRecords.length} 条）：`);
    for (const r of ctx.todayRecords.slice(0, 20)) {
      const topic = r.topic || r.text;
      const text = topic.length > 60 ? `${topic.slice(0, 60)}…` : topic;
      lines.push(`- ${text}${r.minutes > 0 ? `（${r.minutes} 分钟）` : ""}`);
    }
  } else {
    lines.push("今日还没有留下任何记录。");
  }

  // Step 5c：今日执行（安排→实际）。无执行不输出该段（不产生空段/不改变旧段顺序）。
  if (ctx.todayExecutions.length > 0) {
    lines.push(`今日执行（${ctx.todayExecutions.length} 条）：`);
    for (const e of ctx.todayExecutions) {
      lines.push(`- ${e.title}：计划 ${e.plannedMinutes} 分钟，实际 ${e.actualMinutes} 分钟`);
    }
  }

  const w = ctx.weeklyStats;
  lines.push(
    `近 7 天：连续记录 ${w.activeDays} 天，投入 ${w.minutes7d} 分钟，完成任务 ${w.doneTasks7d} 个（完成率 ${w.completionRate7d}%），今日完成 ${w.todayDone}/${w.todayTotal}。`,
  );

  if (ctx.recentReport) {
    const tail = ctx.recentReport.length > 100 ? `${ctx.recentReport.slice(0, 100)}…` : ctx.recentReport;
    lines.push(`最近一次晚报：${tail}`);
  }

  return lines.join("\n");
}
