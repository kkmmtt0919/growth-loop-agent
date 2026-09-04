import { readConfig } from "./provider";

/**
 * 聊天专用 LLM Provider（docs/DESIGN_CHAT_PANEL_V1.md §6）。
 * 与现有 provider.ts 的差异：
 *   - 多轮：把 L1 对话历史作为 messages[] 原样传（非单轮 + JSON 底稿）
 *   - 失败**抛错**（由 Service 决定是否落库 / 返回 error），不再内部回退固定文案
 *   - 12s 超时
 * 不改动现有 provider.ts。
 */

export type ChatMessageLite = {
  role: "user" | "assistant";
  content: string;
};

export type ChatWithMemoryInput = {
  /** 独立聊天人格 + L2 业务事实（参考材料段） */
  system: string;
  /** 最近对话历史（时间正序），供多轮上下文 */
  history: ChatMessageLite[];
  /** 当前这条 user 消息 */
  message: string;
  timeoutMs?: number;
};

/** 调 LLM 返回纯文本回复；失败抛 Error（由调用方决定落库/展示），超时默认 12s */
export async function chatWithMemory(input: ChatWithMemoryInput): Promise<string> {
  const config = readConfig();

  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("chat unavailable: LLM 未配置");
  }

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: input.system },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.message },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 12_000);

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.7,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`chat LLM 返回 ${response.status}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("chat LLM 返回空回复");
    }
    return reply;
  } finally {
    clearTimeout(timeout);
  }
}
