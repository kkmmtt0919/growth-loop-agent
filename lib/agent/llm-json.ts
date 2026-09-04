import { readConfig } from "./provider";

/**
 * 共享 LLM JSON 调用骨架（Smart Planner Step 2 起引入）。
 * 定位：只负责「一次 OpenAI 兼容 /chat/completions 调用并强制 json_object 输出」，返回**模型原始文本**。
 * 不做任何 schema 校验 / 语义判断——那些属于各自的 generator（action-plan-generator / decompose-generator）。
 *
 * 为什么抽这一层（用户审核 §四，2026-09-04）：
 *   - 两个 generator 的 prompt 未来一定会分叉，不应「复制 decompose-generator 后只改字段」；
 *   - 共享的是「LLM 调用 + 失败返回 null」的机械部分，业务 prompt/校验/回退各自独立。
 * 旧 decompose-generator.ts 保留自身私有 callPlanner（旧链路不动），此模块先供新 ActionPlan 使用，
 * 未来若重构旧链路可统一迁移到这里。
 */
export async function callLLMJson(input: {
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string | null> {
  const config = readConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: input.temperature ?? 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
