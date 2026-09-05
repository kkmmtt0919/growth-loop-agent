import { getGoal } from "@/lib/repo/goals";
import {
  createActionsWithDepsTx,
  listActionsByGoal,
  getAction,
  updateAction,
  listActionsByUser,
  listDependenciesByUser,
  listDependenciesByGoal,
  batchDeleteActions,
  type DbAction,
} from "@/lib/repo/planner";
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
  /** 累计实际投入（execution_records 汇总；无执行 0）——Action 投入唯一统计来源（STEP5 §5） */
  spentMinutes: number;
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
    userId,
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

  const views = buildActionViews(actions, dependencies);
  return { count: views.length, source, skipped, actions: views };
}

export type ResolvedDependencyLike = { actionId: string; dependsOnActionId: string };

/**
 * 组装 ActionView（DbAction[] + 依赖 → 前端视图）。
 * generate（新生成）/ list（回显）/ goals.deriveView（卡片内嵌）共用，避免三处各自拼装。
 * spentByAction：execution_records 累计投入（actionId → 分钟）；不传则全部 0。
 *   —— Action 实际投入的唯一统计来源是 execution_records（records 仅成长事件补充，勿混用）。
 */
export function buildActionViews(
  actions: DbAction[],
  deps: ResolvedDependencyLike[],
  spentByAction?: ReadonlyMap<string, number>,
): ActionView[] {
  const titleById = new Map(actions.map((a) => [a.id, a.title]));
  const depsByAction = new Map<string, string[]>();
  for (const dep of deps) {
    const title = titleById.get(dep.dependsOnActionId);
    if (!title) continue; // 依赖目标不在本批视图内 → 忽略（跨目标依赖不存在）
    const list = depsByAction.get(dep.actionId) ?? [];
    if (!list.includes(title)) list.push(title);
    depsByAction.set(dep.actionId, list);
  }
  return actions.map((a) => ({
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
    spentMinutes: spentByAction?.get(a.id) ?? 0,
  }));
}

/** 回显行动路线：当前用户全部（可选按目标过滤）。GET /api/actions?goal_ids= */
export async function listActionViews(userId: string, goalIds?: string[]): Promise<ActionView[]> {
  const [actions, deps] = await Promise.all([listActionsByUser(userId), listDependenciesByUser(userId)]);
  const filtered = goalIds && goalIds.length > 0 ? actions.filter((a) => goalIds.includes(a.goal_id)) : actions;
  return buildActionViews(filtered, deps.map((d) => ({ actionId: d.action_id, dependsOnActionId: d.depends_on })));
}

/**
 * 手动标记 Action 完成 / 撤销完成（D5：不入 records/账本，只记 completed_at）。
 * 状态白名单仅 'completed' | 'pending'（Action 是「阶段是否完成」语义，非执行状态）；
 * planned（已进入 Planner 排程，Step 3 才会出现）拒绝手动切换；
 * **不做依赖校验**（依赖是 Planner 建议，不限制用户线性跳跃）。
 */
export async function setActionStatus(
  userId: string,
  actionId: string,
  status: "completed" | "pending",
): Promise<ActionView> {
  const action = await getAction(userId, actionId);
  if (!action) throw new ServiceError("行动阶段不存在", 404);
  if (action.status === "planned") throw new ServiceError("该阶段已安排计划，请先撤销安排再操作", 409);
  const updated = await updateAction(userId, actionId, { status });
  if (!updated) throw new ServiceError("行动阶段不存在", 404);
  const deps = await listDependenciesByGoal(userId, updated.goal_id);
  const view = buildActionViews([updated], deps.map((d) => ({ actionId: d.action_id, dependsOnActionId: d.depends_on })));
  return view[0];
}

/** 整批撤销行动路线（undo）。幂等：ids 中越权/不存在的自动忽略，返回实际删除数。 */
export async function removeActions(userId: string, actionIds: string[]): Promise<number> {
  return batchDeleteActions(userId, actionIds);
}
