import { getPool } from "./pool";

/**
 * Agent Trace 仓储层（Smart Planner Step 6c）。
 * agent_runs = 每次 LLM Agent 调用的一条 run：成功/失败都记录（补充 B：落库失败 console.warn、
 * 不影响主链路——该策略在 llm-json wrapper 层实现，本文件只提供纯 insert）。
 * user_id nullable（补充 A：未来系统级 Agent 无用户）；不进 XP/coin。
 */

export type AgentRunTraceType = "action-plan" | "planner" | "weekly" | "evening";

export type InsertAgentRunInput = {
  userId: string | null;
  agentType: AgentRunTraceType;
  promptVersion: string;
  /** 元信息对象（{systemLength, userPreview≤2000, temperature}）；jsonb 落库 */
  inputContext: unknown;
  /** 输出预览对象/文本（截断后）；失败时 null */
  outputJson: unknown;
  latencyMs: number;
  success: boolean;
  errorMessage?: string | null;
};

export async function insertAgentRun(input: InsertAgentRunInput): Promise<void> {
  await getPool().query(
    `insert into public.agent_runs
       (user_id, agent_type, prompt_version, input_context, output_json, latency_ms, success, error_message)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
    [
      input.userId,
      input.agentType,
      input.promptVersion,
      JSON.stringify(input.inputContext ?? null),
      input.outputJson == null ? null : JSON.stringify(input.outputJson),
      Math.max(0, Math.round(input.latencyMs)),
      input.success,
      input.errorMessage ?? null,
    ],
  );
}
