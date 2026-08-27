import { generateEveningDigest, type EveningContent } from "@/lib/agent/evening-generator";
import { hasMeaningfulContext } from "@/lib/agent/core/pure";
import { getReportByDate, upsertTodayReport, type DbEveningReport } from "@/lib/repo/evening";
import { ServiceError } from "./errors";
import { buildAgentContext, contextToText, type AgentContext } from "./context";
import { todayInShanghai } from "./time";

/**
 * 每日晚间晚报业务服务（Phase 2 改造）。
 * 生成链路：buildAgentContext（目标/任务/记录/7 天统计/最近晚报）→ contextToText → generateEveningDigest
 *           （LLM JSON 结构化输出，失败规则回退）→ 幂等落库 {summary, content}。
 * 幂等：UNIQUE(user_id, report_date) 由数据库保证，重复/并发生成只有一行。
 */

const EVENING_QUESTIONS = [
  "今天最重要的行动是什么？",
  "哪个地方真正被你理解或用上了？",
  "明天要延续的最小一步是什么？",
];

/** 规则回退内容（基于真实 context 构造，LLM 不可用时用户仍获得结构化完整晚报） */
export function ruleFallbackContent(ctx: AgentContext): EveningContent {
  const achievements = ctx.todayRecords
    .map((r) => r.topic || r.text)
    .map((t) => (t.length > 40 ? `${t.slice(0, 40)}…` : t))
    .filter(Boolean)
    .slice(0, 3);
  const w = ctx.weeklyStats;
  return {
    summary:
      ctx.todayRecords.length === 0
        ? "今天还没有留下任何记录。"
        : `今天记录了 ${ctx.todayRecords.length} 条行动，完成 ${w.todayDone}/${w.todayTotal} 个任务。`,
    achievement: achievements,
    problem: [],
    suggestion: ["从一件 10 分钟能完成的小事开始明天"],
    evaluation: `近 7 天完成任务 ${w.doneTasks7d} 个（完成率 ${w.completionRate7d}%），连续记录 ${w.activeDays} 天。`,
  };
}

export type EveningReportResult = {
  report: DbEveningReport;
  created: boolean;
};

/** 生成（或覆盖更新）用户今日晚报；已存在时返回现有报告并 created=false */
export async function generateEveningReport(userId: string): Promise<EveningReportResult> {
  const reportDate = todayInShanghai();
  const context = await buildAgentContext(userId);
  const contextText = contextToText(context);
  const fallback = ruleFallbackContent(context);

  // 空上下文短路：无任何业务数据时跳过 LLM 调用，直接规则回退（省外呼、避免无事实输入下编造）
  const meaningful = hasMeaningfulContext({
    hasGoal: context.goal !== null,
    hasTasks: context.tasks.length > 0,
    hasRecords: context.todayRecords.length > 0,
  });

  const { content, replySource } = meaningful
    ? await generateEveningDigest(contextText, fallback)
    : { content: fallback, replySource: "rules" as const };
  if (replySource === "rules") {
    // 规则回退时在 summary 里保留完整上下文，用户仍能看到今天发生了什么
    content.summary = `${fallback.summary}\n\n${contextText}`;
  }

  const { report, inserted } = await upsertTodayReport({
    userId,
    reportDate,
    summary: content.summary,
    questions: EVENING_QUESTIONS,
    sourceCount: context.todayRecords.length,
    content,
  });

  return { report, created: inserted };
}

/** 查询用户今日晚报（未生成返回 null） */
export async function getTodayEveningReport(userId: string): Promise<DbEveningReport | null> {
  return getReportByDate(userId, todayInShanghai());
}

/** 系统模式（CRON）校验并生成指定用户晚报 */
export async function generateEveningReportForUser(targetUserId: string): Promise<EveningReportResult> {
  if (!targetUserId || typeof targetUserId !== "string") {
    throw new ServiceError("userId 必填", 400);
  }
  return generateEveningReport(targetUserId);
}
