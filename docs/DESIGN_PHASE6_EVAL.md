# Phase 6 Agent 评测 设计稿 v2（定稿）

> 日期：2026-08-26
> 状态：已定稿（审核通过，V2）
> 定位：0.3.0 路线图第 6 阶段 ——「Agent 评测：意图/抽取/晚报质量离线集；schema 失败/空上下文/超时处理」

---

## 0. V2 定稿变更（相对 v1）

| # | 变更 | 定稿结论 |
|---|---|---|
| 1 | 纯函数层文件组织 | **单一文件 `lib/agent/core/pure.ts`**（暂不拆三文件），四个原文件 `understanding.ts` / `decompose-validator.ts` / `evening-generator.ts` / `weekly-generator.ts` 只做 re-export，对外 API 不变 |
| 2 | TS 运行方式 | **引入 `tsx` 到 devDependencies**（`"tsx": "^4.19.2"`），`"eval": "tsx eval/run.ts"`；放弃 Node 原生 type stripping（`--experimental-strip-types`），保证长期 CI 兼容性 |
| 3 | 事实边界（第 2 层） | 从「事实一致性」升级为 **Fact Boundary Regression**：断言 stats（规则引擎计算值）**不可被 LLM 注入/覆盖**，且 `extractWeeklyText` **不透传未知字段**（如 LLM 塞入的假 `stats`/`score`） |
| 4 | 空上下文判定 | 统一封装 `hasMeaningfulContext({ hasGoal, hasTasks, hasRecords })` 纯函数，供 evening/weekly/未来 Agent 复用 |
| 5 | 超时评测 | **不做真实超时模拟**，只评「回退 builder + schema 合法性」 |
| 6 | eval 输出 | 结构化 JSON，额外加 `"version": 1`；`failed > 0` 时退出码非零（供 CI） |

---

## 1. 背景与现状盘点

Phase 2-5 已落地三条 LLM 结构化生成链路 + 一条纯规则意图识别链路。Phase 6 不是「新增能力」，而是「给已有 Agent 能力补上可离线复跑的评测护栏」。

### 1.1 现有 Agent 能力清单

| 模块 | 文件 | 性质 | 输出 |
|---|---|---|---|
| 意图识别 | `lib/agent/understanding.ts`（→ `core/pure.ts`） | 纯规则（正则 + 词典），无 LLM | `ParsedAction` |
| 拆解规划 | `lib/agent/decompose-generator.ts` | LLM + 规则回退 | `DecomposeStep[]` |
| 拆解校验 | `lib/agent/decompose-validator.ts`（→ `core/pure.ts`） | 纯规则（schema + 语义 + 判重） | `validSteps/issues` |
| 晚报生成 | `lib/agent/evening-generator.ts` | LLM JSON + 规则回退 | `EveningContent` |
| 周报生成 | `lib/agent/weekly-generator.ts` | LLM JSON + 规则回退 | `WeeklyContent` |

### 1.2 现有容错能力（三类，路线图要求）

| 容错类型 | 现状 | 结论 |
|---|---|---|
| schema 失败 | 晚报 `isEveningContent` / 周报 `extractWeeklyText`+`isValidGoalSuggestion` / 拆解 `parsePlan`+`validateSteps`，失败均走规则回退 | ✅ 已覆盖 |
| 超时 | 四个生成器都有 `AbortController` + `setTimeout`（对话 12s / 结构化 15s），超时 catch 回退 | ✅ 已覆盖 |
| **空上下文** | `buildAgentContext` 返回空结构，但原无「空上下文 → 不调 LLM 直接规则回退」短路 | ✅ **本阶段补上** |

---

## 2. 纯验证边界（Pure Validation Boundary）

这是 V2 的核心架构决策：把「零 pg/env/API 依赖」的纯函数统一抽到 `lib/agent/core/pure.ts`，生产代码（generator）与评测（eval）都从这里 import，建立稳定、可离线回归的边界。

### 2.1 文件与职责

```
lib/agent/core/pure.ts      # 唯一纯函数源，禁止 pg/env/API client，只依赖 string/object/array
lib/agent/understanding.ts   # re-export parseAction/buildActionReply + 类型
lib/agent/decompose-validator.ts  # re-export BIG_GOAL_WORDS/normalizeTitle/levenshtein/isTitleDuplicate/validateStep/validateSteps + 类型
lib/agent/evening-generator.ts    # 保留 LLM 调用 + fallback；re-export extractJson/isEveningContent/EveningContent
lib/agent/weekly-generator.ts     # 保留 LLM 调用 + fallback；re-export buildWeeklyContent/.../类型
```

### 2.2 `pure.ts` 导出清单

| 分组 | 导出 |
|---|---|
| 意图识别 | `parseAction`、`buildActionReply`、类型 `ParsedIntent/LearningTrack/ActionKind/LearningGuide/ParsedAction/PreviousAction` |
| 拆解校验 | `BIG_GOAL_WORDS`、`normalizeTitle`、`levenshtein`、`isTitleDuplicate`、`validateStep`、`validateSteps`、类型 `DecomposeStep/ValidateResult` |
| 晚报 | `isEveningContent`、`extractJson`、类型 `EveningContent` |
| 周报 | `WEEKLY_SCHEMA_VERSION`、`MAX_GOAL_SUGGESTION_TITLE`、`buildWeeklyContent`、`isValidGoalSuggestion`、`extractWeeklyText`、类型 `GoalSuggestion/WeeklyStats/WeeklyContent` |
| 空上下文 | `hasMeaningfulContext` |

**re-export 目的**：生产代码 `lib/service/*`、`lib/agent/session.ts`、`provider.ts` 等既有 import 全部保持不变（已 grep 验证：`decompose-generator.ts` 引 `extractJson/validateSteps`；`session.ts` 引 `ParsedAction`；`provider.ts` 引 `buildActionReply/parseAction/ActionKind/ParsedIntent`；`service/decompose.ts` 引 `normalizeTitle`）。

---

## 3. Fact Boundary Regression（第 2 层，V2 重点）

评测第 2 层语义收紧为「事实边界回归」：

1. **stats 注入不可覆盖**：`buildWeeklyContent` 的 `stats` 永远用规则引擎计算值，`stats` 字段必须是传入对象的原引用，LLM 输出的任何数字都不能覆盖它。断言 `content.stats === stats` 且关键数值（如 `recordCount`、`completionRate`）等于规则值。
2. **extract 不透传未知字段**：`extractWeeklyText` 只保留四个文字字段（`summary/achievement/problem/suggestion`），丢弃 `stats`、`score` 等未知字段。断言 `Object.keys(text)` 精确等于四个字段。

> 同理，晚报 `isEveningContent` 也是严格 schema 校验（缺字段/类型错即失败走回退），不接收 LLM 塞入的额外字段语义。

---

## 4. 改动点

### 4.1 空上下文短路

`hasMeaningfulContext({ hasGoal, hasTasks, hasRecords })` 为 `false` 时，不发起 LLM 请求，直接规则回退。

- `lib/service/evening.ts`：`hasGoal = context.goal !== null`、`hasTasks = context.tasks.length > 0`、`hasRecords = context.todayRecords.length > 0`。
- `lib/service/weekly.ts`：`hasGoal = stats.goalProgress.length > 0`、`hasTasks = stats.windowTotal > 0`、`hasRecords = stats.recordCount > 0`。

短路时 `replySource` 记为 `"rules"`，与 LLM 失败回退语义一致。

### 4.2 离线评测集（新增文件）

```
eval/
  assert.ts                  # 共享断言：assert / assertEq / assertDeepEq（零依赖）
  run.ts                     # 入口：聚合 cases，输出结构化 JSON，failed>0 非零退出
  cases/
    understanding.ts         # parseAction / buildActionReply（14 例）
    decompose.ts             # validateStep / validateSteps / normalizeTitle / levenshtein / isTitleDuplicate（13 例）
    evening.ts               # isEveningContent / extractJson（8 例）
    weekly.ts                # buildWeeklyContent / extractWeeklyText / isValidGoalSuggestion / hasMeaningfulContext（15 例）
```

**用例结构**（统一 schema）：

```ts
export type Case = { name: string; fn: () => void };
export const cases: Case[] = [ /* 每个 fn 内部用 assert* 断言，失败抛 Error */ ];
```

**跑分输出**（结构化 JSON）：

```json
{
  "version": 1,
  "total": 50,
  "passed": 50,
  "failed": 0,
  "duration": 12,
  "failures": []
}
```

失败时 `failures` 记录 `{ case, reason }`，`process.exitCode = 1`。

### 4.3 npm script 与依赖

```json
{
  "scripts": { "eval": "tsx eval/run.ts" },
  "devDependencies": { "tsx": "^4.19.2" }
}
```

---

## 5. 评测用例覆盖清单

### 5.1 意图识别（`parseAction` / `buildActionReply`）— 14 例

| 覆盖点 | 断言 |
|---|---|
| plan_today 带时长 / 缺时长 | intent、kind、minutes、missing 含「时长」 |
| quick_log 带结果 / review 复盘 | intent、missing 含「结果记录」 |
| 运动 / 休息 / 生活 kind | kind=exercise/rest/life |
| ai_agent track | track=ai_agent、topic 归一化、guide 生成 |
| 更正继承 intent | isCorrection=true、继承 previous.intent |
| confidence 范围 | [0,1] |
| buildActionReply review / plan_today / 更正前缀 | 回复文案分支 |
| 空串兜底 | intent=quick_log、topic=「今日行动」 |

### 5.2 拆解校验 — 13 例

| 覆盖点 | 断言 |
|---|---|
| 合法步 | 返回 null |
| 空标题 / 超长 / 空描述 / 时长越界 | 返回对应 reason |
| 大目标词黑名单 | 遍历 `BIG_GOAL_WORDS` 逐个断言命中 |
| normalizeTitle / levenshtein | 精确值 |
| isTitleDuplicate 相等/包含/编辑距离/不重复 | 判重语义 |
| validateSteps 过滤 | validSteps/issue 数量与 order |

### 5.3 晚报 schema — 8 例

| 覆盖点 | 断言 |
|---|---|
| isEveningContent 合法 / 非对象 / 缺字段 / 类型错 | schema 判定 |
| extractJson 纯 JSON / 代码块 / 前后缀 / 非法 | 解析容错 |

### 5.4 周报 schema + 事实边界 — 15 例

| 覆盖点 | 断言 |
|---|---|
| **stats 不可覆盖** | `content.stats === stats`、数值等于规则值 |
| **extract 不透传未知字段** | `Object.keys(text)` 精确等于四字段 |
| extractWeeklyText 缺 summary / 类型错 | null |
| buildWeeklyContent schemaVersion / replySource | version=1、透传 |
| isValidGoalSuggestion 合法 / 非 UUID / action 白名单 / 超长 / 空 | 结构校验（防 22P02） |
| hasMeaningfulContext 全空 / 任一存在 | 短路判定 |

---

## 6. 改动文件清单

| 文件 | 动作 |
|---|---|
| `lib/agent/core/pure.ts` | 新增（纯函数源） |
| `lib/agent/understanding.ts` | 重写为 re-export |
| `lib/agent/decompose-validator.ts` | 重写为 re-export |
| `lib/agent/evening-generator.ts` | 抽纯函数 + re-export |
| `lib/agent/weekly-generator.ts` | 抽纯函数 + re-export |
| `lib/service/evening.ts` | 加空上下文短路 |
| `lib/service/weekly.ts` | 加空上下文短路 |
| `eval/assert.ts` | 新增 |
| `eval/run.ts` | 新增 |
| `eval/cases/understanding.ts` | 新增 |
| `eval/cases/decompose.ts` | 新增 |
| `eval/cases/evening.ts` | 新增 |
| `eval/cases/weekly.ts` | 新增 |
| `package.json` | 加 `"eval"` script + `tsx` devDependency |

---

## 7. 技术实现细节：为什么用 tsx

评测用例 import `lib/agent/core/pure.ts`（相对路径，无 `@/` 别名），`pure.ts` 本身零副作用（不 import pg/env/provider），可被 tsx 直接加载。

**放弃 Node 22 原生 type stripping（v1 方案 A）的原因**：`--experimental-strip-types` 对 enum/namespace/`import type` 等 TS 特性支持有限，且作为实验特性在不同 Node 版本表现不稳定，不利于长期 CI。`tsx` 是成熟的 TS 运行时，零配置、devDependency 级引入，代价可控。

**隔离保证**：评测只 import `core/pure.ts`，绝不 import `lib/service/*`（会拖进 pg/repo/session），避免离线脚本触库。

---

## 8. 验收标准

1. `npm run eval` 跑通，输出 `{version:1, total, passed, failed, duration, failures}`，`failed=0` 时退出码 0；
2. 评测覆盖四类 ≥ 45 条（实际 50 例）；
3. 空上下文短路：空数据下 `replySource=rules` 且不发起 LLM 请求；
4. `typecheck` / `lint` / `build` 全绿；
5. 新增依赖仅 `tsx`（devDependencies）。
