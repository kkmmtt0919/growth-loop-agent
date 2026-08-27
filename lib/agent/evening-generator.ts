import { readConfig } from "./provider";
import { extractJson, isEveningContent } from "./core/pure";
import type { EveningContent } from "./core/pure";

/**
 * 晚报结构化生成（Phase 2，核心）。
 * LLM JSON 输出 → 解析容错 → schema 校验 → 失败规则回退（用户永远拿到完整晚报）。
 * 边界：只输出 evaluation（文字评价），不输出数值分（score 不参与业务）。
 */

// 纯函数/类型从 core/pure 抽离，re-export 保持对外 API 不变
export { extractJson, isEveningContent };
export type { EveningContent };

const SYSTEM_PROMPT = `你是成长回路的成长教练。根据用户的真实数据（目标、任务、今日记录、近 7 天统计、最近晚报）生成当晚成长反馈。

输出必须是合法 JSON 对象，不要输出 JSON 以外的任何文字，字段如下：
{
  "summary": "一段不超过 3 句的今日总结，基于事实，不编造",
  "achievement": ["今天做成的具体事项，1-3 条，来自记录与完成任务"],
  "problem": ["今天遇到的阻碍或薄弱点，0-2 条，没有就空数组"],
  "suggestion": ["明天可执行的 1-2 条建议，要具体到动作"],
  "evaluation": "一段 1-2 句的成长评价，只评价趋势与节奏，不评价人格，不做医疗/心理诊断"
}

要求：只引用输入数据里出现的事实，不得编造；没有数据时如实说"今天还没有留下任何记录"；suggestion 用肯定句、可执行；不要输出 JSON 之外的文字。`;

export type EveningDigestResult = {
  content: EveningContent;
  replySource: "llm" | "rules";
};

/**
 * 生成结构化晚报内容。
 * @param contextText 由 contextToText 生成的上下文文本（token 可控）
 * @param fallback    规则回退内容（由调用方基于真实记录构造，保证 LLM 不可用时体验完整）
 */
export async function generateEveningDigest(
  contextText: string,
  fallback: EveningContent,
): Promise<EveningDigestResult> {
  const config = readConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { content: fallback, replySource: "rules" };
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
          { role: "user", content: `用户今日数据：\n${contextText}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { content: fallback, replySource: "rules" };
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const llmText = data.choices?.[0]?.message?.content;
    const parsed = llmText ? extractJson(llmText) : null;
    if (isEveningContent(parsed)) {
      return { content: parsed, replySource: "llm" };
    }
    return { content: fallback, replySource: "rules" };
  } catch {
    return { content: fallback, replySource: "rules" };
  } finally {
    clearTimeout(timeout);
  }
}
