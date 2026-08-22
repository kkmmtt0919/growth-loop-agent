/**
 * 数据库行类型（与 supabase/migrations/001_init.sql 对应）。
 * 纯标准 PG 表结构的 TypeScript 投影，字段名 snake_case。
 */

export type DbProfile = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  level: number;
  role: string;
  streak: number;
  xp_balance: number;
  coin_balance: number;
  created_at: string;
  updated_at: string;
};

export type DbGoal = {
  id: string;
  user_id: string;
  title: string;
  description: string;
  progress: number;
  horizon: string;
  status: "进行中" | "待复盘" | "已归档";
  created_at: string;
  updated_at: string;
};

export type DbTask = {
  id: string;
  user_id: string;
  goal_id: string | null;
  title: string;
  subtitle: string;
  scheduled_time: string;
  duration_minutes: number | null;
  xp: number;
  coin: number;
  status: "done" | "current" | "upcoming";
  kind: "focus" | "learn" | "exercise" | "life" | "rest";
  version: number;
  created_at: string;
  updated_at: string;
};

export type DbRecord = {
  id: string;
  user_id: string;
  topic: string;
  text: string;
  kind: "focus" | "learn" | "exercise" | "life" | "rest" | null;
  minutes: number | null;
  output: string | null;
  intent: "quick_log" | "plan_today" | "review";
  evidence: "输入" | "输入 + 输出" | "应用" | null;
  xp: number;
  coin: number;
  mode: "llm" | "demo" | "pending";
  occurred_at: string;
  created_at: string;
};

export type DbLedgerEntry = {
  id: string;
  user_id: string;
  account: "XP" | "COIN";
  amount: number;
  reason: string;
  source_id: string | null;
  idempotency_key: string;
  occurred_at: string;
  created_at: string;
};

export type DbQuizSession = {
  id: string;
  user_id: string;
  record_id: string | null;
  topic: string;
  source_summary: string;
  questions: unknown;
  answers: unknown;
  score: number | null;
  level: string | null;
  graded_by: "llm" | "rules" | null;
  mode: string;
  created_at: string;
  graded_at: string | null;
};

/** 种子播种入参：从 demoSeed 提取的可持久化部分 */
export type SeedBundle = {
  goals: Array<Pick<DbGoal, "title" | "description" | "progress" | "horizon" | "status">>;
  tasks: Array<Pick<DbTask, "title" | "subtitle" | "scheduled_time" | "duration_minutes" | "xp" | "coin" | "status" | "kind">>;
  records: Array<Pick<DbRecord, "topic" | "text" | "kind" | "minutes" | "output" | "intent" | "evidence" | "xp" | "coin" | "mode">>;
  ledger: Array<Pick<DbLedgerEntry, "account" | "amount" | "reason" | "idempotency_key">>;
};
