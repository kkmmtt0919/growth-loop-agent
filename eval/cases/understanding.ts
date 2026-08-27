/**
 * 意图识别（parseAction / buildActionReply）离线评测。
 * 只测确定性规则：intent/kind/topic/minutes/output/missing/confidence 的分派。
 */
import { parseAction, buildActionReply } from "../../lib/agent/core/pure";
import { assert, assertEq } from "../assert";

export type Case = { name: string; fn: () => void };

export const cases: Case[] = [
  {
    name: "parseAction-plan-today-带时长",
    fn: () => {
      const a = parseAction("帮我安排学习 React 60 分钟");
      assertEq(a.intent, "plan_today", "intent 应为 plan_today");
      assertEq(a.kind, "learn", "kind 应为 learn");
      assertEq(a.minutes, 60, "minutes 应为 60");
      assert(a.missing.length === 0, "已有时长不应 missing");
    },
  },
  {
    name: "parseAction-plan-today-缺时长",
    fn: () => {
      const a = parseAction("安排学习 React");
      assertEq(a.intent, "plan_today", "intent");
      assert(a.missing.includes("时长"), "缺时长应进入 missing");
    },
  },
  {
    name: "parseAction-quick-log-带结果",
    fn: () => {
      const a = parseAction("完成了阅读《原则》");
      assertEq(a.intent, "quick_log", "intent 应为 quick_log");
      assertEq(a.kind, "learn", "kind 应为 learn");
      assert(a.output !== undefined || a.missing.includes("结果记录"), "记录类应带输出或提示缺结果");
    },
  },
  {
    name: "parseAction-review-复盘",
    fn: () => {
      const a = parseAction("复盘今天");
      assertEq(a.intent, "review", "intent 应为 review");
      assert(a.missing.includes("结果记录"), "review 缺结果应进入 missing");
    },
  },
  {
    name: "parseAction-运动-kind",
    fn: () => {
      const a = parseAction("去跑步 30 分钟");
      assertEq(a.kind, "exercise", "kind 应为 exercise");
      assertEq(a.minutes, 30, "minutes");
    },
  },
  {
    name: "parseAction-休息-kind",
    fn: () => {
      const a = parseAction("午睡 20 分钟");
      assertEq(a.kind, "rest", "kind 应为 rest");
    },
  },
  {
    name: "parseAction-生活-kind",
    fn: () => {
      const a = parseAction("今天去超市购物");
      assertEq(a.kind, "life", "kind 应为 life");
    },
  },
  {
    name: "parseAction-ai_agent-track",
    fn: () => {
      const a = parseAction("学习 AI Agent 开发");
      assertEq(a.track, "ai_agent", "track 应为 ai_agent");
      assertEq(a.topic, "Agent 学习与开发", "AI 主题应归一化");
      assert(a.guide !== undefined, "应生成 learning guide");
    },
  },
  {
    name: "parseAction-更正-继承-intent",
    fn: () => {
      const a = parseAction("不是跑步，而是学习英语", {
        intent: "quick_log",
        kind: "exercise",
        topic: "跑步",
      });
      assertEq(a.intent, "quick_log", "更正应继承 previous intent");
      assert(a.isCorrection, "应标记 isCorrection");
    },
  },
  {
    name: "parseAction-confidence-范围",
    fn: () => {
      const a = parseAction("做了阅读");
      assert(a.confidence >= 0 && a.confidence <= 1, "confidence 应在 [0,1]");
    },
  },
  {
    name: "buildActionReply-review-分支",
    fn: () => {
      const reply = buildActionReply({
        intent: "review",
        kind: "focus",
        topic: "今日行动",
        isCorrection: false,
        missing: [],
        confidence: 0.5,
      });
      assert(reply.includes("晚报开始"), "review 回复应含晚报开场");
    },
  },
  {
    name: "buildActionReply-plan-today-含时长",
    fn: () => {
      const reply = buildActionReply({
        intent: "plan_today",
        kind: "learn",
        topic: "React",
        minutes: 60,
        isCorrection: false,
        missing: [],
        confidence: 0.8,
      });
      assert(reply.includes("60 分钟"), "应含时长");
    },
  },
  {
    name: "buildActionReply-更正-前缀",
    fn: () => {
      const reply = buildActionReply({
        intent: "quick_log",
        kind: "focus",
        topic: "写代码",
        isCorrection: true,
        missing: [],
        confidence: 0.5,
      });
      assert(reply.includes("已按你的更正更新"), "更正回复应带前缀");
    },
  },
  {
    name: "parseAction-空串-兜底",
    fn: () => {
      const a = parseAction("");
      assertEq(a.intent, "quick_log", "空串应回退 quick_log");
      assertEq(a.topic, "今日行动", "空串 topic 应兜底为今日行动");
    },
  },
];
