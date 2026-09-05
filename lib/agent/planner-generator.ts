import { callLLMJson } from "./llm-json";

/**
 * Planner LLM（Smart Planner Step 3）——只出「做什么/先做什么/工作量感受」的判断，
 * **绝不输出具体时间**（精确 slot 由 Rule Scheduler 规则排，杜绝时间冲突/固定块占用）。
 * 失败/无配置 → 返回 null，Service 用「依赖拓扑 + priority」规则回退（generatePlanOrdering 永不落空的兜底在 service）。
 */
const SYSTEM_PROMPT = `你是成长回路的排程规划器。你只做一件事：给用户目标下的一批「行动阶段」排建议执行顺序，并给出简要说明。你【绝对不能】输出任何具体日期、钟点、时段——时间安排由系统规则负责。

输入数据：
- goal：目标标题与截止
- actions：待排阶段清单，每项含 title、estimatedMinutes（完成该阶段的总投入分钟）、priority（1 最高 → 10 最低）、dependsOn（该阶段依赖的前置阶段标题）
- 用户执行节奏：近 7 天与近 30 天平均每天投入分钟（仅参考）

输出要求（必须只输出一个合法 JSON 对象，无任何其他文字）：
{
  "ordering": ["阶段标题1", "阶段标题2", "…"],   // 按你建议的执行顺序排列；必须来自给定清单的标题、不得遗漏、不得自造、不得重复
  "note": "一句话说明排序理由（可选，≤80 字）"
}

硬性约束：
1. ordering 必须完整包含全部给定阶段标题（无遗漏、无重复、无自造）
2. ordering 必须尊重依赖：某阶段 dependsOn 的标题必须排在它前面；若给定顺序违反依赖，你应修正
3. 不要输出时间/日期/钟点/“周几”等内容`;

export type PlanOrderingResult = {
  ordering: string[];
  note: string;
};

export const PLANNER_PROMPT_VERSION = "planner-v1";

/** 一次 LLM 排序尝试；解析失败返回 null */
export async function tryGeneratePlanOrdering(input: {
  goalTitle: string;
  contextText: string;
  actionTitles: string[];
  userId?: string | null;
}): Promise<PlanOrderingResult | null> {
  const user = `数据：\n${input.contextText}`;
  const text = await callLLMJson({
    system: SYSTEM_PROMPT,
    user,
    temperature: 0.2,
    timeoutMs: 15_000,
    trace: { userId: input.userId ?? null, agentType: "planner", promptVersion: PLANNER_PROMPT_VERSION },
  });
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 偶发模型夹带非 JSON 文本时尝试提取对象
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.ordering)) return null;
  const titles = raw.ordering.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  const valid = titles.map((t) => t.trim());
  // 完整性校验：必须是给定标题的排列（无自造）
  const expected = new Set(input.actionTitles.map((t) => t.trim()));
  if (valid.length !== expected.size || !valid.every((t) => expected.has(t))) return null;
  return { ordering: valid, note: typeof raw.note === "string" ? raw.note.slice(0, 80) : "" };
}
