import { getAgentSession, saveAgentSession } from "./session";
import { buildActionReply, parseAction, type ActionKind, type ParsedIntent } from "./understanding";

export type AgentIntent = ParsedIntent;

export type AgentResult = {
  intent: AgentIntent;
  reply: string;
  extracted?: {
    kind?: ActionKind;
    topic?: string;
    goal?: string;
    track?: "ai_agent";
    guide?: ReturnType<typeof parseAction>["guide"];
    minutes?: number;
    output?: string;
    confidence?: number;
    missing?: string[];
    corrected?: boolean;
  };
  mode: "demo" | "llm";
  provider: string;
  replySource?: "llm" | "rules";
};

type LlmConfig = {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function firstEnv(...keys: string[]) {
  return keys.map((key) => process.env[key]?.trim()).find(Boolean);
}

/** LLM 配置读取（供对话 Agent 与晚报结构化生成共用） */
export function readConfig(): LlmConfig {
  const provider = firstEnv("LLM_PROVIDER", "LLM_PROFILE") ?? "demo";
  const normalizedProvider = provider.toLowerCase();

  return {
    provider,
    baseUrl: firstEnv(
      "LLM_BASE_URL",
      normalizedProvider === "openai" ? "OPENAI_BASE_URL" : "",
      normalizedProvider === "deepseek" ? "DEEPSEEK_BASE_URL" : "",
      normalizedProvider === "glm" ? "GLM_BASE_URL" : "",
    ),
    apiKey: firstEnv(
      "LLM_API_KEY",
      normalizedProvider === "openai" ? "OPENAI_API_KEY" : "",
      normalizedProvider === "deepseek" ? "DEEPSEEK_API_KEY" : "",
      normalizedProvider === "glm" ? "GLM_API_KEY" : "",
    ),
    model: firstEnv(
      "LLM_MODEL",
      normalizedProvider === "openai" ? "OPENAI_MODEL" : "",
      normalizedProvider === "deepseek" ? "DEEPSEEK_MODEL" : "",
      normalizedProvider === "glm" ? "GLM_MODEL" : "",
    ),
  };
}

function resultFromAction(action: ReturnType<typeof parseAction>, provider: string, mode: "demo" | "llm", reply: string, replySource: "llm" | "rules"): AgentResult {
  return {
    intent: action.intent,
    reply,
    extracted: {
      kind: action.kind,
      topic: action.topic,
      goal: action.goal,
      track: action.track,
      guide: action.guide,
      minutes: action.minutes,
      output: action.output,
      confidence: action.confidence,
      missing: action.missing,
      corrected: action.isCorrection,
    },
    mode,
    provider,
    replySource,
  };
}

function isUsefulReply(reply: string | undefined, action?: ReturnType<typeof parseAction>) {
  if (!reply) return false;
  if (/(无法识别|没看懂|没看明白|请重新描述|重新说明|重新写明|输入似乎不完整|乱码)/.test(reply)) return false;
  if (action?.track === "ai_agent" && !/(Agent|agent|智能体)/.test(reply)) return false;
  return true;
}

export function getAgentStatus() {
  const config = readConfig();
  const configured = Boolean(config.baseUrl && config.apiKey && config.model);
  return {
    mode: configured ? "llm" : "demo",
    provider: configured ? config.provider : "demo",
    modelConfigured: Boolean(config.model),
    endpointConfigured: Boolean(config.baseUrl),
  } as const;
}

export async function runAgent(
  message: string,
  options?: { timeoutMs?: number; conversationId?: string; output?: string; context?: string },
): Promise<AgentResult> {
  const config = readConfig();
  const conversationId = options?.conversationId?.trim() || "anonymous";
  const output = options?.output?.trim();
  const context = options?.context?.trim();
  const sourceMessage = output ? `${message}\n输出：${output}` : message;
  const previous = getAgentSession(conversationId)?.lastAction;
  const action = parseAction(sourceMessage, previous);
  if (output) {
    action.output = output;
    action.missing = action.missing.filter((field) => field !== "成果证据" && field !== "结果记录");
    action.confidence = Math.max(action.confidence, 0.82);
  }
  saveAgentSession(conversationId, action);
  const ruleReply = buildActionReply(action);

  if (!config.baseUrl || !config.apiKey || !config.model) {
    return resultFromAction(action, config.provider, "demo", ruleReply, "rules");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 12_000);

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.15,
        messages: [
          {
            role: "system",
            content:
              "你是成长回路的行动记录助手。规则解析结果是事实底稿，不能擅自改变类别、主题、目标、时长或成果证据。kind 只有 focus、learn、exercise、life、rest 五类；运动要给可持续的下一步，休息要强调恢复，生活事项要给轻量收尾，学习/专注要给可执行产出。普通记录只返回一到三句简短中文：先确认记录，再给一个具体下一步。若 input 是晚报回顾，必须参考 context（如果有），先用一两句总结今天，再按 1、2、3 依次提出：最重要的行动、真正理解或应用的地方、明天的最小一步；不要要求白天补填额外字段。若 parsed.guide 存在，必须保留 AI Agent 学习目标，并至少提到两步今日行动，不能泛泛回复“已安排”。不要要求用户改写成日程格式，不做心理或医疗诊断。",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                input: message,
                output,
                previous,
                parsed: action,
                ruleReply,
                context,
              },
              null,
              2,
            ),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return resultFromAction(action, config.provider, "demo", ruleReply, "rules");
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const llmReply = data.choices?.[0]?.message?.content?.trim();
    return resultFromAction(action, config.provider, "llm", isUsefulReply(llmReply, action) ? llmReply! : ruleReply, isUsefulReply(llmReply, action) ? "llm" : "rules");
  } catch {
    return resultFromAction(action, config.provider, "demo", ruleReply, "rules");
  } finally {
    clearTimeout(timeout);
  }
}
