/**
 * Agent 离线评测入口（Phase 6）。
 * 零依赖 Node 测试 runner（经 tsx 运行），只测 lib/agent/core/pure.ts 的确定性规则。
 * 用法：npm run eval
 * 输出：结构化 JSON {version, total, passed, failed, duration, failures:[{case, reason}]}
 * 退出码：failed > 0 时非零（供 CI 判失败）。
 */
import { cases as understandingCases } from "./cases/understanding";
import { cases as decomposeCases } from "./cases/decompose";
import { cases as eveningCases } from "./cases/evening";
import { cases as weeklyCases } from "./cases/weekly";
import { cases as actionCases } from "./cases/action";
import { cases as plannerCases } from "./cases/planner";

type Case = { name: string; fn: () => void };
type Failure = { case: string; reason: string };

const suites: Array<{ name: string; cases: Case[] }> = [
  { name: "understanding", cases: understandingCases },
  { name: "decompose", cases: decomposeCases },
  { name: "evening", cases: eveningCases },
  { name: "weekly", cases: weeklyCases },
  { name: "action", cases: actionCases },
  { name: "planner", cases: plannerCases },
];

const startedAt = Date.now();
const failures: Failure[] = [];
let total = 0;
let passed = 0;

for (const suite of suites) {
  for (const c of suite.cases) {
    total += 1;
    const fullName = `${suite.name}/${c.name}`;
    try {
      c.fn();
      passed += 1;
    } catch (err) {
      failures.push({ case: fullName, reason: err instanceof Error ? err.message : String(err) });
    }
  }
}

const duration = Date.now() - startedAt;
const result = {
  version: 1,
  total,
  passed,
  failed: failures.length,
  duration,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
