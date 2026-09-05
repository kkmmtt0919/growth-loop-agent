import { createReflection, listReflections, type DbReflection } from "@/lib/repo/reflection";
import { getGoal } from "@/lib/repo/goals";
import { getAction } from "@/lib/repo/planner";
import { ServiceError } from "./errors";

/**
 * Reflection 业务服务（Smart Planner Step 6a）。
 * 定位（DESIGN_SMART_PLANNER_STEP6 §1/D1/D5）：用户反馈进 Agent Loop——
 * MVP 只记录 + 查询；planner prompt 注入最近 ≤3 条「仅参考」；不做规则化自动调整。
 * 红线：**不进 XP/coin**（同 execution_records）。
 */

const SOURCE_SET = new Set<DbReflection["source"]>(["planner", "weekly", "manual"]);

export type CreateReflectionServiceInput = {
  goalId?: string | null;
  actionId?: string | null;
  source: string;
  content: string;
  rating?: string | null;
};

/** 创建反馈：content 1-500、source/rating 白名单、goal/action 归属校验（越权 404）+ goal 一致性（400） */
export async function addReflection(
  userId: string,
  input: CreateReflectionServiceInput,
): Promise<DbReflection> {
  const source = input.source as DbReflection["source"];
  if (!SOURCE_SET.has(source)) {
    throw new ServiceError("source 应为 planner/weekly/manual", 400);
  }
  const content = (input.content ?? "").trim();
  if (content.length < 1 || content.length > 500) {
    throw new ServiceError("content 应为 1-500 字", 400);
  }
  const rating = (input.rating ?? null) as DbReflection["rating"];
  if (rating !== null && rating !== "good" && rating !== "bad") {
    throw new ServiceError("rating 应为 good/bad 或留空", 400);
  }

  const goalId = input.goalId?.trim() || null;
  const actionId = input.actionId?.trim() || null;
  if (!goalId && !actionId) {
    throw new ServiceError("goalId 与 actionId 至少提供一个", 400);
  }

  // 归属校验：goal/action 必须属于本人（跨用户 404，不泄露存在性）
  if (goalId) {
    const goal = await getGoal(userId, goalId);
    if (!goal) throw new ServiceError("目标不存在", 404);
  }
  let actionGoalId: string | null = null;
  if (actionId) {
    const action = await getAction(userId, actionId);
    if (!action) throw new ServiceError("行动阶段不存在", 404);
    actionGoalId = action.goal_id;
  }
  // goal 一致性：同时提供时，action 必须属于该 goal
  if (goalId && actionId && actionGoalId !== goalId) {
    throw new ServiceError("该行动阶段不属于此目标", 400);
  }

  return createReflection(userId, { goalId, actionId, source, content, rating });
}

/** 反馈列表（created_at 倒序；limit ≤20；可选按 goal 过滤） */
export async function listReflectionsForUser(
  userId: string,
  options?: { goalId?: string; limit?: number },
): Promise<DbReflection[]> {
  if (options?.goalId) {
    const goal = await getGoal(userId, options.goalId);
    if (!goal) throw new ServiceError("目标不存在", 404);
  }
  return listReflections(userId, options);
}
