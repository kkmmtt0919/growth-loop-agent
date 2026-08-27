/**
 * 拆解校验（validateStep / validateSteps / normalizeTitle / levenshtein / isTitleDuplicate）离线评测。
 * 只测确定性规则：字段合法性、大目标词黑名单、标题去重。
 */
import {
  BIG_GOAL_WORDS,
  normalizeTitle,
  levenshtein,
  isTitleDuplicate,
  validateStep,
  validateSteps,
  type DecomposeStep,
} from "../../lib/agent/core/pure";
import { assert, assertEq, assertDeepEq } from "../assert";

export type Case = { name: string; fn: () => void };

const baseStep = (over: Partial<DecomposeStep> = {}): DecomposeStep => ({
  order: 1,
  title: "安装依赖",
  description: "运行 pnpm install",
  acceptance: "依赖安装成功",
  estimatedMinutes: 30,
  category: "build",
  ...over,
});

export const cases: Case[] = [
  {
    name: "validateStep-合法步-返回null",
    fn: () => {
      assertEq(validateStep(baseStep(), []), null, "合法步应返回 null");
    },
  },
  {
    name: "validateStep-空标题",
    fn: () => {
      assertEq(validateStep(baseStep({ title: "  " }), []), "title 为空", "空标题应报错");
    },
  },
  {
    name: "validateStep-标题超长",
    fn: () => {
      const long = "这".repeat(41);
      const reason = validateStep(baseStep({ title: long }), []);
      assert(reason !== null && reason.includes("超长"), "超长标题应报错");
    },
  },
  {
    name: "validateStep-空描述",
    fn: () => {
      assertEq(validateStep(baseStep({ description: "" }), []), "description 为空", "空描述应报错");
    },
  },
  {
    name: "validateStep-时长越界",
    fn: () => {
      const reason = validateStep(baseStep({ estimatedMinutes: 3 }), []);
      assert(reason !== null && reason.includes("estimatedMinutes"), "过短时长应报错");
      const reason2 = validateStep(baseStep({ estimatedMinutes: 300 }), []);
      assert(reason2 !== null && reason2.includes("estimatedMinutes"), "过长时长应报错");
    },
  },
  {
    name: "validateStep-大目标词-黑名单",
    fn: () => {
      for (const word of BIG_GOAL_WORDS) {
        const reason = validateStep(baseStep({ title: `今天${word} React` }), []);
        assert(reason !== null && reason.includes(word), `命中「${word}」应报错`);
      }
    },
  },
  {
    name: "normalizeTitle-归一化",
    fn: () => {
      assertEq(normalizeTitle("学习 React！"), "学习react", "应去标点并小写");
      assertEq(normalizeTitle(" 学 习 反 应 "), "学习反应", "应去空格");
    },
  },
  {
    name: "levenshtein-编辑距离",
    fn: () => {
      assertEq(levenshtein("abc", "abc"), 0, "相等应为 0");
      assertEq(levenshtein("abc", "abd"), 1, "单字符替换应为 1");
      assertEq(levenshtein("", "abc"), 3, "空串距离应为长度");
    },
  },
  {
    name: "isTitleDuplicate-归一化相等",
    fn: () => {
      assert(isTitleDuplicate("学习 React", ["学习react"]), "归一化相等应判重");
    },
  },
  {
    name: "isTitleDuplicate-包含",
    fn: () => {
      assert(isTitleDuplicate("学习 React 基础", ["学习 React"]), "包含应判重");
    },
  },
  {
    name: "isTitleDuplicate-编辑距离",
    fn: () => {
      assert(isTitleDuplicate("学习React", ["学习Reacta"]), "编辑距离≤3应判重");
    },
  },
  {
    name: "isTitleDuplicate-不重复",
    fn: () => {
      assert(!isTitleDuplicate("跑步", ["阅读《原则》"]), "无关标题不应判重");
    },
  },
  {
    name: "validateSteps-过滤并返回问题",
    fn: () => {
      const result = validateSteps(
        [
          baseStep({ order: 1, title: "合法步" }),
          baseStep({ order: 2, title: "" }),
          baseStep({ order: 3, title: "今天掌握 React" }),
        ],
        [],
      );
      assertEq(result.validSteps.length, 1, "应只保留 1 个合法步");
      assertEq(result.issues.length, 2, "应记录 2 个问题");
      assertDeepEq(
        result.issues.map((i) => i.order),
        [2, 3],
        "问题 order 应正确",
      );
    },
  },
];
