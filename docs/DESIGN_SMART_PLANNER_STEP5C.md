# DESIGN_SMART_PLANNER_STEP5C — 反馈闭环（统计口径 + Weekly/Context 消费 + Planner 校准）

> 上游：`docs/DESIGN_SMART_PLANNER_STEP5.md`（冻结）§4/§7；`DESIGN_SMART_PLANNER_STEP5.md` 已封版 5a/5b
> 依赖：5a execution_records ✅ · 5b 执行入口（actualMinutes 编辑 + spentMinutes）✅
> 日期：2026-09-05
> 状态：**待用户审核**（审核通过后开发）
> 定位：Execution Loop 的**上层消费逻辑**——把 execution 事实喂给统计/周报/上下文/Planner，形成「计划→实际→校准」闭环。**不改旧字段语义、不扩大范围**。

---

## §0 范围红线（5c 只做「消费」，不做任何新机制）

| ❌ 不做 | 原因 |
|---|---|
| 自动完成 Action | Action 由用户手动确认（Step 5 §0 已冻结） |
| Timer 模式 | Step 6+ |
| LLM 判断完成 | Step 6+ |
| execution 与 records 去重 | D1 已定：接受重叠 |
| XP/账本重构 | execution 永不入账（既有红线） |

## §1 目标

```
execution_records（已有事实）
   │
   ├─▶ dailySpentMinutesSinceV2（records + execution 双轨投入，新增不动 V1）
   │        ├─▶ planner feasibility（校准：按真实可投入能力建议）
   │        └─▶ AgentContext.minutes7d（晚报「7 天实际投入」）
   ├─▶ WeeklyStats 平行扩展 planMinutes/actualMinutes/executionRate（旧字段零改动）
   └─▶ AgentContext.todayExecutions（晚报/chat 看见「安排 90 分、实际 75 分」）
```

## §2 检查点 1：dailySpentMinutesSinceV2（repo/stats.ts）

### 2.1 实现
新增函数（**不替换 V1**）：

```ts
// repo/stats.ts —— UNION 按上海日期分组（completed_at/occurred_at 都必须显式转换时区，
// 防 23:30 UTC 进错日期 —— 用户提醒的实现细节）
export async function dailySpentMinutesSince(userId, sinceShanghaiDate): Promise<{day,minutes}[]> {
  -- records.minutes ∪ execution_records.actual_minutes（minutes>0 / actual 恒 >0）
  select day, sum(minutes)
  from (
    select (occurred_at at time zone 'Asia/Shanghai')::date::text as day, minutes
      from public.records where user_id=$1 and minutes>0
    union all
    select (completed_at at time zone 'Asia/Shanghai')::date::text as day, actual_minutes
      from public.execution_records where user_id=$1
  ) t where day >= $2 group by day order by day
}
```

### 2.2 消费方切换（口径决策，见 §6 D1）
- **planner.generatePlanPreview feasibility 双窗口** → V2（排量按「真实投入能力」建议——闭环核心）
- **AgentContext.minutes7d** → V2（晚报说「近 7 天实际投入 N 分钟」）
- **weekly.stats.minutes（旧字段）** → **保持 V1**（历史周报 JSON 兼容；见 §3）
- **growth 仪表盘 / records recent** → **保持 V1**（口径 =「记录投入」，展示不跳动；后续可再统一）
- V1 保留 export：供对照测试 + 既有调用；无执行数据时 V2 === V1（回归护栏）。

## §3 检查点 2：WeeklyStats 平行扩展（pure.ts + weekly service + /weekly 页）

### 3.1 语义（用户定稿表）

| 字段 | 来源 | 备注 |
|---|---|---|
| `planMinutes` | 本周 `schedules(source='action')` date∈[start,end] 的 sum(end-start) | 计划 = 排了就算（planned+completed；reset 已删的不存在） |
| `actualMinutes` | 本周 `execution_records.actual_minutes` sum（completed_at 上海日期∈[start,end]） | manual 也计（本周真实投入），与 Action 无关 |
| `executionRate` | `round(actual/plan*100)`；**plan=0 → null** | null =「本周无排程」，前端隐藏 + 引导文案，绝不显示 0% |

### 3.2 实现点
- `pure.ts` `WeeklyStats` **只增不改**：`planMinutes: number; actualMinutes: number; executionRate: number | null;`（completionRate 等旧字段原样）
- `buildWeeklyContent` 不需要变（stats 整体透传）
- `weekly.ts computeWeeklyStats`：并行新增三个 repo 调用——`sumScheduleMinutesBetween(userId, from, to)`（schedules）与 `sumExecutionMinutesBetween(userId, from, to)`（repo/stats 或 execution repo 增）；prevWeek 不同步扩展（vsPrevWeek 不动，避免历史结构膨胀）
- `ruleFallback.summary`：有排程时追加「计划 X 分 · 实际 Y 分 · 执行率 Z%」；`statsToText` 增对应行供 LLM
- `/weekly` 页面（app/weekly/page.tsx）本地 type 加三字段（optional），渲染新「排程执行」指标卡：planMinutes / actualMinutes / executionRate%（null → 文案「本周暂无 AI 排程」）；**历史周报 content.stats 无新字段 → optional chaining，不解析失败**
- `WEEKLY_SCHEMA_VERSION` **不 bump**（字段增量向后兼容；文档记录）

## §4 检查点 3：AgentContext.todayExecutions（context.ts）

```ts
// 类型（追加字段，纯增量）
todayExecutions: Array<{
  title: string;         // schedule.title
  plannedMinutes: number;// schedule 时长 end-start
  actualMinutes: number; // execution.actual_minutes
}>;
```
- 数据：`listSchedulesByDate(userId, today)` 取 `status='completed'` → `listExecutionsBySchedules(ids)` join → map
- `contextToText` 增段「今日执行（安排/实际）：…」，供晚报与 chat LLM 使用——**晚报从「今天完成一个任务」升级为「安排 90 分、实际投入 75 分」**
- 空数组 → 不注入该段（无执行不打扰）

## §5 检查点 4：ActionView 达标数据源重申（无代码）

- spentMinutes 唯一来源 = execution_records（5b 已落地并注释红线）
- 补验收断言：一次 schedule「计划 90、实际 30」→ 累计计 **30 而非 90**（execution-5b-smoke #1 已覆盖：计划 120 complete 传 100 → 累计 100）
- **禁止**回退到「schedule.completed 次数 × 计划时长」口径

## §6 决策点（默认建议，可调）

| # | 点 | 默认 | 说明 |
|---|---|---|---|
| D1 | V2 消费面 | planner + context 切 V2；weekly.minutes/growth/records recent 保持 V1 | 周报/仪表盘旧口径不跳动；校准与晚报用真实投入；V1 保留对照 |
| D2 | weekly 是否给 prevWeek 扩展执行维度 | 否 | vsPrevWeek 不动，防历史结构膨胀；环比只沿用既有字段 |
| D3 | /weekly 新卡布局 | 「排程执行」新卡（计划/实际/执行率），不动原「投入」卡 | 平行展示，旧卡文案保持「记录投入」 |

## §6.1 锁定口径（用户 5c-1 补充，强制）

- **补充 A — executionRate 分母必须固定**：`executionRate = sum(execution.actual_minutes) / sum(schedule.end-start 时长)`。
  **禁止**改除以 `action.estimatedMinutes`——Action 是阶段估算、Schedule 才是执行承诺；分母错则"计划执行情况"被阶段估算污染。
- **补充 B — V2 不去重（简单加总）**：同一分钟若 `records: 学习 60min` 与 `execution: 该 schedule 60min` 并存，V2 计 **120min**。
  **不在 repo 层做智能 merge**——records=主动反思、execution=执行事实，重叠是设计允许（D1）；任何去重会让「用户安排执行 + 用户反思记录」的贡献消失且无法解释。

## §7 验收

1. `dailySpentMinutesSince`：无 execution → 结果 === `dailyMinutesSince`；造同日 execution → 该天 = V1 + actual（数值断言）
2. 上海时区防漂移：跨 UTC 边界数据进正确日期（用例：completed_at 上海日期与 UTC 日期不同时）
3. planner preview feasibility 消费 V2（无 execution 环境数值与改前一致 → planner-smoke 零回归）
4. weekly generate 后 content.stats 含 planMinutes/actualMinutes/executionRate（有排程时 rate=整数；无排程 null）
5. **历史周报读取不崩**：旧 content.stats 缺新字段 → /weekly 渲染 optional、无 TypeError
6. AgentContext.todayExecutions：今日有完成 schedule → 数组含 {title,plannedMinutes,actualMinutes}；无 → 空数组且 contextToText 不注入执行段
7. 晚报回归（e2e-evening / chat 三连问）：context 文本可读、既有断言不破
8. 达标数据源：执行一次「计划 120 实际 100」→ spent=100（回归 5b smoke）
9. 全量回归：execution/execution-5b/timeline/planner/actions-api smoke + timeline-http-e2e 全绿

## §8 开发顺序

```
5c-1  repo：stats.dailySpentMinutesSince + schedules.sumScheduleMinutesBetween + execution.sumExecutionMinutesBetween
      → tsx 冒烟（scripts/feedback-smoke.ts）：验收 1/2/8 + V2==V1 对照
5c-2  weekly service：computeWeeklyStats 三字段 + ruleFallback/statsToText → pure.ts WeeklyStats 扩展
5c-3  context：todayExecutions + contextToText 注入段（planner feasibility 切 V2 一并在此）
5c-4  前端 /weekly：type + 「排程执行」卡 + 历史 optional → tsc/lint/build + HTTP 检查历史报告渲染
回归  全量 smoke + evening/chat/weekly e2e + 记忆
```

## §9 已知边界（记录）

- weekly.stats.minutes 与 context.minutes7d 口径暂不一致（前者手工、后者含执行）——D1 取舍，仪表盘后续再统一。
- 周报 executionRate 只统计本周**现存** schedule（reset 撤销的排程不计入 planMinutes）——计划口径以「仍在案」为准。
