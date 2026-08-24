import { findById } from "@/lib/repo/users";
import { listTasks } from "@/lib/repo/tasks";
import {
  countApplicationEvidence,
  countInputEvidence,
  countRecordsOnDay,
  countUnderstandingEvidence,
  dailyMinutesSince,
  listFocusGoals,
  listRecordDates,
} from "@/lib/repo/stats";
import type { DbGoal } from "@/lib/repo/types";
import { todayInShanghai } from "./time";
import { ServiceError } from "./errors";

/**
 * 聚合业务服务：dashboard（首页）/ growth（成长）/ goals（计划）。
 * 全部为纯 SQL 聚合 + 纯函数计算，不涉及 AI。
 */

/** 等级公式：权威来源 xp_balance（ledger 单向派生），不落库 */
export function levelFromXp(xp: number) {
  const level = Math.floor(xp / 100) + 1;
  const nextLevelXp = 100 - (xp % 100);
  return { level, nextLevelXp, progress: xp % 100 };
}

/**
 * 连续有效行动日：从今天（今天无记录则从昨天，今天还没结束不视为断签）
 * 往前数连续有记录的天数。
 */
export function computeStreak(recordDates: string[], today: string): number {
  const set = new Set(recordDates);
  const cursor = new Date(`${today}T00:00:00Z`);
  if (!set.has(today)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const dayStr = (d: Date) => d.toISOString().slice(0, 10);
  let streak = 0;
  while (set.has(dayStr(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

function dateMinusDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function getDashboardStats(userId: string) {
  const profile = await findById(userId);
  if (!profile) throw new ServiceError("用户不存在", 404);

  const today = todayInShanghai();
  const [todayRecords, recordDates, tasks] = await Promise.all([
    countRecordsOnDay(userId, today),
    listRecordDates(userId),
    listTasks(userId),
  ]);
  const { level, nextLevelXp } = levelFromXp(profile.xp_balance);

  return {
    profile: {
      id: profile.id,
      nickname: profile.display_name || "成长探索者",
      level,
      xp: profile.xp_balance,
      coin: profile.coin_balance,
      nextLevelXp,
      streak: computeStreak(recordDates, today),
    },
    todayTasks: tasks,
    todayRecords,
  };
}

export async function getGrowthStats(userId: string) {
  const today = todayInShanghai();
  const startDate = dateMinusDays(today, 6);
  const [daily, input, understanding, application, recordDates] = await Promise.all([
    dailyMinutesSince(userId, startDate),
    countInputEvidence(userId),
    countUnderstandingEvidence(userId),
    countApplicationEvidence(userId),
    listRecordDates(userId),
  ]);

  const minutesByDay = new Map(daily.map((d) => [d.day, d.minutes]));
  const weekly = [];
  for (let i = 0; i < 7; i += 1) {
    const day = dateMinusDays(today, 6 - i);
    const value = minutesByDay.get(day) ?? 0;
    weekly.push({ day, value, label: `${value}m` });
  }

  return {
    weeklyMinutes: weekly,
    evidence: { input, understanding, application },
    activeDays: computeStreak(recordDates, today),
  };
}

export async function getGoalsSummary(userId: string): Promise<{ focusGoals: DbGoal[] }> {
  const focusGoals = await listFocusGoals(userId, 3);
  return { focusGoals };
}
