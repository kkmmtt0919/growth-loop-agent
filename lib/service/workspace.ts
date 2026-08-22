import { listGoals, createGoals } from "@/lib/repo/goals";
import { listTasks, toggleTask as repoToggleTask, createTasks } from "@/lib/repo/tasks";
import { createRecord as repoCreateRecord, listRecords, updateRecord as repoUpdateRecord } from "@/lib/repo/records";
import { applyLedger, listLedger } from "@/lib/repo/ledger";
import { findById } from "@/lib/repo/users";
import type { DbGoal, DbLedgerEntry, DbProfile, DbRecord, DbTask } from "@/lib/repo/types";
import { ServiceError } from "./errors";
import { buildSeedBundle } from "./seed";

/**
 * 工作台业务服务：播种、聚合查询、记录创建、任务切换、测验奖励。
 * 所有函数都显式接收 userId —— 多用户隔离决策在这一层。
 */

/** 首登播种（注册时调用一次；ledger 部分幂等） */
export async function seedForUser(userId: string): Promise<void> {
  const bundle = buildSeedBundle();
  await createGoals(userId, bundle.goals);
  await createTasks(userId, bundle.tasks);
  for (const record of bundle.records) {
    await repoCreateRecord({ userId, ...record });
  }
  for (const entry of bundle.ledger) {
    await applyLedger({
      userId,
      account: entry.account,
      amount: entry.amount,
      reason: entry.reason,
      sourceId: null,
      // seed key 加 userId 前缀：idempotency_key 唯一约束是全局的，
      // 不加前缀会导致第二个用户的 seed 入账与第一个用户冲突被跳过
      idempotencyKey: `seed:${userId}:${entry.idempotency_key}`,
    });
  }
}

export type WorkspaceData = {
  profile: DbProfile;
  goals: DbGoal[];
  tasks: DbTask[];
  records: DbRecord[];
  ledger: DbLedgerEntry[];
};

export async function getWorkspaceData(userId: string): Promise<WorkspaceData> {
  const profile = await findById(userId);
  if (!profile) {
    throw new ServiceError("用户不存在", 404);
  }
  const [goals, tasks, records, ledger] = await Promise.all([
    listGoals(userId),
    listTasks(userId),
    listRecords(userId),
    listLedger(userId),
  ]);
  return { profile, goals, tasks, records, ledger };
}

export type CreateRecordServiceInput = {
  text: string;
  topic?: string;
  kind?: DbRecord["kind"];
  minutes?: number | null;
  output?: string | null;
  intent?: DbRecord["intent"];
  mode?: DbRecord["mode"];
  xp?: number;
  coin?: number;
};

/** 创建记录 + 幂等入账（奖励拆分到账本） */
export async function createRecordWithReward(userId: string, input: CreateRecordServiceInput): Promise<DbRecord> {
  const xp = input.xp ?? 3;
  const coin = input.coin ?? 1;

  const record = await repoCreateRecord({
    userId,
    topic: input.topic || input.text.slice(0, 60) || "学习记录",
    text: input.text,
    kind: input.kind ?? null,
    minutes: input.minutes ?? null,
    output: input.output ?? null,
    intent: input.intent ?? "quick_log",
    mode: input.mode ?? "demo",
    xp,
    coin,
  });

  const key = `record:${record.id}`;
  await applyLedger({
    userId,
    account: "XP",
    amount: xp,
    reason: `记录：${record.topic || record.text.slice(0, 20)}`,
    sourceId: record.id,
    idempotencyKey: `${key}:xp`,
  });
  await applyLedger({
    userId,
    account: "COIN",
    amount: coin,
    reason: `记录：${record.topic || record.text.slice(0, 20)}`,
    sourceId: record.id,
    idempotencyKey: `${key}:coin`,
  });

  return record;
}

/** Agent 结构化提取回写 */
export async function updateRecord(userId: string, recordId: string, patch: Partial<Pick<DbRecord, "topic" | "kind" | "minutes" | "output" | "intent" | "mode">>) {
  const updated = await repoUpdateRecord(userId, recordId, patch);
  if (!updated) {
    throw new ServiceError("记录不存在", 404);
  }
  return updated;
}

/** 任务切换 + 事务内幂等入账/冲正 */
export async function toggleTask(userId: string, taskId: string, done: boolean): Promise<DbTask> {
  const updated = await repoToggleTask(userId, taskId, done);
  if (!updated) {
    throw new ServiceError("任务不存在", 404);
  }
  return updated;
}

/** 测验得分 bonus XP（与前端历史规则一致） */
export function bonusForScore(score: number): number {
  if (score >= 85) return 10;
  if (score >= 60) return 6;
  return 3;
}

/** 测验评分后发放 bonus（幂等，key 关联 quizId） */
export async function rewardQuiz(userId: string, quizId: string, topic: string, score: number): Promise<void> {
  await applyLedger({
    userId,
    account: "XP",
    amount: bonusForScore(score),
    reason: `理解测验：${topic}（${score} 分）`,
    sourceId: quizId,
    idempotencyKey: `quiz:${quizId}:bonus`,
  });
}
