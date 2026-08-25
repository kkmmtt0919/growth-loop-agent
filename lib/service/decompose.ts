import { getGoal, listTaskTitlesByGoal } from "@/lib/repo/goals";
import { getPool } from "@/lib/repo/pool";
import { createTaskTx, type CreateTaskInput } from "@/lib/repo/tasks";
import type { DbGoal, DbTask } from "@/lib/repo/types";
import { generateDecomposePlan, type StepRange } from "@/lib/agent/decompose-generator";
import { normalizeTitle } from "@/lib/agent/decompose-validator";
import { mapCategoryToKind } from "./category-mapper";
import { ServiceError } from "./errors";
import { todayInShanghai } from "./time";

/**
 * 目标拆解服务（Agent Decompose V1）。
 * 流程：getGoal(404) → Context（目标 + 已有任务）→ 步数范围 → LLM Planner（重试 1 次）→ 规则回退
 *       → 事务批量创建（事务内按归一化 title 查重跳过，全有全无）。
 */

/** 步数范围：优先 end_date 计算天数；无则按 horizon 文本启发式；默认 30 天档 */
export function computeStepRange(goal: Pick<DbGoal, "end_date" | "horizon">): StepRange {
  let days: number;
  if (goal.end_date) {
    const end = new Date(`${goal.end_date}T00:00:00Z`).getTime();
    const today = new Date(`${todayInShanghai()}T00:00:00Z`).getTime();
    days = Math.max(1, Math.round((end - today) / 86_400_000));
  } else {
    const horizon = goal.horizon ?? "";
    const weekMatch = horizon.match(/(\d+)\s*周/);
    const monthMatch = horizon.match(/(\d+)\s*个月/);
    days = weekMatch ? Number(weekMatch[1]) * 7 : monthMatch ? Number(monthMatch[1]) * 30 : 30;
  }
  if (days <= 7) return { min: 2, max: 3 };
  if (days <= 30) return { min: 3, max: 4 };
  if (days <= 90) return { min: 4, max: 6 };
  return { min: 5, max: 8 };
}

function buildContextText(goal: DbGoal, existingTitles: string[], range: StepRange): string {
  const lines: string[] = [
    `目标：${goal.title}`,
    `描述：${goal.description?.trim() || "无"}`,
    `周期：${goal.end_date ?? goal.horizon?.trim() ?? "未设置"}`,
    `stepRange：${range.min}-${range.max}`,
  ];
  if (existingTitles.length > 0) {
    lines.push("已有任务：");
    for (const title of existingTitles) lines.push(`- ${title}`);
  } else {
    lines.push("已有任务：无");
  }
  return lines.join("\n");
}

export type DecomposeResult = {
  count: number;
  source: "llm" | "rules";
  createdTaskIds: string[];
  tasks: DbTask[];
};

export async function decomposeGoal(userId: string, goalId: string): Promise<DecomposeResult> {
  const goal = await getGoal(userId, goalId);
  if (!goal) throw new ServiceError("目标不存在", 404);
  if (!goal.title?.trim()) throw new ServiceError("目标没有可拆解的内容", 400);

  const existingTitles = await listTaskTitlesByGoal(userId, goalId);
  const range = computeStepRange(goal);
  const contextText = buildContextText(goal, existingTitles, range);

  const { steps, source } = await generateDecomposePlan({
    goalTitle: goal.title,
    contextText,
    range,
    existingTitles,
  });

  const client = await getPool().connect();
  try {
    await client.query("begin");
    // 事务内查已有标题（含并发生成刚插入的），归一化去重跳过
    const { rows: existingRows } = await client.query<{ title: string }>(
      `select title from public.tasks where user_id = $1 and goal_id = $2`,
      [userId, goalId],
    );
    const seen = new Set(existingRows.map((r) => normalizeTitle(r.title)));
    const created: DbTask[] = [];
    for (const step of steps) {
      const norm = normalizeTitle(step.title);
      if (seen.has(norm)) continue;
      seen.add(norm);
      const input: CreateTaskInput = {
        title: step.title,
        goalId,
        subtitle: step.description,
        durationMinutes: step.estimatedMinutes,
        kind: mapCategoryToKind(step.category),
        acceptance: step.acceptance,
      };
      created.push(await createTaskTx(client, userId, input));
    }
    await client.query("commit");
    return { count: created.length, source, createdTaskIds: created.map((t) => t.id), tasks: created };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
