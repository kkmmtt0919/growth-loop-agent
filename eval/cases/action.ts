/**
 * Action 路线图生成校验离线评测（Step 6b Evaluation 1 / 验收 9-12）。
 * 只测确定性规则：validateActionSteps（schema / 整目标当阶段 / 去重 / 字段清洗）+
 * hasGraphPath（依赖成环检测）——后者与 repo createActionsWithDepsTx 共用同一实现，
 * 评测测的就是产品落库时的判定逻辑。
 */
import {
  validateActionSteps,
  hasGraphPath,
  type ActionStep,
} from "../../lib/agent/core/pure";
import { assert, assertEq, assertDeepEq } from "../assert";

export type Case = { name: string; fn: () => void };

const GOAL_TITLE = "完成毕业论文";

function baseStep(over: Partial<ActionStep> = {}): ActionStep {
  return {
    title: "文献调研",
    description: "检索并精读 20 篇核心论文",
    estimatedMinutes: 1800, // 阶段总投入（30-3000）
    priority: 2, // 1 最高
    dependsOnTitles: [],
    ...over,
  };
}

/** 合法 4 阶段链：文献调研 → 实验设计 → 模型训练 → 论文撰写 */
function chainSteps(): ActionStep[] {
  return [
    baseStep(),
    baseStep({ title: "实验设计", dependsOnTitles: ["文献调研"] }),
    baseStep({ title: "模型训练", dependsOnTitles: ["实验设计"] }),
    baseStep({ title: "论文撰写", dependsOnTitles: ["模型训练"] }),
  ];
}

export const cases: Case[] = [
  // ---- schema 正常路径 ----
  {
    name: "validateActionSteps-合法链-全过且依赖保留",
    fn: () => {
      const { validSteps, issues } = validateActionSteps(chainSteps(), GOAL_TITLE, []);
      assertEq(validSteps.length, 4, "4 个阶段应全部合法");
      assertEq(issues.length, 0, "不应有 issue");
      assertDeepEq(
        validSteps[3].dependsOnTitles,
        ["模型训练"],
        "依赖应精确保留（与同批 title 一致）",
      );
      assertEq(validSteps[0].description, "检索并精读 20 篇核心论文", "description 应保留");
    },
  },
  // ---- schema 负路径（验收 9 Action schema 校验）----
  {
    name: "validateActionSteps-缺title",
    fn: () => {
      const { validSteps, issues } = validateActionSteps([baseStep({ title: "   " })], GOAL_TITLE, []);
      assertEq(validSteps.length, 0, "空标题步不应通过");
      assert(issues.length === 1 && issues[0].reason.includes("title 为空"), "应报 title 为空");
    },
  },
  {
    name: "validateActionSteps-title超长",
    fn: () => {
      const long = "这".repeat(61);
      const { issues } = validateActionSteps([baseStep({ title: long })], GOAL_TITLE, []);
      assert(issues.length === 1 && issues[0].reason.includes("超长"), ">60 字应报错");
    },
  },
  {
    name: "validateActionSteps-estimatedMinutes-越界与非整数",
    fn: () => {
      const cases: Array<[number, string]> = [
        [29, "<30"],
        [3001, ">3000"],
        [90.5, "非整数"],
      ];
      for (const [value, label] of cases) {
        const { issues } = validateActionSteps([baseStep({ estimatedMinutes: value })], GOAL_TITLE, []);
        assert(issues.length === 1 && issues[0].reason.includes("estimatedMinutes"), `${label} 应报错`);
      }
    },
  },
  {
    name: "validateActionSteps-priority-越界",
    fn: () => {
      for (const p of [0, 11, 2.5]) {
        const { issues } = validateActionSteps([baseStep({ priority: p })], GOAL_TITLE, []);
        assert(issues.length === 1 && issues[0].reason.includes("priority"), `priority=${p} 应报错`);
      }
    },
  },
  {
    name: "validateActionSteps-整目标当阶段-硬拒",
    fn: () => {
      // 标题与目标完全一致
      const exact = validateActionSteps([baseStep({ title: GOAL_TITLE })], GOAL_TITLE, []);
      assert(exact.issues.length === 1 && exact.issues[0].reason.includes("整目标"), "整目标标题应硬拒");
      // 归一化后目标包含于标题（如「完成毕业论文写作」含「完成毕业论文」）
      const partial = validateActionSteps([baseStep({ title: "完成毕业论文写作" })], GOAL_TITLE, []);
      assert(partial.issues.length === 1 && partial.issues[0].reason.includes("整目标"), "含整目标标题应硬拒");
    },
  },
  {
    name: "validateActionSteps-与既有阶段重复",
    fn: () => {
      const { validSteps, issues } = validateActionSteps(
        [baseStep({ title: "模型复现" })],
        GOAL_TITLE,
        ["模型复现"],
      );
      assertEq(validSteps.length, 0, "重复标题不应通过");
      assert(issues.length === 1 && issues[0].reason.includes("重复"), "应报标题重复");
    },
  },
  // ---- 字段清洗 ----
  {
    name: "validateActionSteps-清洗自身依赖与空白",
    fn: () => {
      const steps = [
        baseStep({
          title: "实验设计",
          description: "  先跑通 baseline 再扩展  ",
          dependsOnTitles: ["实验设计", " 实验设计 ", ""], // 自身依赖 + 空项
        }),
      ];
      const { validSteps, issues } = validateActionSteps(steps, GOAL_TITLE, []);
      assertEq(issues.length, 0, "清洗型输入不应报 issue");
      assertDeepEq(validSteps[0].dependsOnTitles, [], "自身依赖与空项应被滤除");
      assertEq(validSteps[0].description, "先跑通 baseline 再扩展", "description 应 trim");
    },
  },
  {
    name: "validateActionSteps-空输入-不抛错且零合法步",
    fn: () => {
      const { validSteps, issues } = validateActionSteps([], GOAL_TITLE, []);
      assertEq(validSteps.length, 0, "空批无合法步");
      assertEq(issues.length, 0, "空批无 issue（不抛错 = 验收 12）");
    },
  },
  // ---- 依赖环检测（hasGraphPath，与 repo 事务同源）----
  {
    name: "hasGraphPath-基础可达性",
    fn: () => {
      const edges = new Map<string, Set<string>>([
        ["文献调研", new Set()],
        ["实验设计", new Set(["文献调研"])],
        ["模型训练", new Set(["实验设计"])],
      ]);
      assert(hasGraphPath(edges, "实验设计", "文献调研"), "直接依赖可达");
      assert(hasGraphPath(edges, "模型训练", "文献调研"), "深层链可达");
      assertEq(hasGraphPath(edges, "文献调研", "模型训练"), false, "反向不可达");
      assertEq(hasGraphPath(new Map(), "a", "b"), false, "空图不可达");
    },
  },
  {
    name: "hasGraphPath-新增依赖成环判定",
    fn: () => {
      // 既有链 模型训练→实验设计→文献调研；现要加「实验设计 依赖 模型训练」（action=实验设计, dep=模型训练）
      const edges = new Map<string, Set<string>>([
        ["文献调研", new Set()],
        ["实验设计", new Set(["文献调研"])],
        ["模型训练", new Set(["实验设计"])],
      ]);
      // 会成环 ⟺ dep 能到达 action（模型训练可达实验设计）→ 去边
      assert(hasGraphPath(edges, "模型训练", "实验设计"), "dep 可达 action → 新增会成环，应丢弃");
      // 新阶段 X 依赖文献调研（文献调研不可达 X）→ 允许
      assertEq(hasGraphPath(edges, "文献调研", "X"), false, "无关新节点不构成环");
    },
  },
];
