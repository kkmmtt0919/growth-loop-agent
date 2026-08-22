import { runAgent } from "@/lib/agent/provider";
import { getReportByDate, listRecordsByDate, upsertTodayReport, type DbEveningReport } from "@/lib/repo/evening";
import type { DbRecord } from "@/lib/repo/types";
import { ServiceError } from "./errors";

/**
 * 每日晚间晚报业务服务。
 * 生成链路：拉当天记录 → summarizeRecords（纯函数，不调 LLM）→ Agent(review) → 规则回退 → 存库。
 * 幂等：UNIQUE(user_id, report_date) 由数据库保证，重复/并发生成只有一行。
 */

const EVENING_QUESTIONS = [
  "今天最重要的行动是什么？",
  "哪个地方真正被你理解或用上了？",
  "明天要延续的最小一步是什么？",
];

/** 服务端统一时区：上海时区的今天，格式 YYYY-MM-DD（不依赖服务器本地时区） */
export function todayInShanghai(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const KIND_LABEL: Record<string, string> = {
  focus: "专注",
  learn: "学习",
  exercise: "运动",
  life: "生活",
  rest: "休息",
};

/**
 * summarizeRecords —— 纯函数，职责只有分组/截断/格式化。
 * 不做 LLM、不做复杂推理，输出稳定、token 可控的摘要文本，Agent 再基于它生成晚报。
 */
export function summarizeRecords(records: DbRecord[]): string {
  if (records.length === 0) {
    return "今天还没有留下任何记录。";
  }

  const byKind = new Map<string, string[]>();
  for (const record of records) {
    const kind = record.kind ?? "focus";
    const label = KIND_LABEL[kind] ?? "其他";
    const topic = record.topic || record.text;
    const line = topic.length > 40 ? `${topic.slice(0, 40)}…` : topic;
    if (!byKind.has(label)) byKind.set(label, []);
    byKind.get(label)!.push(line);
  }

  const minutes = records.reduce((sum, r) => sum + (r.minutes ?? 0), 0);
  const lines: string[] = [];
  for (const [kind, items] of byKind) {
    lines.push(`${kind}：`);
    for (const item of items.slice(0, 8)) lines.push(`- ${item}`);
  }

  return [
    `今日记录摘要（共 ${records.length} 条${minutes > 0 ? `，约 ${minutes} 分钟` : ""}）：`,
    ...lines,
  ].join("\n");
}

export type EveningReportResult = {
  report: DbEveningReport;
  created: boolean;
};

/** 生成（或覆盖更新）用户今日晚报；已存在时返回现有报告并 created=false */
export async function generateEveningReport(userId: string): Promise<EveningReportResult> {
  const reportDate = todayInShanghai();
  const records = await listRecordsByDate(userId, reportDate);
  const digest = summarizeRecords(records);

  let summary: string;
  try {
    const result = await runAgent("今晚回顾", {
      conversationId: `evening:${userId}:${reportDate}`,
      context: digest,
    });
    if (result.replySource === "llm") {
      summary = result.reply;
    } else {
      // 规则回退：摘要 + 三问引导，用户仍然获得完整晚报体验
      summary = `${digest}\n\n${result.reply}`;
    }
  } catch (error) {
    console.error("[service/evening] agent failed", error);
    summary = `${digest}\n\n晚报开始：我会把今天的记录合在一起，依次问你——最重要的行动、真正理解或应用的地方、明天的最小一步。`;
  }

  const { report, inserted } = await upsertTodayReport({
    userId,
    reportDate,
    summary,
    questions: EVENING_QUESTIONS,
    sourceCount: records.length,
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
