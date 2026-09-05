import { listAgentRuns, type AgentRunListRow } from "@/lib/repo/agent-runs";

/**
 * Agent 运行记录只读服务（Smart Planner Step 7c）。
 * 定位：agent_runs 是调试/评估/复盘数据源（Step 6a 落库），此处提供用户侧最小只读视图——
 * 只暴露 agentType/promptVersion/success/latencyMs/createdAt，不含 input/output 明文。
 * 范围守界：不做后台、不做统计、不做 trace 详情。
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function listAgentRunsForUser(
  userId: string,
  limit?: number,
): Promise<AgentRunListRow[]> {
  const n = limit == null || !Number.isFinite(limit) ? DEFAULT_LIMIT : Math.floor(limit);
  const clamped = Math.min(MAX_LIMIT, Math.max(1, n));
  return listAgentRuns(userId, clamped);
}
