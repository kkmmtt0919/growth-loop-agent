# Phase 1「计划地图真实化」设计稿 v2（正式开发基线）

> 范围：0.3.0 MVP · 第 1 阶段
> 日期：2026-08-24（v2 修订）
> 状态：用户审核通过，正式开发基线
> 配套路线：docs/ROADMAP_0.3.0.md
>
> v1 → v2 变更（用户审核意见，全部采纳）：
> 1. `start_date/end_date` 明确可空（NOT NULL 禁止）；
> 2. Service 层引入 `GOAL_STATUS`/`TASK_STATUS` 常量，代码不散落中文/魔数；
> 3. `progress` 定位为 legacy cache 字段，事实来源是 `tasks.status`，业务 CRUD 禁止写 progress；
> 4. DELETE goal 流程显式化：事务内先置空关联任务 goal_id 再删目标；
> 5. 移动壳范围表述改为「查看 + 完成/撤销任务，不做目标管理入口」；
> 6. 补充：所有 CRUD 的按 id 查询必须带 user_id 过滤（隔离红线显式化）；
> 7. 补充：拆任务防重复策略（创建前检查 goal_id+title）。

---

## 1. 背景与目标

把计划地图从「demoSeed 展示」改为「真实用户数据」：

```
现状（要消灭）                        目标（本阶段达成）
页面                                  用户
 ↓                                     ↓
demoSeed.goals（写死）              数据库 goals/tasks
 ↓                                     ↓
展示                                   API（CRUD）
                                       ↓
                                       页面（桌面 + 移动壳）
```

本阶段完成后：新用户注册 → 创建目标 → 拆解任务 → 完成/编辑/删除 → 刷新数据仍在；
目标卡上的 `demoSeed.goals` 引用在计划页彻底移除；进度改为派生值。

## 2. 现状核对（已核验代码，非猜测）

| 现状 | 位置 |
|---|---|
| `goals` 表已存在：id/user_id/title/description/progress/horizon/status('进行中'/'待复盘'/'已归档')/时间戳 | `001_init.sql:38-48` |
| `tasks` 表已存在：含 **goal_id**（FK，on delete set null）、version、xp/coin/kind/status('done'/'current'/'upcoming') | `001_init.sql:53-67` |
| Goal 只有 seed 批量写入 + 列表查询，无增删改 | `lib/repo/goals.ts` |
| Task 只有 seed 写入 + list + toggle（toggle 事务内幂等结算账本） | `lib/repo/tasks.ts`、`PATCH /api/tasks` |
| 计划页目标卡 **写死 `demoSeed.goals`**（非真实数据） | `app/page.tsx` PlanPanel `:985` |
| 移动壳路线页 **写死 `demoSeed.goals[0]`** | `app/mobile-shell.tsx:261` |
| 「拆成行动」只改本地 state，**不落库**，刷新即丢 | `app/page.tsx splitGoal :691-709` |
| 本周重点（focusGoals）已是真实数据 | `GET /api/goals/summary`（已有） |
| 多用户隔离已通过端到端验证 | E-029（回归工具在，本阶段只回归不重做） |

## 3. 设计决策（已确认）

1. **不新建表**，migration 004 增量加列：
   - `goals` 加 `start_date date NULL`、`end_date date NULL`（**必须可空**——存量目标可能没有明确周期，禁止 NOT NULL）；
   - `tasks` 加 `deadline date NULL`、`frequency text NULL`；
   - records/evening 的列留到第 2/3 阶段，每个 migration 对应一个阶段验收。
2. **goals.status 保留中文枚举**（'进行中'/'待复盘'/'已归档'），不改英文。Service 层定义常量避免散落中文：
   ```ts
   export const GOAL_STATUS = { ACTIVE: "进行中", REVIEW: "待复盘", ARCHIVED: "已归档" } as const;
   export type GoalStatus = (typeof GOAL_STATUS)[keyof typeof GOAL_STATUS];
   ```
   同理 `TASK_STATUS = { DONE: "done", CURRENT: "current", UPCOMING: "upcoming" }`。
3. **progress 是 legacy cache，不是事实来源**：
   - 事实来源 = `tasks.status`；API 返回派生 `progress/taskCount/doneCount`（= 已完成/总数）；
   - **业务代码（create/update goal）禁止写 progress 列**：POST 创建时不传（默认 0），PUT 不接受 progress 字段；
   - 列保留兼容存量；首登 seed 播种行为保持不变（不扩大改动面）。
4. **goal_id 可空**：目标拆解任务挂 goal_id，独立每日行动（整理电脑/临时阅读/跑步）不强制挂目标。
5. **删除语义**：
   - DELETE task：直接删除，**不冲正账本**（产品设计 §6.5「删除任务不扣分」），已入账流水保留；
   - DELETE goal：**事务内显式两步**——先 `update tasks set goal_id = null where goal_id = $1 and user_id = $2`，再 delete goal。历史任务保留、账本不动（DB 的 on delete set null 作为兜底，业务侧显式控制顺序）。
6. **权限红线（显式）**：所有按 id 查询/更新/删除（GET by id、PUT、DELETE）一律 `where id = $1 and user_id = $2`，无 user_id 条件的 SQL 视为缺陷。隔离语义：跨用户操作返回 404（不泄露存在性）或 403，统一 404。

## 4. 数据层：migration `004_plan_crud.sql`

```sql
-- goals 增加业务起止日期（可空，YYYY-MM-DD）
alter table public.goals
  add column start_date date,
  add column end_date   date;

-- tasks 增加截止日期与重复频率（频率先存文本，供展示与后续调度解析）
alter table public.tasks
  add column deadline  date,
  add column frequency text;

-- 派生进度查询索引
create index idx_tasks_goal_status on public.tasks(goal_id, status);
```

说明：
- 全部为加列 + 索引，兼容存量 seed 数据；老账号的 2 个 demo 目标保留在库，用户可自行编辑/删除——「两个进行中的计划」问题随之自然解决。
- `progress` 列不删、业务不写（见决策 3）。

## 5. API 契约

认证：全部 `Authorization: Bearer <JWT>`（复用 `lib/auth/middleware` 的 `authenticate`）；错误统一 `{ error }` + 400/401/404；跨用户访问返回 404。

### 5.1 Goals

| 方法 | 路径 | Body / Query | 返回 |
|---|---|---|---|
| POST | `/api/goals` | `{ title*, description?, startDate?, endDate?, horizon? }` | `201 { goal }`（status 默认'进行中'，progress=0） |
| GET | `/api/goals` | `?status=`（可选过滤） | `200 { goals: [...] }`（每项含派生 progress/taskCount/doneCount，按 created_at 升序） |
| PUT | `/api/goals/[id]` | `{ title?, description?, startDate?, endDate?, horizon?, status? }` | `200 { goal }`（**不接受 progress 字段**） |
| DELETE | `/api/goals/[id]` | 无 | `200 { deleted: true }`（事务内先置空任务 goal_id） |

校验：title 必填非空；status ∈ GOAL_STATUS 白名单；日期格式 `YYYY-MM-DD`（可空）且 `endDate >= startDate`（同时填写时）。

### 5.2 Tasks

| 方法 | 路径 | Body / Query | 返回 |
|---|---|---|---|
| POST | `/api/tasks` | `{ title*, goalId?, subtitle?, scheduledTime?, durationMinutes?, deadline?, frequency?, kind?, xp?, coin? }` | `201 { task }`（status 默认 'upcoming'，xp/coin 默认 0） |
| GET | `/api/tasks` | `?goalId=&status=`（均可选） | `200 { tasks: [...] }`（按 scheduled_time 升序） |
| PUT | `/api/tasks/[id]` | `{ title?, subtitle?, scheduledTime?, durationMinutes?, deadline?, frequency?, kind?, goalId? }` | `200 { task }` |
| DELETE | `/api/tasks/[id]` | 无 | `200 { deleted: true }`（不冲正账本） |

**修改分层（硬规则）**：
- **状态变化唯一通道 = 既有 `PATCH /api/tasks`**（body `{ taskId, done }`，事务内幂等结算/冲正账本）。语义等价于 `/tasks/:id/toggle`，**不改路径**（已验收、前端在用，避免无谓回归）；
- **PUT = 元数据修改**：允许 title/subtitle/scheduledTime/durationMinutes/deadline/frequency/kind/goalId；**拒绝 status/xp/coin**——请求携带返回 400 并说明「状态变化请走 PATCH，xp/coin 由规则引擎结算」；
- 已完成任务的元数据仍可编辑，不影响已入账流水。

### 5.3 路由文件

```
app/api/goals/route.ts          POST / GET
app/api/goals/[id]/route.ts     PUT / DELETE
app/api/tasks/route.ts          新增 POST / GET（文件内已有 PATCH，追加方法）
app/api/tasks/[id]/route.ts     PUT / DELETE
```

## 6. Service / Repo 层

- 新增 `lib/service/goals.ts`：createGoal / listGoals / updateGoal / deleteGoal + `deriveProgress(goalId)`（统计 done/总数，装配 progress/taskCount/doneCount）+ `GOAL_STATUS` 常量。
- 新增 `lib/service/tasks.ts`：createTask / listTasks / updateTask / deleteTask（白名单字段、拒绝 xp/coin/status）+ `TASK_STATUS` 常量。
- 扩展 `lib/repo/goals.ts`：createGoal / updateGoal / deleteGoal / countTasksByGoal；扩展 `lib/repo/tasks.ts`：createTask / updateTask / deleteTask / listTasksByGoalId。
- 红线：所有 repo 函数签名带 userId，SQL 显式 `where user_id = $1`；按 id 操作一律 `id + user_id` 双条件；参数化 SQL。

## 7. 前端改动

### 7.1 桌面 Web（`app/page.tsx`）

1. 新增 `goals` state；`authMode === "ready"` 时拉 `GET /api/goals` 填充；增删改后重新拉取或本地更新。
2. `PlanPanel` 目标卡：`demoSeed.goals.map(...)` → `goals.map(...)`；空态显示「创建第一个目标」引导。
3. 新增 UI（MVP 内联，不新建组件文件）：
   - 「新建目标」按钮 → 内联表单（标题/描述/起止日期/周期）→ POST → 刷新；
   - 目标卡增加「编辑」（PUT）与「删除」（二次确认，DELETE）；
   - 进度条显示派生 progress；
   - 「拆成行动」由本地 state 改为 **POST /api/tasks（带 goalId）** → 刷新 tasks（解决刷新丢失）。
4. **拆任务防重复**：前端按钮在请求期间禁用（loading）；后端 createTask 创建前检查 `goal_id + title` 已存在 → 返回 409 `{ error: "同目标下已存在同名任务" }`（幂等语义：重复点击不会生成重复任务）。MVP 不新增 `source` 列，用检查替代；若后续需要审计来源，再加 `source` 列。
5. **AI Agent 路线卡**：写死的 `goal-ai-agent` 假对象（`page.tsx:987`）改为「模板建议」——点击「加入今日计划」时，若库中无该目标则先 POST 创建真实 goal（title=学习 Agent 并开发自己的 Agent，status='进行中'），再拆任务（POST /api/tasks，goalId 关联；同样走防重复）。
6. `toggleTask` 保持走 `PATCH /api/tasks`，不动。

### 7.2 移动壳（`app/mobile-shell.tsx`）

- `MobileAppShell` 增加 `goals` prop（page.tsx 传入真实数据）；`MobilePlanV3` 的 `demoSeed.goals[0]` → `goals[0]`，空态处理。
- **本阶段范围（正式表述）**：移动端复用真实数据，支持**查看目标、查看任务、完成任务、撤销完成**；**不承担目标管理入口**（创建/编辑/删除目标不在移动端提供，表单只在桌面 Web）。

### 7.3 样式

`app/globals.css` 少量新增（目标表单/按钮/空态样式），复用现有 goal-card 视觉。

## 8. 验收方案

### 8.1 自动化（新增 `scripts/e2e-goals.sh`，复用 e2e-closed-loop.sh 的注册/登录辅助）

1. 注册用户 A：
   - POST `/api/goals` 创建「半年英语提升」（含 start/end）→ 201；
   - POST `/api/tasks` 创建「每天背 30 词」（goalId）与「每周一次测试」（goalId）→ 201；
   - 重复 POST 同 goalId+title → 409（防重复生效）；
   - GET `/api/goals` → 目标存在，progress=0/2=0，taskCount=2；
   - PATCH 完成 1 个任务 → GET `/api/goals` → progress=1/2=50；
   - PUT 编辑目标标题 → GET 校验更新；PUT 带 xp/coin/status 字段 → 400；
   - DELETE 一个任务 → GET 校验减少，账本流水不变；
   - DELETE 目标 → 200，其余任务 goal_id 置空仍存在。
2. 注册用户 B：GET `/api/goals`、`/api/tasks` → 空；用 A 的目标 id 直接 PUT/DELETE → 404（隔离 + 不泄露）。
3. 回归：`scripts/idempotency-test.sh`（PATCH 账本链路未动）、`e2e-closed-loop.sh` 仍全过。

### 8.2 手动页面验收

注册新用户 → 桌面创建目标/拆任务 → 刷新数据仍在 → 编辑/删除闭环 → 移动壳（模拟器）路线页显示真实目标、任务可完成/撤销。

### 8.3 构建

`npm run typecheck`、`npm run lint`、`npm run build` 全过。

## 9. 风险与边界

- **不动账本链路**：PATCH /api/tasks 及其幂等结算为既有红线，本阶段只读不改（回归脚本兜底）。
- **DELETE task 不冲正**：符合产品设计 §6.5；如需「撤销删除恢复」再做审计补偿，本阶段不做。
- **seed 数据兼容**：老账号存量目标/任务原样展示，可编辑可删除，无需数据迁移脚本。
- **时区口径**：goal/task 的日期是用户业务日期（YYYY-MM-DD 原样存取，不做时区换算）；与晚报的 Asia/Shanghai 服务端日期是两套口径，互不干扰。
- **派生 progress 口径**：后续周报/Agent 上下文直接复用「任务完成率」派生口径，保证一致性。
- **进度条口径**：无任务的目标 progress=0；目标下任务全 done → 100。

## 10. 改动文件清单

新增：
```
supabase/migrations/004_plan_crud.sql
lib/service/goals.ts
lib/service/tasks.ts
app/api/goals/route.ts
app/api/goals/[id]/route.ts
app/api/tasks/[id]/route.ts
scripts/e2e-goals.sh
```

修改：
```
lib/repo/types.ts            （DbGoal/DbTask 增加字段）
lib/repo/goals.ts            （CRUD + countTasksByGoal）
lib/repo/tasks.ts            （CRUD）
app/api/tasks/route.ts       （追加 POST / GET）
app/page.tsx                 （goals state、PlanPanel、表单、splitGoal 落库、路线卡真实化、防重复）
app/mobile-shell.tsx         （goals prop、MobilePlanV3 真实化）
app/globals.css              （表单/空态样式）
```

## 11. 预期效果

- 计划地图 100% 真实数据，目标/任务可完整 CRUD，刷新不丢；
- 「拆成行动」「加入今日计划」真正落库并与目标关联，重复点击不产生重复任务；
- 派生进度驱动目标卡进度条；「两个进行中的 demo 计划」变为用户可管理的真实目标；
- 桌面与移动壳共用同一数据源，架构四层不变，为第 2 阶段（记录）与第 3 阶段（Agent Context）铺路。
