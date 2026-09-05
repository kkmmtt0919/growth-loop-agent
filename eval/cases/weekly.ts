/**
 * 周报 schema + 事实边界（buildWeeklyContent / extractWeeklyText / isValidGoalSuggestion）离线评测。
 * 核心是 Fact Boundary Regression：
 *   1. stats 永远用规则值，LLM 注入的假 stats 不能覆盖；
 *   2. extractWeeklyText 不透传未知字段（如 LLM 塞入的 stats / score）。
 */
import {
  buildWeeklyContent,
  extractWeeklyText,
  isValidGoalSuggestion,
  hasMeaningfulContext,
  type WeeklyStats,
} from "../../lib/agent/core/pure";
import { assert, assertEq, assertDeepEq } from "../assert";

export type Case = { name: string; fn: () => void };

const UUID = "3f2a1b4c-0000-4000-8000-000000000001";

function makeStats(over: Partial<WeeklyStats> = {}): WeeklyStats {
  return {
    periodStart: "2026-08-18",
    periodEnd: "2026-08-24",
    activeDays: 5,
    recordCount: 12,
    minutes: 300,
    doneTasks: 8,
    windowTotal: 10,
    completionRate: 80,
    streak: 3,
    goalProgress: [],
    vsPrevWeek: { recordCount: 0, minutes: 0, doneTasks: 0, completionRate: 0 },
    // Step 5c 平行字段（fixture 默认无排程）
    planMinutes: 0,
    actualMinutes: 0,
    executionRate: null,
    ...over,
  };
}

export const cases: Case[] = [
  // ---- Fact Boundary Regression: stats 注入不可覆盖 ----
  {
    name: "buildWeeklyContent-stats-不可覆盖",
    fn: () => {
      const stats = makeStats({ recordCount: 12, completionRate: 80 });
      const text = { summary: "总结", achievement: [], problem: [], suggestion: [] };
      const content = buildWeeklyContent(stats, text, [], "llm");
      assertEq(content.stats.recordCount, 12, "recordCount 应保持规则值");
      assertEq(content.stats.completionRate, 80, "completionRate 应保持规则值");
      assertEq(content.stats, stats, "stats 应是原对象引用（非 LLM 伪造）");
    },
  },
  {
    name: "extractWeeklyText-不透传未知字段",
    fn: () => {
      // LLM 试图塞入假 stats / score 等未知字段
      const raw = {
        summary: "本周总结",
        achievement: ["a"],
        problem: [],
        suggestion: [],
        stats: { recordCount: 9999, completionRate: 100 }, // 伪造 stats
        score: 95, // 未知字段
        fakeField: "注入",
      };
      const text = extractWeeklyText(raw);
      if (text === null) throw new Error("合法文字字段应通过");
      assert(!("stats" in text), "不得透传 stats");
      assert(!("score" in text), "不得透传 score");
      assert(!("fakeField" in text), "不得透传未知字段");
      assertDeepEq(Object.keys(text).sort(), ["achievement", "problem", "suggestion", "summary"], "只保留四个文字字段");
    },
  },
  {
    name: "extractWeeklyText-缺summary返回null",
    fn: () => {
      assert(extractWeeklyText({ achievement: [], problem: [], suggestion: [] }) === null, "缺 summary 应返回 null");
      assert(extractWeeklyText(null) === null, "null 应返回 null");
      assert(extractWeeklyText("str") === null, "字符串应返回 null");
    },
  },
  {
    name: "extractWeeklyText-数组元素类型错",
    fn: () => {
      const raw = { summary: "s", achievement: [1], problem: [], suggestion: [] };
      assert(extractWeeklyText(raw) === null, "achievement 元素非字符串应返回 null");
    },
  },
  {
    name: "buildWeeklyContent-schemaVersion",
    fn: () => {
      const content = buildWeeklyContent(makeStats(), { summary: "s", achievement: [], problem: [], suggestion: [] }, [], "rules");
      assertEq(content.schemaVersion, 1, "schemaVersion 应为 1");
      assertEq(content.replySource, "rules", "replySource 应透传");
    },
  },
  // ---- goalSuggestion 结构校验 ----
  {
    name: "isValidGoalSuggestion-合法",
    fn: () => {
      assert(
        isValidGoalSuggestion({ goalId: UUID, action: "update_title", newTitle: "新标题", reason: "理由" }),
        "合法建议应通过",
      );
    },
  },
  {
    name: "isValidGoalSuggestion-非UUID-goalId",
    fn: () => {
      assert(
        !isValidGoalSuggestion({ goalId: "not-a-uuid", action: "update_title", newTitle: "x", reason: "r" }),
        "非 UUID goalId 应失败",
      );
    },
  },
  {
    name: "isValidGoalSuggestion-action-白名单",
    fn: () => {
      assert(
        !isValidGoalSuggestion({ goalId: UUID, action: "archive", newTitle: "x", reason: "r" }),
        "archive action 应失败",
      );
    },
  },
  {
    name: "isValidGoalSuggestion-newTitle-超长",
    fn: () => {
      const long = "字".repeat(41);
      assert(
        !isValidGoalSuggestion({ goalId: UUID, action: "update_title", newTitle: long, reason: "r" }),
        "newTitle 超 40 字应失败",
      );
    },
  },
  {
    name: "isValidGoalSuggestion-newTitle-空",
    fn: () => {
      assert(
        !isValidGoalSuggestion({ goalId: UUID, action: "update_title", newTitle: "  ", reason: "r" }),
        "空 newTitle 应失败",
      );
    },
  },
  // ---- 空上下文判定 ----
  {
    name: "hasMeaningfulContext-全空",
    fn: () => {
      assertEq(hasMeaningfulContext({ hasGoal: false, hasTasks: false, hasRecords: false }), false, "全空应无意义");
    },
  },
  {
    name: "hasMeaningfulContext-任一存在",
    fn: () => {
      assert(hasMeaningfulContext({ hasGoal: true, hasTasks: false, hasRecords: false }), "有 goal 应有意义");
      assert(hasMeaningfulContext({ hasGoal: false, hasTasks: true, hasRecords: false }), "有 task 应有意义");
      assert(hasMeaningfulContext({ hasGoal: false, hasTasks: false, hasRecords: true }), "有 record 应有意义");
    },
  },
];
