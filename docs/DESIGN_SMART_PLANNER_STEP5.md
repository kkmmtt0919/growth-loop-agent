# DESIGN_SMART_PLANNER_STEP5 — Execution Loop（执行闭环 + 双轨校准）

> 上游：`docs/DESIGN_SMART_PLANNER_V1.md`（冻结）§2.7 / §5 Step 5；`DESIGN_SMART_PLANNER_STEP4.md`（封版）
> 依赖：Step 1-4 全部 ✅（schedules 已能写入/展示/完成；stats/周报/晚报链路现读 tasks+records）
> 日期：2026-09-05
> 状态：**待用户审核**（审核通过后开发）
> 定位：Growth Loop 最后一公里——**Schedule 完成 → 执行事实（execution_records）→ 投入统计 → Planner/周报/晚报双轨校准 → Action 完成确认**。Schedule 是计划，Record 是事实，Action 是里程碑，三者状态机保持隔离。

---

## §0 决策冻结表（用户 2026-09-05 定稿，本文档以此为基准）

| 问题 | 冻结结论 | 依据 |
|---|---|---|
| Schedule 完成 | **自动**（时间轴勾选即完成，现状延续） | Step 4 已交付 |
| Record 生成 | **自动**：completed → execution_record 落库（`schedule_id` UNIQUE） | 「Record 是事实」，周报/双窗口需要真实投入来源 |
| 实际耗时 | **默认 = schedule 时长（end-start），用户可改 actual_minutes** | 计划 19:00-20:30 ≠ 实际 45min；不引入 Timer |
| Action 完成 | **用户手动确认**（不随 schedule 完成次数自动推进） | 投入时间 ≠ 真正掌握；达标只给提示不给结论 |
| Overdue | **动态计算、不存状态**：`status='planned' and date < today` | overdue 是时间计算结果，不是事实；补做仍 planned |
| Timer | 未来增强（Timer → actual_minutes） | 需开始/暂停/后台计时/恢复，MVP 不做 |
| LLM 判断 Action 完成 | **Step 6 以后** | 需 execution summary + reflection + evaluation |

**一句话语义**：`schedule.completed` → 生成 `execution_record`（实际投入事实），`action` **仍保持 planned**，由独立规则 + 用户确认推进。

---

## §1 目标链路

```
Schedule（计划：做什么、几点）
   │ PATCH completed（自动，唯一入口）
   ▼
execution_records（事实：实际投入多少、何时）
   │
   ├──▶ stats 双窗口（7/30 天投入 = records + execution，喂 Planner feasibility）
   ├──▶ weekly report（本周计划 vs 实际 vs 执行率）
   ├──▶ AgentContext（今日执行事实 → 晚报/chat 能看见「执行了计划」）
   └──▶ action.spentMinutes 累计（≥ estimatedMinutes → 「已达预计投入」提示）
                │
                ▼（用户点击「确认完成」，2c 已有人工标记入口）
             action.completed
```

## §2 数据模型：execution_records + 与 records 的边界

### 2.1 新迁移 `013_execution_records.sql`（**占用 013 编号 → chat P2 顺延 014 summaries / 015 metadata**）

```sql
create table public.execution_records (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  schedule_id    uuid not null unique references public.schedules(id) on delete cascade, -- 一个排程至多一条执行事实
  action_id      uuid references public.actions(id) on delete cascade,                   -- 冗余，按 action 累计
  actual_minutes integer not null check (actual_minutes between 1 and 1440),
  note           text,                                       -- 预留：复盘备注（本期前端不编辑，API 可写）
  completed_at   timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
create index idx_execution_user_date  on public.execution_records(user_id, completed_at);
create index idx_execution_action     on public.execution_records(action_id);
alter table public.execution_records enable row level security;  -- 沿用 007 口径：开 RLS、不建 policy
```

### 2.2 与现有 records 表的边界（必须写清，防止双写混乱）

| | `records`（现有成长记录） | `execution_records`（新执行事实） |
|---|---|---|
| 谁写 | 用户手动「记一笔」/ 结构化工单 | **系统自动**（schedule 完成） |
| 触发奖励 | ✅ 入账 xp/coin | ❌ 永不入账（Step 4 P2 延续） |
| 语义 | 反思性证据（kind/evidence/quiz 关联） | 客观投入事实（绑定 schedule/action） |
| 时间 | occurred_at（记录时） | completed_at（完成时） |
| minutes | 可空（记心情也允许） | 必填 1-1440（默认=计划时长） |

**重叠不查重**：用户完成一条 AI 排程后，仍可手动「记一笔」同主题反思——前者是执行事实、后者是成长证据，**MVP 接受少量重叠计数**，不做去重合并（未来可加「来自排程」标记）。文档记录此取舍。

## §3 完成 / 撤销事务（5a 核心，唯一写库路径）

### 3.1 PATCH completed（时间轴勾选 / 服务端）

`timeline.setTimelineStatus('completed')` 改为**单事务**：

```
BEGIN
  update schedules set status='completed', completed_at=coalesce(completed_at, now()) where id=$1 and user_id=$2;
  -- 幂等：一个 schedule 至多一条；重复 completed 由唯一约束 ON CONFLICT DO NOTHING 兜住
  insert into execution_records (user_id, schedule_id, action_id, actual_minutes, completed_at)
    select $userId, s.id, s.action_id,
           coalesce($actualMinutes, extract(epoch from (s.end_time - s.start_time))/60), now()
    from schedules s where s.id=$1 and s.user_id=$2
    on conflict (schedule_id) do nothing;
COMMIT
```

- `actual_minutes` 缺省 = schedule 时长；前端默认不传 → 自动 = 计划时长。
- `execution_records.action_id`：manual 排程 action_id 为 null → 记录行 action_id 也为 null（manual 的执行也留痕，喂「今日实际投入」但不算 Action 进度）。
- **不触碰 action.status**（隔离红线，延续验收 E）。

### 3.2 撤销 PATCH planned

```
BEGIN
  update schedules set status='planned', completed_at=null where id=$1 and user_id=$2;
  delete from execution_records where schedule_id=$1 and user_id=$2;  -- 事实撤回：没有完成就没有执行记录
COMMIT
```

撤销 = 撤回事实（execution 行删、completed_at 清）。再次完成 → 重新生成一行（新 completed_at）。与现有 updateScheduleStatus 语义对齐（回退清空）。

> 实现位置：repo/planner.ts 增 `completeScheduleTx` / `revertScheduleTx`（复用连接事务模式，与 acceptPlanTx 一致）；service/timeline.setTimelineStatus 改调事务版（对外 API shape 不变，前端零改动即接上）。

## §4 投入口径：双轨合并（stats 校准，5c）

### 4.1 现状
`repo/stats.dailyMinutesSince` 只读 `records.minutes` → 被 **Planner feasibility（7/30 双窗口）**、**weekly 的 minutes**、**AgentContext.minutes7d** 共用。schedule 执行此前不计入——Step 4 §11 已知差异。

### 4.2 新口径（新增函数，不动旧函数）
`repo/stats.ts` 增 `dailySpentMinutesSince(userId, sinceDate)` = **records.minutes + execution_records.actual_minutes** 按上海日期 UNION 分组求和。消费方全部切到它：
- `planner.generatePlanPreview` feasibility 双窗口（实际投入能力更真实 → 下一步 Planner 排量自动校准）
- `weekly.computeWeeklyStats` 的 minutes / prevMinutes
- `AgentContext.minutes7d`

旧 `dailyMinutesSince` 保留（growth 手工口径 / 既有调用不破坏）。**无 execution 数据时新函数 === 旧值，冒烟天然零回归**（已有 planner-smoke/weekly 用例即回归护栏）。

## §5 Action 完成确认 + 达标提示（5b/c，不强改 2c 手动入口）

- Action 仍由用户在行动路线卡手动「标记完成」（2c 已实现，`planned→409` 保护）。
- **新增只读提示**（不自动完成）：
  - repo/execution：`sumExecutionMinutesByActions(userId, actionIds)` / 按 goal `sumExecutionMinutesByGoal`。
  - GoalView.actions 内嵌时每项带 `spentMinutes`（actions-api 后端已聚合模式，扩展一处即可）。
  - 前端行动路线行尾展示「投入 x / 预计 y」；`spentMinutes >= estimatedMinutes` 时行首徽标「**已达预计投入**」+ 完成按钮文案「确认完成」。
- 边界重申：**达标 ≠ 完成**；即使投入超预计，未点确认前 action 仍 pending/planned（用户 A/B 方案取舍已在 §0 冻结）。

## §6 Overdue 口径（只定语义，本期不加 UI）

- 判定：`status='planned' and date < today`（懒算，查询侧）。
- 时间轴**不显示**（Step 4 验收 A 已锁：只查 date=today）。
- 逾期排程不自动删除、不置 doing：用户可**重新安排**（经「撤销安排」→ 重新排）或放任其停留在历史（周报计划口径会显示为「计划了但未执行」→ 拉低执行率，这就是反馈）。
- **本期无 overdue UI/查询**；本周视图标注列入 design debt（见 §11）。

## §7 成长反馈接入（5c）

### 7.1 WeeklyStats 扩展（pure.ts 类型 + weekly service 计算）
在现有结构上**新增平行维度**（旧口径 completionRate/doneTasks 等**不动**，兼容历史 content.schemaVersion 读取）：

```ts
type WeeklyStats = {
  …既有字段不变…
  planMinutes: number;      // 本周 action schedule 计划分钟（schedules source='action'，date∈[start,end]）
  actualMinutes: number;    // 本周 execution_records.actual_minutes 合计
  executionRate: number | null; // round(actual/plan*100)；planMinutes=0 → null（前端隐藏该行）
};
```

- ruleFallback.summary 增加（有排程时）：「本周计划 X 分钟 · 实际 Y 分钟 · 执行率 Z%」
- statsToText 增对应行（供 LLM prompt）。
- 周报渲染页（/weekly）读 content.stats 扩展字段；`planMinutes=0` → 显示「本周暂无 AI 排程，去计划地图安排计划」。

### 7.2 AgentContext 增今日执行事实
- `AgentContext` 加 `todayExecutions: Array<{ title, actualMinutes, source }>`（今天完成的 schedule + 实际投入；去 records repo 外新增 listExecutionByDate）。
- contextToText 增段「今日执行：…」，晚报/chat 的 LLM 因而能看见「今天按计划执行了什么」——**晚报与计划视图双轨就此打通**（Step 4 §11 已知差异收敛）。
- 纯增量字段：既有 evening/chat e2e 不回归。

### 7.3 双轨校准链路成形
```
Planner 排量（预计 N 分/天）
  → schedule 落库（计划）
  → completed → execution（实际）
  → 双窗口 dailySpentMinutesSince（records + execution）
  → 下一次 feasibility：按真实可投入能力建议
```

## §8 次要决策点（默认建议，可调）

| # | 点 | 默认 | 说明 |
|---|---|---|---|
| D1 | execution 与手动 records 重叠计数 | 接受重叠，不做去重 | 语义不同（事实 vs 证据）；未来加「来自排程」标记 |
| D2 | actual_minutes 录入形态 | 完成后**行内编辑**（点实际分钟数弹出数字输入），非每次完成弹窗 | 不打断勾选节奏；Q2「可修改」落地 |
| D3 | note 字段 | API 可写，前端本期不做编辑 UI | 留给复盘增强 |
| D4 | 周报无排程时 | executionRate=null，渲染隐藏该行 + 引导文案 | 不显示 0% 误导 |

## §9 验收清单

**5a 数据层**
1. schedule completed → execution_record 生成，`actual_minutes` = 计划时长
2. 重复 PATCH completed → 仍一行（UNIQUE 幂等）
3. 撤销 planned → execution 行删除、completed_at 清；再次完成重新生成
4. 手动传 `actualMinutes` → 覆盖默认（1-1440 校验）
5. 用户隔离（跨用户 404/空）+ 级联（删 goal/schedule → 清 execution）
6. **action 仍 planned**（隔离红线回归）

**5b 执行入口**
7. 时间轴完成后行显「实际 N 分钟」，点击可改（PATCH）
8. 撤销后记录行消失、实际分钟不再显示
9. manual schedule 完成也生成 execution（action_id=null）但 action 累计不受影响
10. 行动路线卡显示「投入 x / 预计 y」；≥ 预计时「已达预计投入」提示 + 手动确认仍有效
11. 前端 tsc/lint/build

**5c 成长反馈**
12. `dailySpentMinutesSince` = records + execution（造 execution 后数值变化）；无 execution 时 === 旧 `dailyMinutesSince`
13. Planner preview feasibility 消费新口径
14. weekly stats 出现 planMinutes/actualMinutes/executionRate；ruleFallback 文本含执行率
15. AgentContext.todayExecutions 注入 → 晚报 prompt 文本含「今日执行」段
16. 回归：planner-smoke / actions-api-smoke / timeline-smoke / weekly 既有用例全绿（无 execution 数据零回归）

## §10 开发顺序

```
5a 数据层   013_execution_records.sql + repo(execution.ts + planner completeScheduleTx/revertScheduleTx)
           + service timeline.setTimelineStatus 接事务 → tsx 冒烟（scripts/execution-smoke.ts）：验收 1-6
5b 执行入口 前端 TimelineItemCard 完成后显示/编辑实际分钟 + 行动路线 spentMinutes/达标提示（goals 聚合扩展）
           + API PATCH /api/executions/[id] → tsc/lint/build + HTTP e2e
5c 反馈闭环 repo/stats.dailySpentMinutesSince + weekly(plan/actual/rate) + AgentContext.todayExecutions
           + 周报渲染 → 全量回归（smoke 全绿 + 晚报/周报 e2e）
```

## §11 设计债 & 已知边界（记录）

- **legacy tasks fallback removal**（Step 4 §12）：Step 5 落地后仍不删，等周报双轨确认 + 用户迁移完成再评估。
- **overdue UI/周视图标注**：口径已冻结（planned && date<today 懒算），展示入口留未来。
- **execution 手动编辑 note / 补录（错过勾选后补记）**：本期不做；「补做」语义 = 用户重排新时段。
- **Timer 模式 / LLM 判 Action 完成 / schedule 自动重排（过期续排）**：Step 6+。
- `schedules.status` 的 `doing` 列仍保留（DB check），但执行路径永不产生 doing（前端只 planned/completed）；overdue 同样不落库——二者都是计算/展示态，非持久态。

---

*本方案以用户冻结决策表为基准；§8 四个次要点请审核时一并过目，确认后按 §10 开工 5a。*
