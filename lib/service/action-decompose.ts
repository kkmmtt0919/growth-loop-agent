import { getGoal } from "@/lib/repo/goals";
import { createActionsWithDepsTx, listActionsByGoal, type DbAction } from "@/lib/repo/planner";
import type { DbGoal } from "@/lib/repo/types";
import { generateActionPlan } from "@/lib/agent/action-plan-generator";
import { actionStageRange } from "@/lib/agent/core/pure";
import { ServiceError } from "./errors";
import { estimateRemainingDays } from "./time";

/**
 * 目标行动路线服务（Smart Planner Step 2「制定行动路线」，战略层）。
 * 与 lib/service/decompose.ts（战术层「拆今日任务」）**独立并存、互不调用**——
 * 旧 decompose 原样保留，本服务是新增链路。
 *
 * 流程：getGoal(404/400) → 剩余天数 → 阶段数分档(3-6, D2 定稿) → 既有行动标题 →
 *   ActionPlan Generator（LLM→校验→规则回退）→ 单事务落 actions + 依赖(环检测去边)。
 * 产物只写 actions / action_dependencies，**不碰 tasks**（不污染今日时间轴）。
 */

export type ActionView = {
  id: string;
  goalId: string;
  title: string;
  description: string | null;
  /** 完成整个阶段的预计总投入（分钟），非单次执行时长 */
  estimatedMinutes: number;
  priority: number;
  status: DbAction["status"];
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  /** 依赖的前置阶段标题（展示徽标用） */
  dependsOnTitles: string[];
};

export type ActionRouteResult = {
  count: number;
  source: "llm" | "rules";
  skipped: number;
  actions: ActionView[];
};

function buildContextText(goal: DbGoal, existingTitles: string[], range: { min: number; max: number }): string {
  const lines: string[] = [
    `目标：${goal.title}`,
    `描述：${goal.description?.trim() || "无"}`,
    `周期：${goal.end_date ?? goal.horizon?.trim() ?? "未设置"}`,
    `range：行动阶段 ${range.min}-${range.max} 个`,
  ];
  if (existingTitles.length > 0) {
    lines.push("已有行动阶段：");
    for (const title of existingTitles) lines.push(`- ${title}`);
  } else {
    lines.push("已有行动阶段：无");
  }
  return lines.join("\n");
}

export async function decomposeToActions(userId: string, goalId: string): Promise<ActionRouteResult> {
  const goal = await getGoal(userId, goalId);
  if (!goal) throw new ServiceError("目标不存在", 404);
  if (!goal.title?.trim()) throw new ServiceError("目标没有可拆解的内容", 400);

  const days = estimateRemainingDays(goal.end_date, goal.horizon);
  const range = actionStageRange(days);
  const existingActions = await listActionsByGoal(userId, goalId);
  const existingTitles = existingActions.map((a) => a.title);
  const contextText = buildContextText(goal, existingTitles, range);

  const { actions: drafts, source } = await generateActionPlan({
    goalTitle: goal.title,
    contextText,
    range,
    existingTitles,
  });

  const { actions, dependencies, skipped } = await createActionsWithDepsTx(
    userId,
    goalId,
    drafts.map((d) => ({
      title: d.title,
      description: d.description,
      estimatedMinutes: d.estimatedMinutes,
      priority: d.priority,
      dependsOnTitles: d.dependsOnTitles,
    })),
  );

  // 依赖 id → 标题（供前端直接展示「依赖：确定方向」）
  const titleById = new Map(actions.map((a) => [a.id, a.title]));
  const depsByAction = new Map<string, string[]>();
  for (const dep of dependencies) {
    const list = depsByAction.get(dep.actionId) ?? [];
    const title = titleById.get(dep.dependsOnActionId);
    if (title) list.push(title);
    depsByAction.set(dep.actionId, list);
  }

  const views: ActionView[] = actions.map((a) => ({
    id: a.id,
    goalId: a.goal_id,
    title: a.title,
    description: a.description,
    estimatedMinutes: a.estimated_minutes,
    priority: a.priority,
    status: a.status,
    completedAt: a.completed_at,
    sortOrder: a.sort_order,
    createdAt: a.created_at,
    dependsOnTitles: depsByAction.get(a.id) ?? [],
  }));

  return { count: views.length, source, skipped, actions: views };
}
