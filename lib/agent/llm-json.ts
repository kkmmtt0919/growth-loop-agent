import { readConfig } from "./provider";
import { insertAgentRun, type AgentRunTraceType } from "@/lib/repo/agent-runs";

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
 *
 * Step 6c Trace（DESIGN_SMART_PLANNER_STEP6 §3）：
 *   传入 trace 时，每次调用（无论成功/失败）落一条 agent_runs；落库失败 console.warn、不影响主流程（补充 B）。
 *   input_context 只存元信息 + user 预览 ≤2000 字，prompt 全文不入库（隐私/体积，D6）。
 */

/** Trace 元信息（各 generator 传入；agent_type 覆盖 action-plan/planner/weekly/evening 四类） */
export type LlmTraceInfo = {
  /** 用户 id；系统级调用可 null（补充 A） */
  userId: string | null;
  agentType: AgentRunTraceType;
  /** 字符串版本号（如 'action-plan-v1'，D4：不建 registry） */
  promptVersion: string;
};

const USER_PREVIEW_LIMIT = 2000;

export async function callLLMJson(input: {
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number;
  /** 传入则每次调用落一条 agent_runs（成功/失败都记，补充 B） */
  trace?: LlmTraceInfo;
}): Promise<string | null> {
  const config = readConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) return null;

  const temperature = input.temperature ?? 0.3;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const startedAt = Date.now();

  /** 落一条 run；任何落库异常 console.warn、绝不影响主流程（补充 B） */
  const recordRun = (success: boolean, outputJson: unknown, errorMessage: string | null) => {
    if (!input.trace) return;
    void insertAgentRun({
      userId: input.trace.userId,
      agentType: input.trace.agentType,
      promptVersion: input.trace.promptVersion,
      inputContext: {
        systemLength: input.system.length,
        userPreview: input.user.slice(0, USER_PREVIEW_LIMIT),
        temperature,
      },
      outputJson,
      // 瞬时失败（如本地连接拒绝）可能落在同一毫秒 → 下限 1ms 保证 latency 可观测
      latencyMs: Math.max(1, Date.now() - startedAt),
      success,
      errorMessage,
    }).catch((e) => console.warn("[agent-trace] agent_runs 写入失败（不影响主流程）:", e));
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      recordRun(false, null, `http_status_${response.status}`);
      return null;
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim() || null;
    if (text === null) {
      recordRun(false, null, "empty_content");
    } else {
      recordRun(true, { preview: text.slice(0, USER_PREVIEW_LIMIT) }, null);
    }
    return text;
  } catch (e) {
    recordRun(false, null, e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
