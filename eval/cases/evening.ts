/**
 * 晚报 schema（isEveningContent / extractJson）离线评测。
 * 只测确定性规则：JSON 容错提取 + schema 类型校验（失败即走规则回退）。
 */
import { isEveningContent, extractJson } from "../../lib/agent/core/pure";
import { assert } from "../assert";

export type Case = { name: string; fn: () => void };

const valid = {
  summary: "今天完成了一个小闭环",
  achievement: ["完成 Agent 最小闭环"],
  problem: [],
  suggestion: ["明天继续"],
  evaluation: "节奏稳定",
};

export const cases: Case[] = [
  {
    name: "isEveningContent-合法对象",
    fn: () => {
      assert(isEveningContent(valid), "合法对象应通过");
    },
  },
  {
    name: "isEveningContent-非对象",
    fn: () => {
      assert(!isEveningContent(null), "null 应失败");
      assert(!isEveningContent("str"), "字符串应失败");
      assert(!isEveningContent([]), "数组应失败");
    },
  },
  {
    name: "isEveningContent-缺字段",
    fn: () => {
      const { achievement, problem, suggestion, evaluation } = valid;
      assert(!isEveningContent({ achievement, problem, suggestion, evaluation }), "缺 summary 应失败");
    },
  },
  {
    name: "isEveningContent-字段类型错",
    fn: () => {
      assert(!isEveningContent({ ...valid, achievement: "not-array" }), "achievement 非数组应失败");
      assert(!isEveningContent({ ...valid, problem: [1, 2] }), "problem 元素非字符串应失败");
      assert(!isEveningContent({ ...valid, evaluation: 123 }), "evaluation 非字符串应失败");
    },
  },
  {
    name: "extractJson-直接JSON",
    fn: () => {
      assertDeep(extractJson(JSON.stringify(valid)), valid, "直接 JSON 应解析成功");
    },
  },
  {
    name: "extractJson-代码块包裹",
    fn: () => {
      const text = "```json\n" + JSON.stringify(valid) + "\n```";
      assertDeep(extractJson(text), valid, "```json 块应解析成功");
    },
  },
  {
    name: "extractJson-前后缀包裹",
    fn: () => {
      const text = "好的，结果如下：" + JSON.stringify(valid) + " 以上是内容";
      assertDeep(extractJson(text), valid, "前后缀应通过花括号区间解析");
    },
  },
  {
    name: "extractJson-无效JSON返回null",
    fn: () => {
      assert(extractJson("不是 JSON") === null, "非 JSON 应返回 null");
    },
  },
];

/** 内部小工具：JSON 深度相等（断言失败抛错） */
function assertDeep(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}
