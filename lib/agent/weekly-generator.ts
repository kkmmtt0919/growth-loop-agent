import { readConfig } from "./provider";
import { extractJson } from "./evening-generator";

/**
 * 周报结构化生成（Phase 5）。
 * LLM JSON 输出 → 解析容错 → schema 校验 + 语义校验 → 失败规则回退（用户永远拿到完整周报）。
 * 边界（与晚报一致）：只输出文字总结，不输出数值分；stats 始终由规则引擎提供、不信任 LLM 数字。
 */

export const WEEKLY_SCHEMA_VERSION = 1;
export const MAX_GOAL_SUGGESTION_TITLE = 40;

/** 固定结构：LLM 不得自由发挥（v2 仅支持 update_title，archive 暂不支持） */
export type GoalSuggestion = {
  goalId: string;
  action: "update_title";
  newTitle: string;
  reason: string;
};

export type WeeklyContent = {
  schemaVersion: number;
  stats: WeeklyStats;
  summary: string;
  achievement: string[];
  problem: string[];
  suggestion: string[];
  goalSuggestions: GoalSuggestion[];
  replySource: "llm" | "rules";
};

export type WeeklyStats = {
  periodStart: string;
  periodEnd: string;
  activeDays: number;
  recordCount: number;
  minutes: number;
  doneTasks: number;
  windowTotal: number;
  /** 计划执行率 = round(doneTasks / max(1, windowTotal) * 100) */
  completionRate: number;
  streak: number;
  goalProgress: Array<{
    goalId: string;
    title: string;
    status: string;
    progress: number;
    doneThisWeek: number;
  }>;
  vsPrevWeek: {
    recordCount: number;
    minutes: number;
    doneTasks: number;
    completionRate: number;
  };
};

/** 纯函数：组装最终 content（stats 永远用规则值，只取 LLM 文字字段） */
export function buildWeeklyContent(
  stats: WeeklyStats,
  text: Pick<WeeklyContent, "summary" | "achievement" | "problem" | "suggestion">,
  goalSuggestions: GoalSuggestion[],
  replySource: "llm" | "rules",
): WeeklyContent {
  return {
    schemaVersion: WEEKLY_SCHEMA_VERSION,
    stats,
    summary: text.summary,
    achievement: text.achievement,
    problem: text.problem,
    suggestion: text.suggestion,
    goalSuggestions,
    replySource,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

/** UUID 合法性（goalId 将进入 SQL uuid 列，非法值会触发 string_to_uuid 异常，须在入库前过滤） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 单条建议结构校验（action 白名单 + goalId 必须是 UUID + newTitle 非空且 ≤40 字） */
export function isValidGoalSuggestion(value: unknown): value is GoalSuggestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.goalId === "string" &&
    UUID_RE.test(v.goalId) &&
    v.action === "update_title" &&
    typeof v.newTitle === "string" &&
    v.newTitle.trim().length > 0 &&
    v.newTitle.length <= MAX_GOAL_SUGGESTION_TITLE &&
    typeof v.reason === "string"
  );
}

/**
 * 服务端校验：LLM 原始对象 → 文字字段 + 合法建议。
 * 不合法的字段丢弃（summary 缺失则视为整体失败）；返回 null 表示应走规则回退。
 */
export function extractWeeklyText(raw: unknown): Pick<WeeklyContent, "summary" | "achievement" | "problem" | "suggestion"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.summary !== "string") return null;
  if (!isStringArray(v.achievement) || !isStringArray(v.problem) || !isStringArray(v.suggestion)) return null;
  return {
    summary: v.summary,
    achievement: v.achievement,
    problem: v.problem,
    suggestion: v.suggestion,
  };
}

export type WeeklyDigestResult = {
  /** LLM 文字字段（已校验）；若 null 表示整体失败需回退 */
  text: Pick<WeeklyContent, "summary" | "achievement" | "problem" | "suggestion"> | null;
  /** LLM 原始建议数组（已过滤非法项，仅留结构合法者）；服务端仍需再校验 goalId 归属 */
  goalSuggestions: unknown[];
  replySource: "llm" | "rules";
};

const SYSTEM_PROMPT = `你是成长回路的成长教练。根据用户的真实周数据（目标、任务、本周记录、周统计、最近晚报）生成一周成长反馈。

输出必须是合法 JSON 对象，不要输出 JSON 以外的任何文字，字段如下：
{
  "summary": "一段不超过 3 句的本周总结，基于事实，不编造",
  "achievement": ["本周做成的具体事项，1-3 条，来自记录与完成任务"],
  "problem": ["本周遇到的阻碍或薄弱点，0-2 条，没有就空数组"],
  "suggestion": ["下周可执行的 1-2 条建议，要具体到动作"],
  "goalSuggestions": [
    {
      "goalId": "进行中目标的 id",
      "action": "update_title",
      "newTitle": "建议的新标题，不超过 40 字",
      "reason": "建议理由，基于本周数据"
    }
  ]
}

严格要求：
1. 下方 stats 已由系统计算，禁止重述或编造任何数字；总结只能引用 stats 与上下文里出现的事实。
2. goalSuggestions 只对 status="进行中" 的目标提建议；没有需要调整的目标返回空数组 []。goalId 必须原样复制上下文中 [id=xxx] 标注的真实 id，禁止编造。
3. action 仅允许 "update_title"；newTitle 必须非空且不超过 40 字；不要输出 "archive" 或其他 action。
4. 不评价人格、不做心理/医疗诊断。
5. 没有数据时如实说"本周还没有留下任何记录"。`;

/**
 * 生成结构化周报文字 + 建议。
 * @param contextText 由 weeklyContextToText 生成的上下文文本（token 可控）
 * @param statsText   用于 prompt 内展示的、系统已算好的 stats 文本（LLM 不得改动，仅作参考）
 */
export async function generateWeeklyDigest(
  contextText: string,
  statsText: string,
): Promise<WeeklyDigestResult> {
  const config = readConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { text: null, goalSuggestions: [], replySource: "rules" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `本周系统统计（已核实，请勿修改）：\n${statsText}\n\n用户本周数据：\n${contextText}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { text: null, goalSuggestions: [], replySource: "rules" };
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const llmText = data.choices?.[0]?.message?.content;
    const parsed = llmText ? extractJson(llmText) : null;

    const text = extractWeeklyText(parsed);
    const rawSuggestions =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).goalSuggestions
        : null;

    return {
      text,
      goalSuggestions: Array.isArray(rawSuggestions) ? rawSuggestions.filter(isValidGoalSuggestion) : [],
      replySource: text ? "llm" : "rules",
    };
  } catch {
    return { text: null, goalSuggestions: [], replySource: "rules" };
  } finally {
    clearTimeout(timeout);
  }
}
