import { readConfig } from "./provider";
import { extractJson } from "./evening-generator";
import { validateSteps, type DecomposeStep } from "./decompose-validator";
import { todayInShanghai } from "@/lib/service/time";

/**
 * LLM Planner Adapter（Agent Decompose V1）。
 * 生成链路：LLM（带重试 1 次）→ Schema 校验 → Quality 校验 → 规则回退。
 * 原则：先跑通规则回退（无 LLM 配置时链路依然可用），再接 LLM。
 */

const SYSTEM_PROMPT = `你是成长回路的目标拆解规划器。根据用户目标和已有任务，把目标拆成若干「今天就能开始的可执行行动」。

输入数据：
- goal：目标的标题、描述、周期
- existingTasks：该目标下已有的任务标题
- stepRange：系统建议的步骤数量范围 {min, max}

输出要求（必须只输出一个合法 JSON 对象，无任何其他文字）：
{
  "steps": [
    {
      "order": 1,
      "title": "行动名（不超过 40 字，标题应体现行动，可使用动词短语开头，如『完成…』『整理…』『跑通…』）",
      "description": "这一步具体做什么（一两句话）",
      "acceptance": "完成标准：做到什么程度算完成（必须可验证，禁止『好好学』『认真做』）",
      "estimatedMinutes": 45,
      "category": "learning | exercise | coding | reading | creative | life | rest | other"
    }
  ]
}

硬性约束：
1. steps 数量必须在 {min}-{max} 之间，不得超出
2. 每步 estimatedMinutes 在 5-240 之间
3. 不得生成与 existingTasks 重复或高度相似的步骤
4. 禁止把大目标当行动：标题不得含『掌握』『精通』『学完』『全面学习』『彻底理解』『完成整个课程』『学会全部』
5. title 是可执行的行动，40 分钟内能启动；如果目标太宏大，拆出的是它的第一个可执行切片，而不是路线图
6. category 从给定枚举选，不要自造`;

const EXAMPLE_OUTPUT = `{"steps":[{"order":1,"title":"跑通 Python 环境并写第一个程序","description":"安装运行环境，运行 hello world 和两个变量运算示例","acceptance":"能独立运行 3 个示例并解释每行作用","estimatedMinutes":60,"category":"coding"},{"order":2,"title":"完成变量、循环、函数练习","description":"用列表循环和函数改写一个小工具","acceptance":"练习题正确率不低于 60%，错题记入笔记","estimatedMinutes":90,"category":"learning"}]}`;

export type StepRange = { min: number; max: number };

/** Schema 校验（宽容版）：类型不合法的步丢弃，剩余数量须在范围内 */
function parsePlan(text: string, range: StepRange): DecomposeStep[] | null {
  const parsed = extractJson(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const rawSteps = (parsed as Record<string, unknown>).steps;
  if (!Array.isArray(rawSteps)) return null;
  const steps: DecomposeStep[] = [];
  for (const raw of rawSteps) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.title !== "string" || typeof s.description !== "string" || typeof s.acceptance !== "string") continue;
    if (typeof s.estimatedMinutes !== "number" || typeof s.category !== "string") continue;
    steps.push({
      order: steps.length + 1,
      title: s.title,
      description: s.description,
      acceptance: s.acceptance,
      estimatedMinutes: s.estimatedMinutes,
      category: s.category,
    });
  }
  if (steps.length < range.min || steps.length > range.max) return null;
  return steps;
}

/** 调用一次 LLM Planner；失败（网络/解析/schema）返回 null */
async function callPlanner(contextText: string, range: StepRange, feedback?: string): Promise<DecomposeStep[] | null> {
  const config = readConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT.replace("{min}", String(range.min)).replace("{max}", String(range.max)) },
          { role: "user", content: `数据：\n${contextText}\n\n示例输出（仅参考格式）：\n${EXAMPLE_OUTPUT}` + (feedback ? `\n\n上一次生成的以下步骤不合格，请修正后重新生成：${feedback}` : "") },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    return text ? parsePlan(text, range) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 规则回退：按范围 min 步生成模板（title 带日期防与既有步骤重复） */
export function ruleDecomposeSteps(goalTitle: string, range: StepRange): DecomposeStep[] {
  const count = Math.max(1, range.min);
  const stamp = todayInShanghai().slice(5).replace("-", "");
  return Array.from({ length: count }, (_, i) => ({
    order: i + 1,
    title: `围绕「${goalTitle}」的第 ${i + 1} 步（${stamp}）`,
    description: `把目标推进一小步：明确这一步的具体产出并开始执行`,
    acceptance: `完成这一步并留下一条可验证的记录`,
    estimatedMinutes: 30,
    category: i % 2 === 0 ? "focus" : "learn",
  }));
}

export type DecomposePlanResult = {
  steps: DecomposeStep[];
  source: "llm" | "rules";
};

/** 生成拆解方案：LLM（最多 1 次带反馈重试）→ 规则回退（永不落空） */
export async function generateDecomposePlan(input: {
  goalTitle: string;
  contextText: string;
  range: StepRange;
  existingTitles: string[];
}): Promise<DecomposePlanResult> {
  const { goalTitle, contextText, range, existingTitles } = input;

  const attempt = await callPlanner(contextText, range);
  if (attempt) {
    const { validSteps, issues } = validateSteps(attempt, existingTitles);
    if (validSteps.length >= range.min) return { steps: validSteps, source: "llm" };
    const feedback = issues.map((i) => `第 ${i.order} 步：${i.reason}`).join("；");
    const retry = await callPlanner(contextText, range, feedback);
    if (retry) {
      const retried = validateSteps(retry, existingTitles);
      if (retried.validSteps.length >= range.min) return { steps: retried.validSteps, source: "llm" };
    }
  }

  return { steps: ruleDecomposeSteps(goalTitle, range), source: "rules" };
}
