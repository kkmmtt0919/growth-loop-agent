import { callLLMJson } from "./llm-json";
import { extractJson } from "./core/pure";
import { validateActionSteps, type ActionStep } from "./core/pure";
import { todayInShanghai } from "@/lib/service/time";

/**
 * ActionPlan Generator（Smart Planner Step 2：目标 → 阶段级行动池，战略层）。
 * 与旧 decompose-generator（战术层：目标 → 今日任务切片）**语义相反、文件独立、互不调用**：
 *   - 这里是「画目标路线图」：阶段节点 + 总投入 + 依赖，不进今日时间轴；
 *   - 旧 decompose 是「切今天的行动」：5-240min、禁大目标词、直接落 tasks（原样保留）。
 * 生成链路沿用项目成熟骨架：LLM（带 1 次反馈重试）→ Schema/质量校验 → 规则回退。
 */

const SYSTEM_PROMPT = `你是成长回路的目标规划器。你的任务：把一个长期目标拆成「阶段级行动路线图」（Action 池）——让用户知道完成这个目标**要经过哪些阶段**，而不是今天做什么。

输入数据：
- goal：目标的标题、描述、周期（截止日期）
- existingActions：该目标下已有的行动阶段标题（去重用）
- range：行动阶段数量范围 {min}-{max}

输出要求（必须只输出一个合法 JSON 对象，无任何其他文字）：
{
  "actions": [
    {
      "title": "阶段名（不超过 60 字，动词短语开头，如『文献调研』『实验设计』『模型训练』『论文撰写』）",
      "description": "这个阶段具体做什么、完成到什么程度（一两句话）",
      "estimatedMinutes": 1800,
      "priority": 1,
      "dependsOnTitles": ["前置阶段标题（必须是本批次其它 action 的 title 完全一致的原样）"]
    }
  ]
}

硬性约束：
1. actions 数量必须在 {min}-{max} 之间，不得超出
2. 每个阶段是**可独立推进的完整阶段**，不是 30 分钟就能做完的微任务
3. estimatedMinutes = **完成整个阶段预计投入的总分钟数**（30-3000 之间）——不是单次执行时长！比如「训练模型」整个阶段可能是 1800 分钟，Planner 之后会把它拆成每天 90 分钟多次执行
4. 每个阶段必须给出 priority（1 最高 → 10 最低）：依赖链下游、决定成败的关键阶段给低数字
5. dependsOnTitles 里的每个标题必须是**本批次其它 action 的 title 原样完全一致**，禁止自造本批次不存在的标题；没有前置依赖给 []
6. 标题不得等于或几乎等于整目标本身（如目标是『完成毕业论文』，阶段不能也叫『完成毕业论文』）
7. 标题不得与 existingActions 里的已有阶段重复或高度相似
8. 优先按真实推进顺序拆：先做的阶段在前（本批次顺序即建议执行顺序）`;

const EXAMPLE_OUTPUT = `{"actions":[{"title":"文献调研","description":"调研领域核心文献，梳理研究现状与方法脉络，确定可切入的方向","estimatedMinutes":1200,"priority":2,"dependsOnTitles":[]},{"title":"实验设计","description":"基于文献确定实验方案、指标与对照组，产出可执行的实验计划","estimatedMinutes":900,"priority":1,"dependsOnTitles":["文献调研"]},{"title":"模型训练与实验","description":"实现基线并完成训练、调参与对比实验，记录过程数据","estimatedMinutes":1800,"priority":1,"dependsOnTitles":["实验设计"]},{"title":"论文撰写","description":"按结构与期刊要求完成论文初稿并迭代润色","estimatedMinutes":2400,"priority":3,"dependsOnTitles":["模型训练与实验"]}]}`;

export type ActionPlanResult = {
  actions: ActionStep[];
  source: "llm" | "rules";
};

/** Schema 校验（宽容版）：类型不合格的步丢弃，剩余数量须在范围内 */
function parsePlan(text: string, range: { min: number; max: number }): ActionStep[] | null {
  const parsed = extractJson(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const rawActions = (parsed as Record<string, unknown>).actions;
  if (!Array.isArray(rawActions)) return null;
  const steps: ActionStep[] = [];
  for (const raw of rawActions) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.title !== "string" || !s.title.trim()) continue;
    const description = typeof s.description === "string" ? s.description : "";
    const estimatedMinutes = Number(s.estimatedMinutes);
    const priority = Number(s.priority);
    const deps = Array.isArray(s.dependsOnTitles)
      ? s.dependsOnTitles.filter((d): d is string => typeof d === "string" && d.trim() !== "")
      : [];
    steps.push({
      title: s.title,
      description: description.trim() || null,
      estimatedMinutes: Number.isFinite(estimatedMinutes) ? Math.round(estimatedMinutes) : 0,
      priority: Number.isFinite(priority) ? Math.round(priority) : 0,
      dependsOnTitles: deps.map((d) => d.trim()),
    });
  }
  if (steps.length < range.min || steps.length > range.max) return null;
  return steps;
}

/** 规则回退：链式阶段模板（第 N 阶段依赖第 N-1 阶段；时长落在 30-3000 内）。永不落空。 */
export function ruleActionPlanSteps(goalTitle: string, range: { min: number; max: number }): ActionStep[] {
  const count = Math.max(1, range.min);
  const stamp = todayInShanghai().slice(5).replace("-", "");
  const totalBudget = Math.min(3000, 240 * count); // 每阶段 ≤2400 的简单均摊预算
  const perStage = Math.max(30, Math.round(totalBudget / count));
  return Array.from({ length: count }, (_, i) => ({
    title: `围绕「${goalTitle}」的第 ${i + 1} 个阶段（${stamp}）`,
    description: `推进目标的一条主阶段：明确产出、投入与完成标准后开始执行`,
    estimatedMinutes: Math.min(3000, Math.max(30, perStage)),
    priority: Math.min(10, Math.max(1, 5)),
    dependsOnTitles: i === 0 ? [] : [`围绕「${goalTitle}」的第 ${i} 个阶段（${stamp}）`],
  }));
}

/**
 * 生成行动路线：LLM（最多 1 次带反馈重试）→ 规则回退（永不落空）。
 * 校验只过滤「结构非法 / 与整目标重复 / 与已有行动重复」的步；
 * dependsOnTitles 的**跨步引用解析在 Service 层做**（title → id），这里保留标题引用。
 */
export const ACTION_PLAN_PROMPT_VERSION = "action-plan-v1";

export async function generateActionPlan(input: {
  goalTitle: string;
  contextText: string;
  range: { min: number; max: number };
  existingTitles: string[];
  userId?: string | null;
}): Promise<ActionPlanResult> {
  const { goalTitle, contextText, range, existingTitles } = input;
  const system = SYSTEM_PROMPT.replace("{min}", String(range.min)).replace("{max}", String(range.max));
  const trace = { userId: input.userId ?? null, agentType: "action-plan" as const, promptVersion: ACTION_PLAN_PROMPT_VERSION };

  async function attempt(feedback?: string): Promise<ActionStep[] | null> {
    const user = `数据：\n${contextText}\n\n示例输出（仅参考格式）：\n${EXAMPLE_OUTPUT}` + (feedback ? `\n\n上一次生成存在以下问题，请修正后重新生成：${feedback}` : "");
    const text = await callLLMJson({ system, user, temperature: 0.4, timeoutMs: 20_000, trace });
    if (!text) return null;
    const parsed = parsePlan(text, range);
    if (!parsed) return null;
    const { validSteps, issues } = validateActionSteps(parsed, goalTitle, existingTitles);
    if (validSteps.length < range.min) {
      // 结构合法但质量不过关 → 交给 feedback 重试
      throw { issues };
    }
    return validSteps;
  }

  try {
    const first = await attempt();
    if (first) return { actions: first, source: "llm" };
  } catch (error) {
    // 质量不过关 → 带 feedback 重试一次
    const { issues } = error as { issues: Array<{ index: number; reason: string }> };
    const feedback = issues.map((i) => `第 ${i.index + 1} 个阶段：${i.reason}`).join("；");
    const retried = await attempt(feedback);
    if (retried) return { actions: retried, source: "llm" };
  }

  // LLM 不可用 / 重试仍失败 → 规则回退
  return { actions: ruleActionPlanSteps(goalTitle, range), source: "rules" };
}
