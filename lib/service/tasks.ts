import {
  createTask,
  deleteTask,
  getTask,
  listTasksByFilter,
  updateTask,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "@/lib/repo/tasks";
import type { DbTask } from "@/lib/repo/types";
import { ServiceError } from "./errors";

/**
 * 任务业务服务（Phase 1）。
 * 决策（docs/DESIGN_PHASE1_PLAN_REAL.md v2）：
 * - PUT 只改元数据，拒绝 status/xp/coin（防绕过账本与状态机）；状态变更唯一通道是 PATCH /api/tasks
 * - DELETE 不冲正账本（产品设计 §6.5）
 * - createTask 防重复：同 goal_id + title 已存在 → 409（幂等语义）
 */

export const TASK_STATUS = {
  DONE: "done",
  CURRENT: "current",
  UPCOMING: "upcoming",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TASK_KIND = ["focus", "learn", "exercise", "life", "rest"] as const;
export type TaskKind = (typeof TASK_KIND)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string | null | undefined, field: string) {
  if (value !== undefined && value !== null && !DATE_RE.test(value)) {
    throw new ServiceError(`${field} 格式应为 YYYY-MM-DD`, 400);
  }
}

function assertMinutes(value: number | null | undefined) {
  if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0 || value > 1440)) {
    throw new ServiceError("durationMinutes 应为 0-1440 的整数", 400);
  }
}

function assertKind(value: unknown) {
  if (value !== undefined && value !== null && !TASK_KIND.includes(value as TaskKind)) {
    throw new ServiceError(`kind 不合法，应为 ${TASK_KIND.join(" / ")}`, 400);
  }
}

/** 防重复：同目标下同标题任务已存在（goal_id 为 null 时仅查 title 重复，仍拦截无目标重复） */
async function assertNoDuplicate(userId: string, input: CreateTaskInput) {
  const title = input.title.trim();
  const existing = await listTasksByFilter(userId, { goalId: input.goalId ?? null });
  if (existing.some((t) => t.title === title)) {
    throw new ServiceError("同目标下已存在同名任务", 409);
  }
}

export async function createTaskForUser(userId: string, input: CreateTaskInput): Promise<DbTask> {
  const title = input.title?.trim();
  if (!title) throw new ServiceError("title 必填", 400);
  assertDate(input.deadline, "deadline");
  assertMinutes(input.durationMinutes);
  assertKind(input.kind);
  await assertNoDuplicate(userId, { ...input, title });
  return createTask(userId, { ...input, title });
}

export async function listTasksForUser(
  userId: string,
  filter: { goalId?: string | null; status?: TaskStatus } = {},
): Promise<DbTask[]> {
  return listTasksByFilter(userId, {
    goalId: filter.goalId,
    status: filter.status,
  });
}

/**
 * 更新任务元数据（入参为宽类型，内部白名单过滤）。
 * 硬规则：拒绝 status/xp/coin（防绕过账本与状态机）——状态变更必须走 PATCH /api/tasks。
 */
export async function updateTaskForUser(userId: string, taskId: string, input: Record<string, unknown>): Promise<DbTask> {
  const forbidden = Object.keys(input).filter((k) => ["xp", "coin", "status"].includes(k));
  if (forbidden.length > 0) {
    throw new ServiceError(
      `字段 ${forbidden.join("/")} 不允许通过此接口修改：状态变化请走 PATCH /api/tasks，xp/coin 由规则引擎结算`,
      400,
    );
  }

  const patch: UpdateTaskInput = {};
  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new ServiceError("title 不能为空", 400);
    patch.title = title;
  }
  if (typeof input.subtitle === "string") patch.subtitle = input.subtitle;
  if (typeof input.scheduledTime === "string") patch.scheduledTime = input.scheduledTime;
  if (typeof input.durationMinutes === "number") patch.durationMinutes = input.durationMinutes;
  if (input.deadline !== undefined && input.deadline !== null) patch.deadline = String(input.deadline);
  if (typeof input.frequency === "string") patch.frequency = input.frequency;
  if (typeof input.kind === "string") patch.kind = input.kind as TaskKind;
  if (input.goalId !== undefined && input.goalId !== null) patch.goalId = String(input.goalId);

  assertDate(patch.deadline, "deadline");
  assertMinutes(patch.durationMinutes);
  assertKind(patch.kind);

  const task = await updateTask(userId, taskId, patch);
  if (!task) throw new ServiceError("任务不存在", 404);
  return task;
}

export async function deleteTaskForUser(userId: string, taskId: string): Promise<void> {
  const exists = await getTask(userId, taskId);
  if (!exists) throw new ServiceError("任务不存在", 404);
  await deleteTask(userId, taskId);
}
