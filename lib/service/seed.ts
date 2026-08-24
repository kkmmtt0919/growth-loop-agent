import { demoSeed, todayShanghaiDateLabel, todayShanghaiWeekdayLabel } from "@/lib/demo-data";
import type { DbProfile, DbRecord, DbTask, SeedBundle } from "@/lib/repo/types";

/**
 * demo seed 与数据库之间的桥接：
 * - buildSeedBundle(): demoSeed → 可持久化的 SeedBundle（首登播种用）
 * - map*(): 数据库行 → 前端 DemoSeed 形状（保持页面兼容）
 */

export function buildSeedBundle(): SeedBundle {
  return {
    goals: demoSeed.goals.map((g) => ({
      title: g.title,
      description: g.description,
      progress: g.progress,
      horizon: g.horizon,
      status: g.status,
    })),
    tasks: demoSeed.tasks.map((t) => ({
      title: t.title,
      subtitle: t.subtitle,
      scheduled_time: t.time,
      duration_minutes: parseInt(t.duration.replace(/\D/g, ""), 10) || null,
      xp: t.xp,
      coin: t.coin,
      status: t.status,
      kind: t.kind,
    })),
    records: demoSeed.learningLogs.map((log) => ({
      topic: log.topic,
      text: log.summary,
      kind: null,
      minutes: null,
      output: log.evidence === "应用" ? "应用了所学内容" : null,
      intent: "quick_log" as const,
      evidence: log.evidence,
      xp: log.xp,
      coin: log.coin,
      mode: "demo" as const,
    })),
    ledger: demoSeed.ledger.map((entry) => ({
      account: entry.account,
      amount: entry.amount,
      reason: entry.reason,
      idempotency_key: entry.id,
    })),
  };
}

export function mapProfileToSeedUser(profile: DbProfile): typeof demoSeed.user {
  return {
    displayName: profile.display_name || "成长探索者",
    level: profile.level,
    role: profile.role,
    streak: profile.streak,
    focusScore: 76,
    xpBalance: profile.xp_balance,
    coinBalance: profile.coin_balance,
    dateLabel: todayShanghaiDateLabel(),
    weekdayLabel: todayShanghaiWeekdayLabel(),
  };
}

export function mapTaskToSeedTask(task: DbTask): (typeof demoSeed.tasks)[number] {
  return {
    id: task.id,
    title: task.title,
    subtitle: task.subtitle,
    time: task.scheduled_time,
    duration: task.duration_minutes ? `${task.duration_minutes} min` : "—",
    xp: task.xp,
    coin: task.coin,
    status: task.status,
    kind: task.kind,
    completedAt: task.completed_at ?? null,
  };
}

export function mapRecordToLearningLog(record: DbRecord): (typeof demoSeed.learningLogs)[number] {
  return {
    id: record.id,
    topic: record.topic,
    summary: record.text,
    duration: record.minutes ? `${record.minutes} min` : "—",
    xp: record.xp,
    coin: record.coin,
    evidence: record.evidence ?? "输入",
    occurredAt: formatRelativeTime(record.created_at),
  };
}

/** 简化时间展示：今天 -> "今天 HH:MM"，否则 -> "MM-DD HH:MM" */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${hhmm}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}
