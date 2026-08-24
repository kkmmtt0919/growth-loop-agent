import { countTasksByGoal, createGoal, deleteGoal, getGoal, listGoals, updateGoal } from "@/lib/repo/goals";
import type { DbGoal } from "@/lib/repo/types";
import { ServiceError } from "./errors";

/**
 * 目标业务服务（Phase 1）。
 * 决策（docs/DESIGN_PHASE1_PLAN_REAL.md v2）：
 * - progress 是 legacy cache，业务不写；API 返回派生 progress/taskCount/doneCount（事实来源 tasks.status）
 * - status 保留中文枚举，通过 GOAL_STATUS 常量引用，代码不散落中文
 * - 按 id 操作一律 id + user_id（隔离；跨用户返回 404）
 */

export const GOAL_STATUS = {
  ACTIVE: "进行中",
  REVIEW: "待复盘",
  ARCHIVED: "已归档",
} as const;

export type GoalStatus = (typeof GOAL_STATUS)[keyof typeof GOAL_STATUS];

export type GoalView = DbGoal & {
  taskCount: number;
  doneCount: number;
  /** 派生进度 0-100（无任务时为 0，全 done 为 100） */
  progress: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertValidDates(startDate?: string | null, endDate?: string | null) {
  if (startDate !== undefined && startDate !== null && !DATE_RE.test(startDate)) {
    throw new ServiceError("startDate 格式应为 YYYY-MM-DD", 400);
  }
  if (endDate !== undefined && endDate !== null && !DATE_RE.test(endDate)) {
    throw new ServiceError("endDate 格式应为 YYYY-MM-DD", 400);
  }
  if (startDate && endDate && endDate < startDate) {
    throw new ServiceError("endDate 不能早于 startDate", 400);
  }
}

async function deriveView(goal: DbGoal): Promise<GoalView> {
  const { total, done } = await countTasksByGoal(goal.user_id, goal.id);
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  return { ...goal, taskCount: total, doneCount: done, progress };
}

export type CreateGoalInput = {
  title: string;
  description?: string;
  startDate?: string | null;
  endDate?: string | null;
  horizon?: string;
};

export async function createGoalForUser(userId: string, input: CreateGoalInput): Promise<GoalView> {
  const title = input.title?.trim();
  if (!title) throw new ServiceError("title 必填", 400);
  assertValidDates(input.startDate, input.endDate);
  const goal = await createGoal(userId, {
    title,
    description: input.description?.trim() ?? "",
    horizon: input.horizon?.trim() ?? "",
    status: GOAL_STATUS.ACTIVE,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
  });
  return deriveView(goal);
}

export type ListGoalsFilter = { status?: GoalStatus };

export async function listGoalsForUser(userId: string, filter: ListGoalsFilter = {}): Promise<GoalView[]> {
  const goals = await listGoals(userId);
  const filtered = filter.status ? goals.filter((g) => g.status === filter.status) : goals;
  return Promise.all(filtered.map(deriveView));
}

export type UpdateGoalInput = {
  title?: string;
  description?: string;
  startDate?: string | null;
  endDate?: string | null;
  horizon?: string;
  status?: GoalStatus;
};

export async function updateGoalForUser(userId: string, goalId: string, input: UpdateGoalInput): Promise<GoalView> {
  const patch: Parameters<typeof updateGoal>[2] = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new ServiceError("title 不能为空", 400);
    patch.title = title;
  }
  if (input.description !== undefined) patch.description = input.description.trim();
  if (input.horizon !== undefined) patch.horizon = input.horizon.trim();
  if (input.status !== undefined) {
    if (!Object.values(GOAL_STATUS).includes(input.status)) {
      throw new ServiceError(`status 不合法，应为 ${Object.values(GOAL_STATUS).join(" / ")}`, 400);
    }
    patch.status = input.status;
  }
  if (input.startDate !== undefined) patch.startDate = input.startDate;
  if (input.endDate !== undefined) patch.endDate = input.endDate;
  assertValidDates(patch.startDate, patch.endDate);

  const goal = await updateGoal(userId, goalId, patch);
  if (!goal) throw new ServiceError("目标不存在", 404);
  return deriveView(goal);
}

export async function deleteGoalForUser(userId: string, goalId: string): Promise<void> {
  const exists = await getGoal(userId, goalId);
  if (!exists) throw new ServiceError("目标不存在", 404);
  await deleteGoal(userId, goalId);
}
