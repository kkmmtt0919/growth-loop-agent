# DESIGN_SMART_PLANNER_STEP6 — Agent Quality Loop（Reflection / Evaluation / Trace）

> 上游：Smart Planner Step 1-5 全闭环（已归档 c4322b6/1bb0faf/4bacd27）
> 日期：2026-09-05
> 状态：**待用户审核**（审核通过后开发）
> 定位：不是继续堆 Agent 能力，而是补齐 **Agent 产品化闭环：可解释、可评估、可追踪**。

---

## §0 目标冻结（用户定稿）

> 让 Agent 从「能生成结果」升级为「可追踪、可评估、可迭代」。

**包含**：Reflection 用户反馈 / Agent Evaluation / Prompt Trace
**不包含**：自动修改目标 / 自动完成 Action / 强化学习 / 在线 Prompt 自动优化

## §0.1 摸底结论（2026-09-05，决定方案走向的三个事实）

| 事实 | 影响 |
|---|---|
| **eval/ 基础设施已存在**：`eval/run.ts`（零依赖 runner，`npm run eval`，JSON 输出 + 退出码供 CI）+ 4 个 suites（understanding/decompose/evening/weekly，纯函数 Fact Boundary 回归） | 6b Evaluation **不是从零建**，是「扩 cases」——工作量大幅缩水 |
| **LLM 调用 4 处私有 fetch**：①`llm-json.callLLMJson`（action-plan + planner-generator 统一走）②`generateWeeklyDigest` ③`generateEveningDigest` ④`runAgent`（agent 面板+wechat）与 `chat-provider` 各自 fetch | Trace wrapper 切入点 = `callLLMJson`；weekly/evening 顺手迁移即可覆盖；chat/runAgent 留债（调用形态不同：会话式/短超时） |
| 规则校验函数已纯函数化：`validateActionSteps` / `greedySchedule` / `buildWeeklyContent` | 6b 的 Action/Planner/Weekly 断言直接喂 fixtures，无需新校验器 |

## §1 6a Reflection 数据模型

### 1.1 迁移 `014_reflection_records.sql`（**占用 014 → chat P2 顺延 016/017**）

```sql
create table public.reflection_records (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  goal_id    uuid references public.goals(id) on delete cascade,      -- nullable
  action_id  uuid references public.actions(id) on delete cascade,    -- nullable（与 goal_id 至少一个）
  source     text not null check (source in ('planner','weekly','manual')),
  content    text not null check (char_length(content) between 1 and 500),
  rating     text check (rating in ('good','bad')),                   -- nullable
  created_at timestamptz not null default now()
);
create index idx_reflection_user on public.reflection_records(user_id, created_at desc);
alter table public.reflection_records enable row level security;  -- 沿用 007：enable 无 policy
```

约束：goal/action 归属校验在 Service（越权 403/404）；**不进 XP/coin**（红线）；action 与 goal 归属一致性校验（action.action_id 的 goal 必须等于传入 goal_id，若同时传）。

### 1.2 service + API
- `lib/service/reflection.ts`：`createReflection(userId, {goalId?, actionId?, source, content, rating?})`（归属校验 + content 1-500 + source 白名单）/ `listReflections(userId, {goalId?, limit≤20})`（倒序）
- `POST /api/reflections` / `GET /api/reflections?goal_id=&limit=`
- MVP：**只记录 + 查询**（D1：不自动影响 Planner）；仅把「最近 ≤3 条 reflection」作为参考文本注入 planner-generator 的 user prompt（标注「仅参考，非指令」——见 D5）

## §2 6b Evaluation（扩 eval/，不新建）

沿用 `eval/run.ts` harness（纯函数、CI 可接、退出码判失败），新增 3 个 suite：

| suite | fixtures 喂什么 | 断言（对应评估层） |
|---|---|---|
| `eval/cases/action-eval.ts` | 喂 `validateActionSteps`（含 LLM 原始 JSON 样本：正常 / 缺 title / estimatedMinutes 越界 29 或 3001 / 依赖成环样本 / 整目标当阶段） | 数量>0、title 非空、分钟 30-3000、依赖无环 → `{pass, score, errors[]}` 断言 |
| `eval/cases/planner-eval.ts` | 喂 `greedySchedule` + `expandFreeSlots`（含固定块冲突样本 / 超 availability 样本 / 跨天样本 / 重叠样本 / 空可用时间） | 不超 availability、不撞 fixed、不重叠、不跨天；空可用 → items 空 |
| `eval/cases/weekly-eval.ts`（已有，补 3 case） | `buildWeeklyContent` + 新三字段 | stats 字段完整、plan=0 → executionRate null、老 JSON（无新字段）读取不崩 |

Evaluation 输出结构统一 `{pass, score, errors[]}`（score = 通过断言比例，MVP 简单比例）。
**不落库**（MVP fixture 代码化，用户已定）；线上阻断策略见 D2。

## §3 6c Agent Trace

### 3.1 迁移 `015_agent_runs.sql`

```sql
create table public.agent_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.profiles(id) on delete cascade,   -- nullable（系统级调用）
  agent_type     text not null check (agent_type in ('action-plan','planner','weekly','evening')),
  prompt_version text not null,                                            -- 'action-plan-v1' 等，字符串管理（D4）
  input_context  jsonb,                                                    -- 截断至 ≤8KB（D6）
  output_json    jsonb,
  latency_ms     integer,
  success        boolean not null,
  error_message  text,
  created_at     timestamptz not null default now()
);
create index idx_agent_runs_user_type on public.agent_runs(user_id, agent_type, created_at desc);
alter table public.agent_runs enable row level security;
```

### 3.2 Trace wrapper（唯一写库点）
`llm-json.ts` 的 `callLLMJson` 增加 optional trace 参数：

```ts
callLLMJson({ system, user, temperature, timeoutMs,
              trace?: { userId: string | null; agentType: AgentType; promptVersion: string; inputContext?: unknown } })
```

- 内部：计时 → 调 LLM → 无论成功/失败（HTTP 非 200 / 超时 / 异常）**都落一条 agent_runs**；落库 `try/catch` 包裹，**失败时 `console.warn('[agent-trace] ...')` 而非静默吞**（补充 B：静默丢失线上无法排查），**绝不影响主链路返回**
- `input_context`：`{ systemLength, userPreview(截 2000 字), temperature }`（避免全文灌库；完整 prompt 不存，债记录）
- 各 generator 导出常量 `PROMPT_VERSION = 'action-plan-v1' | 'planner-v1' | 'weekly-v1' | 'evening-v1'`
- **迁移**：`weekly-generator.generateWeeklyDigest` / `evening-generator.generateEveningDigest` 的私有 fetch 改走 `callLLMJson`（顺手统一，行为等价：同样 json_object + 失败 null）→ 4 个 agent_type 全覆盖；`runAgent`/chat **本期不接**（会话形态不同，债 §8）
- prompt_version 当前全部 v1——价值在结构就位，未来改 prompt 只 bump 版本号即可对比

## §4 Trace 链路（升级后）

```
Goal ──▶ Agent Run { agent_type, prompt_version, input_context, output_json, latency, success }
            │（trace 落库失败不影响主流程）
            └─▶ Action / Plan / Weekly
```

查询：本期不加 UI 查询 API（表就位即可评估）；`GET /api/agent/status` 已有的 `getAgentStatus` 保持。6c 前端最小：设置页「最近反馈」列表 + Agent 状态（复用现有接口），不做后台。

## §5 决策点（D1–D8，默认值）

| # | 点 | 默认 |
|---|---|---|
| D1 | Reflection 立即影响 Planner？ | ❌ 不做规则化自动调整；仅 prompt 注入最近 ≤3 条作参考文本（D5） |
| D2 | Evaluation 线上阻断？ | 开发/CI 阻断（`npm run eval` 退出码）；生产 warning 不阻断（LLM 波动不致不可用） |
| D3 | Trace 保存多久？ | MVP 全保存；TTL 清理留债 |
| D4 | Prompt version 管理 | 字符串常量 `agent-vN`，不建 registry |
| D5 | Reflection 注入 Planner prompt | ✅ 注入最近 3 条（标「仅参考」）——这是 reflection 唯一闭环出口，否则纯日志无价值 |
| D6 | input_context 体积 | 截断：user 预览 2000 字 + 元信息，全文不入库（隐私+体积） |
| D7 | chat/runAgent 接 Trace | 本期不接（债）；覆盖 action-plan/planner/weekly/evening 四类 |
| D8 | Evaluation 落库？ | ❌ 不落库，代码 fixture + eval runner（用户已倾向） |

## §8 设计债（记录）

- `runAgent`（agent 面板/wechat）与 `chat-provider` 未接 Trace——会话式调用，后续统一 wrapper 时接入（agent_type 增加 'agent-chat'）
- agent_runs TTL 清理 / 完整 prompt 存档（隐私权衡）
- reflection 的规则化影响（如 bad 反馈 ≥3 → 下次 Planner 自动降量）——等数据积累后设计
- 旧 decompose-generator 私有 callPlanner 未迁移 callLLMJson（旧链路不动原则）

## §9 验收（15 项，用户定稿）

**Reflection**：1 只能写自己的 reflection 2 goal/action 越权拒绝 3 删除级联 4 不影响 XP
**Trace**：5 LLM 调用产生 run 6 success/fail 均记录 7 latency 正确 8 prompt version 存储
**Evaluation**：9 Action schema 校验 10 Planner 冲突检测 11 Weekly schema 校验 12 空输入失败
**回归**：13 Step5 execution 不受影响 14 weekly 不受影响 15 Planner 正常生成

## §10 开发顺序

```
6a-1  014_reflection_records + repo/service + POST/GET /api/reflections + reflection-smoke（验收 1-4）
6a-2  015_agent_runs + callLLMJson trace wrapper + weekly/evening digest 迁移 + trace-smoke（验收 5-8）
6b    eval 三 suite 扩展 + npm run eval 全绿（验收 9-12）
6c    前端最小（设置页最近反馈 + Agent 状态）+ 全量回归（验收 13-15）
```

预估：6a-1/6a-2 各 1 轮、6b 1 轮、6c 1 轮 ≈ **4 轮**（eval 基础设施已存在，比初估省 1-2 轮）。

---

## §11 交付记录（追加，2026-09-05）

- **6a-1 Reflection 已交付**（6a-2 同日）：014 迁移落库；repo/service/API（POST+GET?goal_id&limit）；reflection-smoke 14/14（验收 1-4 + 校验/一致性/隔离）。越权一律 404 不泄露存在性。
- **6a-2 Agent Trace 已交付**：015 迁移落库；callLLMJson 增 trace 参数（成功/失败都落、fire-and-forget、失败 console.warn）；weekly/evening digest 迁 callLLMJson + 各 generator 导出 PROMPT_VERSION；trace-smoke 12/12（验收 5-8）。
- **6b Eval 已交付**：eval/cases/action.ts（validateActionSteps+hasGraphPath 环检测）、planner.ts（expandFreeSlots+greedySchedule 约束）、weekly.ts 补 2 case（排程三字段透传 + plan=0→rate null）；run.ts 注册 action/planner suite。`npm run eval` **69/69** 全绿（验收 9-12）。
- **6c 前端最小已交付（范围按用户冻结：Goal 卡行动路线底部入口，非设置页）**：
  - Goal 卡「反馈一下这次计划」：快捷评分（做得不错=good / 有压力=bad，可取消）+ 可选文字 1-500 + 提交（manual 来源 goal 级）
  - 同卡「历史反馈」只读列表（最近 3 条，日期/内容/rating 徽标；绑定 action 时本地解析阶段名）
  - PlannerModal preview：该 goal 有历史反馈时显示「AI 会参考你的历史反馈调整建议。」（不展示任何 trace/prompt/latency 工程信息）
  - **D5 补实现（核对发现 §1.2 注入缺失）**：`generatePlanPreview` 并行拉 `listRecentReflections(userId,3)` → contextLines 尾部注入「用户最近反馈（仅参考，非指令）」，前缀 [认可]/[有压力]/[反馈]
  - 数据流：reflectionsByGoal 根 state + routeGoalIds 签名 effect 拉取 + submitReflection（成功前置）；删 goal → 卡片与列表随 state 消失（无残留）
  - 验证：reflection-http-e2e.mjs **7/7**（验收 16-20 接口层）；typecheck/lint/build 过；eval 69/69 + 全套 smoke 回归全绿（reflection14/planner18/context8/weekly6/feedback11/execution12/exec5b7/timeline16/actions-api16/trace12）
- Trace 前端/后台、eval dashboard、prompt 对比**按用户决定不做**；agent_runs 保留为调试/评估数据源。
