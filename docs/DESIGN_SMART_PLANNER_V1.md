# Smart Planner V1 设计稿（目标 → 行动池 → 计划 → 时间轴）

> 范围：0.3.0 MVP 之后 · 把「目标拆解」升级为「AI 规划助手」
> 日期：2026-09-04
> 状态：**设计冻结**（5 个决策点全部定稿，含用户 3 处补充调整；审核通过后进入 Step 1 数据层开发）
> 上游需求：用户 2026-09-04 确认的最终业务闭环（Goal → AI Decompose → Actions → Planner → Schedule → Execution → Review）

---

## 0. 目标与边界

用户核心主张：**「不是 AI 替用户决定人生，而是 AI 做一个『规划助手』」**。

产品闭环：

```
Goal
 ↓
AI Decompose → Actions（长期行动池，不进今日时间轴）
 ↓
用户点击「安排计划」
 ↓
Planner（时间约束 + 历史执行数据）
 ↓
计划建议 → 用户确认 → Schedules（今日时间轴唯一数据源）
 ↓
Execution → Evening / Weekly Review → Planner 调整
```

**边界（不做 / 后置）**：
- P1 不做「每周自动生成计划」；Planner 只在用户点击「安排计划」时运行
- P1 不做 Action 拖拽排序、手动微调 Schedule（只做「接受/拒绝」二选一）
- P1 不做多目标并行规划（一次只规划一个目标）
- P1 不做通知/提醒（推送、邮件、日历订阅）
- `tasks` 表保留给「轻量每日任务」使用；长期路线图任务用新 `actions` 表，两表不混

**定稿决策（2026-09-04 用户审核冻结）**：

| 决策点 | 定稿结论 |
|---|---|
| Action 池 | ✅ 独立建表（`actions`），不复用 tasks；pending → planned → completed |
| 计划确认 | ✅ 先出「计划建议」预览 → 用户「接受」才写 schedules；P1 只生成未来 2 周粒度 |
| 固定时间块 | ✅ `user_availability` 独立表（模板）+ 今日时间轴读取 availability 合并展示 fixed 块；固定块**不落 schedules 表**，避免污染完成率统计 |
| overdue | ✅ 懒计算（查询时 `date<today && status='planned'` 实时标记），不做定时任务 |
| 历史校准 | ✅ **双窗口**：近 7 天（短期执行状态）+ 近 30 天（长期真实能力），Planner 同时输出两者而非单一数字 |

---

## 1. 数据模型（Phase 1，新迁移 011_smart_planner.sql）

### 1.1 新增 4 张表

沿用项目既有约定：**RLS enable + 无 policy（BYPASSRLS 应用直连）**、所有外键 `on delete cascade`、所有查询显式带 `user_id`、日期统一按 Asia/Shanghai。

#### ① `actions`（长期行动池）

```sql
create table public.actions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  goal_id            uuid not null references public.goals(id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 200),
  description        text,                          -- 可空，阶段说明
  estimated_minutes  int  not null check (estimated_minutes between 1 and 200000),
  priority           smallint not null default 5,   -- 1 最高 → 10 最低（用户可调）
  status             text not null default 'pending'
                     check (status in ('pending','planned','completed')),
  sort_order         int not null default 0,        -- 目标内展示顺序
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_actions_goal     on public.actions(goal_id);
create index idx_actions_user     on public.actions(user_id);
create index idx_actions_status   on public.actions(goal_id, status);
```

- **status 流转**：`pending`（待规划）→ `planned`（已有日程）→ `completed`（行动完成）
- 依赖关系用独立表（见下），不在这里加列
- 不做软删除；删除走 cascade（用户删除目标 → 连带删 action + schedule）

#### ② `action_dependencies`（依赖关系，多对多）

```sql
create table public.action_dependencies (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  action_id    uuid not null references public.actions(id) on delete cascade,
  depends_on   uuid not null references public.actions(id) on delete cascade,
  created_at   timestamptz not null default now(),
  constraint action_dep_unique unique (action_id, depends_on),
  constraint action_dep_no_self check (action_id <> depends_on)
);

create index idx_action_dep_action on public.action_dependencies(action_id);
create index idx_action_dep_depends on public.action_dependencies(depends_on);
```

- **为什么独立表**：多对多关系（「实验复现」依赖「论文阅读」）的正确建模；未来可增量加依赖、可查反向依赖（"哪些事卡在我后面"）
- `user_id` 冗余存一份：即使只拿到 action_id 也能校验归属，且所有查询显式带 user_id（项目红线）
- **环检测**：P1 由 LLM 生成时提示「不得有环」，Service 层对 LLM 输出做拓扑校验（深度优先遍历，发现环 → 规则回退）；不做 DB 级递归约束（PG 递归 CTE 查询依赖关系放 P2）

#### ③ `schedules`（真正日程，今日时间轴唯一数据源）

```sql
create table public.schedules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  action_id    uuid references public.actions(id) on delete cascade,  -- 可空：仅 manual 来源无 action
  goal_id      uuid references public.goals(id) on delete cascade,     -- 冗余，便于按目标聚合
  source       text not null default 'action'     -- 开发规范①：NOT NULL，不允许无来源数据
               check (source in ('action','manual')),
  date         date not null,                     -- 业务日期（Asia/Shanghai）
  start_time   time not null,
  end_time     time not null check (end_time > start_time),
  title        text not null check (char_length(title) between 1 and 200),
  status       text not null default 'planned'
               check (status in ('planned','doing','completed','overdue')),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint schedule_no_overlap check (true)   -- 占位，重叠校验放 Service/应用层（见 §2.3）
);

create index idx_schedules_user_date on public.schedules(user_id, date);
create index idx_schedules_action on public.schedules(action_id);
```

- **status 流转**：`planned`（安排）→ `doing`（执行）→ `completed`（完成）；`planned` → `overdue`（错过）→ 重新安排
- **`source` 必有来源（开发规范 ①，2026-09-04 用户补充）**：NOT NULL，取值 `'action' | 'manual'`，**不允许无来源数据**：
  - `source='action'` → 由 Action 安排而来（`action_id` 非空、`goal_id` 非空）
  - `source='manual'` → P2 手动日程（无 Goal/Action 的临时事项，如「下午去医院」，`action_id` 空、`goal_id` 空）
- **`action_id` 可空 = 非 Action 来源（审核补充 ①）**：用户固定时间块（上课、运动）**不落本表**——它是 `user_availability` 模板 + 前端合并展示（fixed 项），避免污染 schedules 完成率统计（定稿决策 3）；若未来需要把固定块也纳入统计，应显式以 `source='manual'` 落表，而不是无来源裸插
- **为什么 `title` 冗余存一份**：action 标题可能被用户改名，schedule 快照当时安排的内容；也避免固定时间块 join
- **重叠校验在应用层**：Planner 生成时保证不重叠；用户手动改（P2）时 Service 校验。DB 约束做区间重叠需要 `exclude` 约束（`btree_gist` 扩展），为保持"纯标准 PG + 无扩展依赖"的迁移红线，**不用** exclude 约束（项目红线：避免 Supabase 专属能力，`btree_gist` 是标准扩展，但重叠业务规则复杂——比如"19:00-20:30 和 20:00-21:00 是否算重叠"取决于允许背靠背，放应用层可调）

#### ④ `user_availability`（用户固定时间）

```sql
create table public.user_availability (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),  -- 0=周一 … 6=周日
  start_time  time not null,
  end_time    time not null check (end_time > start_time),
  type        text not null default 'learn'
              check (type in ('learn','work','exercise','life','rest')),
  title       text not null default '',          -- 如「上课」「运动」，进时间轴展示
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_availability_user on public.user_availability(user_id, weekday);
```

- **语义**：`type='learn'` 且 title 为空 → 纯可安排时间段（Planner 的候选池）；`title` 非空（如「上课」「运动」）→ 固定块，**Planner 不可占用**，但会展示在时间轴
- weekday 用 0-6 而非 'Mon' 文本：查询排序方便、无 locale 歧义

### 1.2 RLS

```sql
alter table public.actions              enable row level security;
alter table public.action_dependencies  enable row level security;
alter table public.schedules            enable row level security;
alter table public.user_availability    enable row level security;
```

不建任何 policy（与 007 一致，BYPASSRLS 应用直连）。

### 1.3 存量兼容

- **`tasks` 与旧今日时间轴解绑**：这是 Phase 1 唯一对现有行为的破坏性变更，拆成两步做（见 §4 迁移步骤）：
  1. 数据层：今日时间轴查询从 `listTasks` 改为读 `schedules`（+ 固定时间块）
  2. 前端：Home「今日」Tab 渲染改为读新接口 `/api/schedules/today`
- **`tasks` 表保留**：轻量每日任务（用户随手加的"今天做 X"）继续用它，但不再出现在「今日时间轴」里（除非用户安排进 schedule，P2 支持"从 task 转 schedule"）

---

## 2. Planner 核心（Phase 2）

### 2.1 分层落点

```
app/api/goals/[id]/plan
  → lib/service/planner.ts        （业务编排：收集输入 → 调 LLM → 校验 → Rule Scheduler 排程 → 生成建议）
    → lib/agent/planner-generator.ts  （LLM 生成 Plan JSON：排序/优先级/工作量/周分配，复用 decompose 的「生成 → Schema 校验 → 规则回退」模式）
    → lib/service/planner-scheduler.ts （Rule Scheduler 纯函数：把 Plan JSON + 固定时间模板 → 精确不重叠的 slot）
    → lib/repo/planner.ts         （4 表 CRUD + 聚合查询，函数签名强制 userId）
```

复用成熟模式：`lib/agent/decompose-generator.ts` 的 `LLM 生成 → zod Schema 校验 → 质量校验 → 规则回退` 全链路。**与 decompose 的分工一致：LLM 负责智能，规则负责稳定。**

### 2.2 输入收集（Planner 输入 = 目标 + Action池 + deadline + 用户固定时间 + 历史执行）

`lib/service/planner.ts` 收集：

| 输入 | 来源 |
|---|---|
| 目标信息（title / deadline / 已投入估计） | `goals` 表（`end_date` 即 deadline） |
| Action 池（含依赖、估计时长、优先级） | `actions` + `action_dependencies` |
| 用户固定时间 | `user_availability`（按 weekday 展开未来 N 天） |
| 历史执行情况 | `stats.ts` 已有：`dailyMinutesSince(userId, startDate)` 可传任意起始日期——**近 7 天 + 近 30 天双窗口**（定稿决策 5），加一个求平均的纯函数即可 |

**历史校准 = 双窗口，不二选一**（定稿决策 5）：

- **7 天窗口** → 短期执行状态，回答「你最近是不是在执行？」（如考试周每天只 20 分钟）
- **30 天窗口** → 长期真实能力，回答「你的真实平均能力是多少？」（如平时每天 90 分钟）

Planner 同时输出两者而非单一数字：

> 最近 7 天你的执行下降到 40 分钟/天，但过去 30 天平均为 90 分钟/天，当前计划存在轻微压力。

**可行性判断**（`feasibility.verdict`）以此双窗口为准：`requiredPerDay` 与 `longTermPerDay`（长期能力）比较判「基本可行」，与 `shortTermPerDay`（近期状态）比较判「当前节奏是否健康」——这正是用真实数据反向约束计划，而非 AI 拍脑袋。示例：

> AI 初步估 115h，按用户固定时间 19:00-22:00 每晚 3h，12 周足够 → 但 `dailyMinutesSince` 显示过去 7 天平均每天只投入 40 分钟（短期偏离）而 30 天平均 90 分钟（长期正常）→ Planner 提示「短期节奏偏低，建议本周先恢复，整体按 30 天节奏可完成」。

### 2.3 计划生成流程（用户确认前不写 Schedule；LLM 与 Rule Scheduler 分离——审核补充 ②）

**核心原则**：LLM 负责「智能判断」，Rule Scheduler 负责「稳定排程」。LLM 绝不直接输出 `19:00/20:30/21:15` 这种精确 slot——模型容易生成时间冲突（`19:00-20:30` 与 `20:00-21:30` 重叠）；精确 slot 分配由纯函数规则算法根据用户固定时间模板计算，保证时间不重叠、落在可安排时段内。

```
POST /api/goals/:goalId/plan
  → collectInputs(userId, goalId)            // 服务端收集全部输入（目标 + Action池 + deadline + 固定时间 + 历史双窗口）
  → LLM Planner（lib/agent/planner-generator.ts）
      → 输出 Plan JSON：只含「排序 + 优先级 + 工作量 + 周分配建议」
        { "ordering": [...actionId],          // 依赖拓扑序 + 优先级排序（LLM 判断"先做什么"）
          "estimates": { "actionId": 540 },   // 工作量估算（分钟）
          "weeklyAllocation": [ "8h", "9h" ], // 每周建议投入（按双窗口历史校准后给出）}
  → validateSuggestion()                     // zod Schema + 依赖拓扑校验（发现环 → 规则回退）
  → Rule Scheduler（lib/service/planner.ts 内纯函数）
      → 输入 Plan JSON + user_availability 展开的候选时段
      → 按「ordering + priority」把 action 塞进最近 2 周的可用 slot（跳过 type='learn' 之外的固定块）
      → 输出精确到 date/start/end 的建议条目，逐条保证不重叠
  → 规则回退：LLM 失败时用「estimated_minutes 均摊」纯算法兜底（同 decompose 模式）
  → 返回 { suggestion, feasibility }         // 建议 + 可行性判断，不落库
```

**建议结构**（示例——`weeks[].items` 由 Rule Scheduler 产出精确时间）：

```json
{
  "feasibility": {
    "totalMinutes": 6900,
    "remainingDays": 90,
    "requiredPerDay": 76.7,
    "shortTermPerDay": 40,
    "longTermPerDay": 90,
    "verdict": "tight",
    "message": "最近7天执行下降到40分钟/天，但过去30天平均为90分钟/天。按你的历史节奏，115小时有压力但可行，建议本周先恢复节奏。"
  },
  "weeks": [
    {
      "weekIndex": 1,
      "items": [
        { "actionId": "uuid-3", "title": "阅读相关论文", "date": "2026-09-07", "startTime": "19:00", "endTime": "20:30" },
        { "actionId": "uuid-3", "title": "阅读相关论文", "date": "2026-09-09", "startTime": "19:00", "endTime": "20:30" }
      ]
    }
  ]
}
```

- **`weeks` 的粒度**：P1 只生成「未来 2 周」的精确到日期时间的建议（用户确认后写 schedule），剩余量展示为「后续按此节奏续排」——避免一次生成 12 周 100+ 条让用户无法审核
- **Rule Scheduler 第一版 = 简单贪心排程（开发规范 ③，2026-09-04 用户补充）**：按 `ordering + priority` 顺序，把每个 action 依次塞进「最近可用 slot」（当天第一个满足时长要求的空档就排，塞完即走），**不做全局最优搜索、不回溯重排、不跨目标合并**——只保证单条建议不重叠、落在可安排时段内。先跑通闭环，排程质量（更均匀分布、避免碎片化）留到后续版本再优化
- 用户「接受计划」→ `POST /api/goals/:goalId/plan/accept` → 服务端把 `weeks` 落成 `schedules` 行（`source='action'`）+ 把对应 action 的 `status` 从 `pending` 改成 `planned`

### 2.4 今日时间轴合并展示（审核补充 ③：fixed + schedule 联合）

`GET /api/schedules/today` 返回**两类 TimelineItem 合并**后的时间轴（按 start_time 排序），前端不区分数据来源、统一渲染：

```ts
type TimelineItem =
  | { type: "schedule"; id: string; title: string; start: string; end: string;
      actionId: string | null; status: "planned" | "doing" | "completed" | "overdue" }
  | { type: "fixed"; id: string; title: string; start: string; end: string; kind: "learn" | "work" | ... };
```

- **fixed 项来源**：`user_availability` 中 `title` 非空的固定块（上课/运动），按当天 weekday 运行时展开成当日的固定项——**不落 schedules 表**（定稿决策 3），完成率统计只统计 schedule
- **schedule 项来源**：`schedules where date = today` 且 `status != 'overdue'`（懒计算过滤）
- 用户看到的今日：「课程 09:00-12:00（fixed）→ AI 安排任务 19:00-20:00（schedule）」，固定生活与 AI 计划共存，不会觉得"我的固定生活去哪了"
- 服务端组装（Repo 层查两处 + Service 层合并排序），前端只消费一个接口

### 2.5 API 设计

```
GET  /api/goals/:goalId/actions                 // 行动池列表（目标详情页）
POST /api/goals/:goalId/decompose               // 已有：拆解成 action 池（改造 006）
POST /api/goals/:goalId/plan                    // 生成计划建议（不落库）
POST /api/goals/:goalId/plan/accept             // 接受建议 → 写 schedules + action.planned
GET  /api/schedules/today                       // 今日时间轴（唯一数据源）
GET  /api/availability                          // 用户固定时间 CRUD 列表
POST/PUT/DELETE /api/availability/:id?          // 固定时间维护
```

### 2.6 状态机（写进 Repo 层，Service 层校验）

```
Action:  pending → planned → completed
Schedule: planned → doing → completed
          planned → overdue →（重新安排 → planned）
```

- 「doing」由用户点击「开始」置位（P1 前端支持）
- 「overdue」由**懒计算**：查询今日时间轴时，`date < today 且 status='planned'` 的行实时标记为 overdue（不落库写死，避免每天定时任务）——或 P1 直接查 `date=today` 就不出现昨天任务（符合用户第 6 条），overdue 状态仅做展示提示
- **Schedule 完成 ≠ Action 完成（开发规范 ②，2026-09-04 用户补充）**：schedule 标记 `completed` 只代表「这一次安排执行完了」，**绝不自动推进** `action.status`；Action 是目标级里程碑（比如「阅读相关论文」整阶段），需用户在行动池显式点「完成」才置 `completed`——防止「做完一次阅读 schedule 就把整个阅读阶段标完成」的语义错误。两条状态机各自独立推进，Service 层不做联动，唯一的自动流转只有 Schedule 自身 `planned → doing → completed`

---

## 3. 闭环接入（Phase 3）

### 3.1 晚间复盘（evening）

现有 `lib/service/evening.ts` 只做「统计 + 建议」，不写回。改造：

- **输入扩展**：`buildAgentContext` 增加「今日 schedule 计划 N 项 / 完成 M 项 / 未完成 X 项」（来自 schedules 表）
- **写回**：晚报生成时，若 `schedules.status='planned'` 且 `date < today`（错过）→ 自动标注 `overdue` + 建议「明天优先安排」；用户确认后 Planner 重新排
- 这是「未完成自动流转」的第一步，P1 只做「标注 overdue + 建议」，P2 做「一键重排」

### 3.2 周报（weekly）

现有 `lib/service/weekly.ts` 已按周聚合任务/记录。扩展：

- 增加「本周 schedule 完成率」（planned vs completed）
- 增加「目标级进度」：action 池中 `completed / total`（而不是现在的 task 数）

### 3.3 聊天上下文（chat context）

现有 `lib/service/context.ts` 的 `buildAgentContext` + `contextToText` 已把目标/任务/记录/7 天统计/最近晚报注入聊天。扩展：

- 增加 `plannerStats`：目标路线图（action 池 + 依赖）、本周 schedule、未完成流转、目标级完成率
- 效果：用户问「我毕业论文进度怎么样？」，Agent 基于真实数据回答：
  > 你的论文目标预计需要 115 小时，目前完成 32 小时。过去 7 天平均每天投入 1 小时，比计划低 20%，建议调整本周安排。
- **注意注入格式**：沿用「参考材料」段落方式（防 prompt 注入），且控制 token——action 池最多注入 20 条、schedule 本周内

---

## 4. 迁移步骤（Phase 1→3 分步落地）

| 步骤 | 内容 | 验收 |
|---|---|---|
| **Step 1 数据层** | 011_smart_planner.sql（4 表 + 索引 + RLS）+ repo/planner.ts（CRUD + 聚合）| typecheck；迁移落库；表结构核对 |
| **Step 2 行动池** | 改造 `/api/goals/:id/decompose` 输出落 `actions`（不再直接落 tasks）；目标详情页行动列表 | 拆解后 actions 有数据、今日时间轴不变（actions 不进时间轴）|
| **Step 3 Planner** | planner-generator + planner service + `/plan` + `/plan/accept` + `/schedules/today` | 三连验证：工作量估算 / 时间不足提示 / 接受后 schedules 落库 |
| **Step 4 时间轴** | 前端 Home「今日」Tab 改读 `/schedules/today` + 固定时间块 | 时间轴只显示今天 schedule，昨天任务消失 |
| **Step 5 闭环** | evening / weekly / chat context 接入 plannerStats + overdue 标注 | 晚报出现「计划 4 完成 3」；聊天能回答进度 |

---

## 5. 决策点定稿记录（2026-09-04 用户审核冻结）

1. **Action 池独立建表** ✅ 确认——不复用 tasks；状态机不同（长期路线图节点 vs 可执行任务），避免今日列表污染
2. **「接受计划」前先生成建议预览** ✅ 确认——时间安排属于用户控制权，产品定位是"AI 规划助手"非自动管家；P1 生成未来 2 周粒度，其余按节奏续排，不一次生成 12 周 100+ 条
3. **固定时间块归属** ✅ 确认「两者共存」——`user_availability` 独立表作为模板被 Planner 消费；同时今日时间轴读取 availability 合并展示固定块（fixed + schedule 联合，见 §2.4）；固定块**不落 schedules 表**，避免污染完成率统计
4. **overdue 懒计算** ✅ 确认——查询时 `date<today && status='planned'` 实时标记，不做定时任务/后台 job；用户量大后再改
5. **历史校准窗口** ✅ 确认「双窗口」——近 7 天（短期执行状态）+ 近 30 天（长期真实能力）同时输出，不二选一（见 §2.2）

**用户补充的设计调整（已并入正文）**：

- ① Schedule 支持非 Action 来源：`schedule.action_id` 可空——固定时间块不落本表；空值预留给 P2 手动日程（无 Goal 的临时事项如「下午去医院」），届时来源区分 action / manual（见 §1.1 ③）
- ② LLM 与 Rule Scheduler 分离：LLM 只输出 Plan JSON（排序/优先级/工作量/周分配），精确 slot 分配由规则算法负责，杜绝模型生成时间冲突（见 §2.3）
- ③ 固定时间块展示方案：今日时间轴为 fixed + schedule 联合 TimelineItem，前端统一渲染（见 §2.4）

---

## 6. 工作量预估（相对值）

- Step 1 数据层：小（1 迁移 + 1 repo 文件，约 2 个工时）
- Step 2 行动池改造：中（decompose 输出改道 + 前端行动列表，约 4 个工时）
- Step 3 Planner：中（LLM 生成 Plan JSON + zod 校验 + Rule Scheduler 纯函数 + 2 个 API，约 7 个工时）
- Step 4 时间轴改造：中（前端渲染改数据源 + fixed/schedule 合并，约 3 个工时）
- Step 5 闭环：中（3 处 context 扩展 + 晚报写回，约 5 个工时）

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 估算偏差大 | 历史双窗口校准（真实数据反向约束）+ 规则回退（均摊算法）双保险 |
| LLM 生成精确时间冲突（19:00-20:30 与 20:00-21:30 重叠）| **LLM 不输出精确 slot**——只出 Plan JSON，Rule Scheduler 纯函数排程，逐条保证不重叠（审核补充 ②）|
| 计划生成过多条目用户无法审核 | P1 只出 2 周粒度建议；接受后再续排 |
| 依赖环 | Service 拓扑校验（DFS），发现环 → 规则回退 |
| 时间重叠（手动改等 P2 场景）| Service 生成时校验 + 展示冲突提示 |
| 旧数据（老 tasks 无 schedule）| 迁移期间「今日」Tab 空窗可接受；老 task 仍可通过「记一笔」留记录 |
| 多实例限流/并发（计划生成昂贵）| 复用 chat 的进程内限流模式；多实例后换 Redis（已在 chat 记录）|
