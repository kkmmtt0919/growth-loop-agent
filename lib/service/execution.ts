import { updateExecutionActual, type DbExecution } from "@/lib/repo/execution";
import { ServiceError } from "./errors";

/**
 * 执行记录服务（Smart Planner Step 5b「行内编辑实际分钟」）。
 * 只改 execution_records.actual_minutes——**绝不影响 schedule 时长/状态、action 状态、账本**。
 */

/** 修改实际投入分钟（1-1440 整数；用户 5b 规则：修改后 PATCH execution，不改 schedule duration） */
export async function setExecutionActualMinutes(
  userId: string,
  executionId: string,
  actualMinutes: number,
): Promise<DbExecution> {
  if (!Number.isInteger(actualMinutes) || actualMinutes < 1 || actualMinutes > 1440) {
    throw new ServiceError("actualMinutes 应为 1-1440 的整数", 400);
  }
  const updated = await updateExecutionActual(userId, executionId, actualMinutes);
  if (!updated) throw new ServiceError("执行记录不存在", 404);
  return updated;
}
