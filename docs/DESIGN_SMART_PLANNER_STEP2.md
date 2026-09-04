# Smart Planner Step 2：行动池改造（Action Pool）

> 上游：`docs/DESIGN_SMART_PLANNER_V1.md`（设计冻结，2026-09-04）§4 Step 2「行动池改造」
> 依赖：Step 1 已交付（011_smart_planner.sql + lib/repo/planner.ts，已落库 + 冒烟 21/21 通过）
> 日期：2026-09-04
> 状态：**设计冻结**（2026-09-04 用户审核通过；5 决策点定稿 + 补充决策见 §6，另有 1 项审核发现 → 012 迁移补 actions.completed_at）
> 进度：Step 2a 后端（012 迁移 + ActionPlan Generator + repo 事务 + service + API + 连库冒烟 14/14）✅ 已交付（2026-09-04 19:20）；Step 2c 前端（Goal 卡双入口 + 行动路线展示 + progress 派生）待开工
> 核心原则：**AI 是规划助手，不是替用户决定人生**——行动拆解产出「战略层路线图（Action）」或「战术层今日任务（Task）」，双入口并存、互不替换；真正进时间轴要等用户点「安排计划」。

---

## 0. Step 2 验收标准（用户定，2026-09-04，v2 增补）

| # | 验收项 | 判定 |
|---|---|---|
| 1 | 旧任务系统：今日时间轴 / toggle 完成 / 入账 / 晚报 还能工作 | ✅ 不破坏（tasks 链路一行不改） |
| 2 | 新入口「制定行动路线」：生成 `actions` + `action_dependencies` | ✅ 新链路 |
| 3 | 行动路线结果：**不进入今日时间轴** | ✅ 核心行为变更 |
| 4 | 既有数据：已拆到 tasks 的旧任务继续展示可操作 | ✅ 存量兼容 |
| 5 | 旧入口「拆今日任务」保留原语义原链路（双入口，不替换旧功能） | ✅ D1 定稿 |
| 6 | Action 手动「标完成」：不入 records/账本，但记录 `completed_at`（时间戳落 actions 表，012 迁移补列） | ✅ D5 定稿 |

**红线（贯穿 Step 2）**：
- 不动 `tasks` 表结构、`toggleTask`/账本、evening/weekly 的统计口径（它们只读 tasks/records）
- **不改造旧 decompose 链路**（`lib/agent/decompose-generator.ts` / `pure.ts` 校验 / `lib/service/decompose.ts` / eval 用例，全部原样保留）——它是「战术层今日任务」的既有入口
- 不实现 Planner / Schedule / 时间轴改造（那是 Step 3/4）
- 所有新查询带 user_id（repo 层函数签名强制，延续红线）

---

## 1. 当前 decompose 链路现状（file:line 全部核验）

### 1.1 时序图

```
Goal 卡片「拆成行动」按钮（page.tsx:1352 goal-card footer）
  │
  ▼
POST /api/goals/:id/decompose          （route.ts:16，无业务 body，authenticate）
  │
  ▼
lib/service/decompose.ts decomposeGoal（decompose.ts:59）
  ├─ getGoal(userId, goalId)                   404 不存在 / 400 空标题
  ├─ listTaskTitlesByGoal(userId, goalId)      去重素材（repo/goals.ts:133）
  ├─ computeStepRange(goal)                    按 end_date 天数或 horizon 启发式定步数
  │     ≤7d→2-3 │ ≤30d→3-4 │ ≤90d→4-6 │ 更长→5-8
  ├─ buildContextText(goal, existingTitles, range)
  ├─ generateDecomposePlan(...)                lib/agent/decompose-generator.ts:122
  │     LLM（SYSTEM_PROMPT 要求生成「今天就能开始的可执行行动」，
  │     estimatedMinutes 5-240、title ≤40、BIG_GOAL_WORDS 黑名单，
  │     15s 超时 × 最多 1 次带反馈重试）→ validateSteps 过滤 → 规则回退
  └─ 事务批量落库（decompose.ts:75-99）
        createTaskTx(client, ...) ×N          每步一张 tasks 行
        status='upcoming'、scheduled_time=''、subtitle=description、
        duration_minutes=estimatedMinutes、kind=mapCategoryToKind(category)、
        acceptance=完成标准（006 加的列）
        normalizeTitle 判重跳过（事务内再查一次防并发重复）
  │
  ▼
返回 { count, source, createdTaskIds, tasks(mapTaskToSeedTask) }   （route.ts:21-27）
  │
  ▼
前端 decomposeGoal（page.tsx:879-900）
  ├─ setTasks(prev => [...prev, ...data.tasks])   ★ 新任务直接并入今日 tasks state
  ├─ setLastDecompose({ ids, expireAt: +5min })   undo 锚点
  ├─ notify(`已拆出 N 步`)
  └─ refreshGoals()                               刷新卡片 taskCount/doneCount/progress
```

### 1.2 落点事实

| 事实 | 位置 | 说明 |
|---|---|---|
| 拆解产物 = `tasks` 行 | decompose.ts:97 | `scheduled_time=''` → 前端显示「今天」→ **直接出现在今日时间轴** |
| 前端把拆解结果并入今日 | page.tsx:888 | `setTasks` 是今日 Home + PlanPanel「今日时间轴」唯一数据源 |
| 撤销拆解 = 批量删 tasks | page.tsx:903-920 → DELETE `/api/tasks/batch`（repo/tasks.ts:269 batchDeleteTasks） |
| 目标进度派生自 tasks | goals.ts:42-46 `deriveView` | `progress = done/total`，`countTasksByGoal`（repo/goals.ts:120） |
| 卡片 footer 文案 | page.tsx:1352 | `{taskCount} 个任务 · {doneCount} 完成` |
| LLM schema | pure.ts:229-236 `DecomposeStep{order,title,description,acceptance,estimatedMinutes,category}` |
| LLM system prompt | decompose-generator.ts:12-39 | 明确「**切今天的可执行切片**，40 分钟能启动…如果目标太宏大，拆出的是第一个可执行切片，而不是路线图」 |
| 校验器 | pure.ts:291-305 | title ≤40、estimatedMinutes 5-240、BIG_GOAL_WORDS 命中即拒（「掌握/精通/学完/全面学习…」） |

### 1.3 关键结论：现在拆解生成的**语义**与 Step 2 要的 **Action 池**是两种东西

这是本次改造的真正分歧点，必须先说清：

- **现有 decompose 产「每日切片」**：prompt 强制「40 分钟内能启动」「5-240 分钟」「禁止把大目标当行动」——它是**给今天用**的，所以直接进今日列表是**正确行为**。
- **Smart Planner 要的 Action 池产「阶段级行动」**：用户示例是「毕业论文 → 确定方向 5h / 读论文 20h / 实验复现 40h / 撰写 50h」——是**目标路线图节点**，总量上百小时、有依赖关系、不落地到具体某天，**不进今日列表**。

两者差异不止"存哪张表"，而是 **prompt 语义、时长上限、质量校验规则全部相反**（现有校验器把「读完整方向」「完成阶段」这类大目标词直接判死，而 Action 池恰好要这种颗粒度）。

**因此 Step 2 不是"把 SQL 从 tasks 换成 actions"的机械替换**，而是新增一条语义独立的「行动路线」链路。经用户审核定稿（D1）：**双入口并存**——战术层「拆今日任务」走旧链路原样保留；战略层「制定行动路线」走新链路（§4/§5）。

---

## 2. 新增链路（目标态）：制定行动路线

```
Goal 卡片「制定行动路线」按钮（新增，page.tsx）
  │
  ▼
POST /api/goals/:id/actions/generate（新路由，authenticate）
  │
  ▼
lib/service/action-decompose.ts decomposeToActions（新）
  ├─ getGoal 404/400（沿用）
  ├─ listActionTitlesByGoal（去重素材，repo 层现成 listActionsByGoal().map(title)）
  ├─ computeActionCount(goal)         规则分档（D2 定稿）：<2 周→3 │ 2 周-3 个月→4 │ >3 个月→5-6
  ├─ generateActionPlan(...)           新 ActionPlan Generator（§3）
  │     产物：ActionDraft[]{title, description, estimatedMinutes, priority, dependsOnTitles[]}
  ├─ 校验：宽松版（阶段语义）
  └─ 事务落库（repo/planner.ts 新增 createActionsWithDepsTx）
       ① 批量 insert actions（pending）
       ② 按 dependsOnTitles → 前序 action id 解析依赖
       ③ 批量 insert action_dependencies
       ④ 环检测：Service 层拓扑（先做环则去掉该依赖，不做全量重试）
  │
  ▼
返回 { count, source, actions, dependencies }
  │
  ▼
前端「制定行动路线」handler（page.tsx 新增，不复用旧 decomposeGoal）
  ├─ setActionsByGoal(goalId → actions)   ★ 今日时间轴零污染（不碰 tasks state）
  ├─ setLastDecompose({ kind: "action", actionIds, ... })  undo 锚点换成 actions
  ├─ notify(`已生成 N 个行动阶段`)
  └─ refreshGoals()                       刷新卡片（actionCount 派生，D3）
```
旧入口「拆今日任务」= 现 decomposeGoal（page.tsx:879）+ 旧 /api/goals/:id/decompose——**一行不改**。

**两链路共用不变的骨架**：认证/404/去重/LLM 失败规则回退/响应含 source——沿用 decompose.ts 模式。

---

## 3. Schema 变化对照（用户指定节）

### 3.1 LLM 输出 schema

**旧（DecomposeStep / pure.ts:229）**
```ts
type DecomposeStep = {
  order: number;            // 顺序（隐含依赖：order 小的先做）
  title: string;            // ≤40 字、动词短语、40 分钟内能启动
  description: string;      // 一两句话
  acceptance: string;       // 完成标准（可验证）
  estimatedMinutes: number; // 5-240（今日切片）
  category: string;         // learning/exercise/coding/reading/creative/life/rest/other
};
```

**新（ActionDraft，Step 2 引入；用户审核定稿：30min~3000min）**
```ts
type ActionDraft = {
  title: string;              // ≤60 字、阶段名（建议动词短语：确定研究方向 / 阅读相关论文）
  description?: string;       // 阶段说明（可空，action 表 description 列）
  estimatedMinutes: number;   // 阶段预计投入：30-3000（审核定稿——30min 以下应进 Task，>3000=50h 说明阶段过粗需再拆）
  priority: number;           // 1-10（1 最高）。LLM 判断依赖链上的关键路径
  dependsOnTitles: string[];  // 前置阶段标题（多对多，如 实验复现 → 阅读相关论文）
};
```
差异要点：去掉 `order`（用依赖关系建模顺序，而非隐含 order）；去掉 `category`（actions 无 kind 语义，阶段不属于 focus/learn 5 类）；去掉 `acceptance`（阶段完成标准并入 description，避免为它再加列）；**新增 `dependsOnTitles` 显式依赖**。

### 3.2 落库映射

| ActionDraft 字段 | actions 列（011） | action_dependencies | 处理 |
|---|---|---|---|
| title | title | — | 归一化去重（normalizeTitle 复用） |
| description | description | — | 直接映射 |
| estimatedMinutes | estimated_minutes | — | 直接映射（011 check 1-200000 天然通过） |
| priority | priority | — | 直接映射（LLM 给 1-10，无值默认 5） |
| dependsOnTitles | — | depends_on | 先插 actions 拿 id，再按 title 精确匹配前序 id；同名未命中则丢弃该依赖并告警 |

### 3.3 校验规则对照（为什么不能复用现有 validator）

| 规则 | 旧（每日切片） | 新（阶段行动） | 依据 |
|---|---|---|---|
| title 长度 | ≤40 | ≤60 | action 表 check ≤200，60 对齐「阶段名」直觉 |
| estimatedMinutes | 5-240 | 30-3000（**审核定稿**） | Action 不是微任务：30min 以下应进 Task；>3000min（50h）说明阶段过粗，feedback 要求再拆。011 check 1-200000 不变，服务端/校验器限 |
| BIG_GOAL_WORDS 黑名单 | **命中即拒**（防切出宏任务） | **仍保留但降级为提示**（防「整目标当阶段」，如把「完成毕业论文」整个当作阶段） | 语义迁移 |
| 与已有行动重名 | 判重跳过 | 判重跳过（复用 normalizeTitle） | 不变 |
| 与已有 **tasks** 重名 | 判重 | 不必判（两表体系） | 语义分层 |

---

## 4. 后端改动点清单

### 4.1 新增/修改文件

| 文件 | 改动 | 说明 |
|---|---|---|
| `supabase/migrations/012_action_completed_at.sql`（新） | `alter table actions add column completed_at timestamptz` | **审核补充**（D5）：Action 完成需落时间戳，011 无此列，须补列迁移 |
| `lib/agent/action-decompose-generator.ts`（新） | ActionPlan Generator | 复制 decompose-generator 骨架（LLM → parse → validate → 规则回退），换 SYSTEM_PROMPT/EXAMPLE/时长与校验；产物 ActionDraft（30-3000min、3-6 阶段、dependsOnTitles） |
| `lib/agent/core/pure.ts`（改） | 加 `ActionStep` schema + `validateActionSteps` + `computeActionCount` | 阶段语义校验（§3.3）；分档规则 = <2 周→3、2 周-3 个月→4、>3 个月→5-6（D2 定稿）。**不动现有 validateStep/validateSteps**（旧链路 eval 用例依赖） |
| `lib/service/action-decompose.ts`（新） | `decomposeToActions(userId, goalId)` | 复刻 decompose.ts:59 的骨架，落点换 actions |
| `lib/repo/planner.ts`（改） | 新增 `createActionsWithDepsTx`（含 completed_at 语义的 `updateActionStatus`） | 事务：插 actions → 解析依赖 → 插 deps；整批原子。updateAction 置 completed 时 coalesce(completed_at, now())、撤销清空（对齐 updateScheduleStatus 模式） |
| `app/api/goals/[id]/actions/generate/route.ts`（新） | `decomposeToActions` HTTP 入口 | 响应：`{ count, source, actions[], dependencies[] }`。**旧 `/decompose` 路由原样保留**（双入口之一） |
| `lib/service/goals.ts` + repo | GoalView 扩展 `actionCount/completedActionCount` + `countActionsByGoal` | progress 派生：Action 优先，无 Action 退 tasks（D3 定稿，见 §6） |

### 4.2 明确不动的

- `lib/service/decompose.ts`、`lib/agent/decompose-generator.ts`、`pure.ts` 现有拆解校验、`eval/run.ts` 拆解用例、`app/api/goals/[id]/decompose/route.ts`——**全部原样保留**（战术层「拆今日任务」双入口之一，D1 定稿；不"等无调用方再下线"，它们是长期功能）
- `tasks` 表 / `toggleTask` / 账本 / evening / weekly / stats——零改动
- `schedules` / `user_availability` 无任何写入（Planner 未实现）

---

## 5. 前端影响范围（用户指定节）

### 5.1 今日页：不改（D1 双入口下旧链路原样保留）

- `TodayHome`（page.tsx:1197）数据源仍是 `tasks` state——**保持不变**
- 旧「拆今日任务」（现 decomposeGoal page.tsx:879）**继续把 task 并入今日 tasks**（page.tsx:888）——这是战术层正确行为，不回退
- 手动「添加任务」/ toggleTask / undo 旧任务：不变
- 既有已拆到 tasks 的数据：继续展示、可完成

### 5.2 计划地图 Goal 卡片：双入口 + 行动展示区

- **入口改造**（page.tsx:1352 goal-card footer）：
  - 旧按钮 label「拆成行动」→ 改「拆今日任务」（语义不变，仍走旧 /decompose）——避免与「行动路线」混淆
  - 新增按钮「制定行动路线」（战略层，走新 /actions/generate）
- 新 state：`actionsByGoal: Record<string, ActionView[]>`，随 loadData 拉取（新增 `GET /api/goals/:id/actions`）
- Goal 卡 footer（D3 定稿）：有 actions 时主进度 = `行动阶段 X/Y`（隐藏旧 taskCount 展示，让其自然淡出）；无 actions 有旧 tasks 时仍显示 `任务 N·M 完成`；「本周执行」等 Schedule 维度**不显示**（Step 4 才有数据源）
- 「制定行动路线」返回后：存 `actionsByGoal[goalId]`，卡片下方内嵌展开「行动路线」：
  - 每行：标题 + 预计时长（如「阅读相关论文 · 预计 20h」）+ 依赖徽标（「依赖：确定方向」）+ 状态（pending/planned/completed）
  - 手动「标完成 / 撤销完成」按钮（Action 完成需显式标记——开发规范② UI 落点；D5：不入账但记 completed_at），调 `PATCH /api/actions/:id`
- **卡片内嵌展开 vs 独立目标详情页**（D4 定稿）：内嵌展开；「独立详情页 + 安排计划入口」留 Step 3 Planner 一起做

### 5.3 undo 适配（两个入口各自保留 undo）

- 旧任务 undo：不动（lastDecompose task 分支 → DELETE /api/tasks/batch，page.tsx:903-920）
- 新行动 undo：`lastDecompose` 增 `{ kind: "task" | "action" }` 区分；action 分支撤销调 `DELETE /api/goals/:id/actions`（新，body `{ actionIds }`）：批量删 actions，deps 由 011 FK `on delete cascade` 自动清理（Step 2 无 schedule，天然安全）
- 前端同时从 `actionsByGoal[goalId]` 移除

---

## 6. 决策点定稿记录（2026-09-04 用户审核，v2 冻结）

| # | 决策 | 定稿结论 |
|---|---|---|
| D1 | decompose 语义：直接切换 or 双入口 | ✅ **双入口，不替换旧功能**——Action = 战略层（目标路线），Task = 战术层（今日执行），用户已形成「拆成行动=生成执行任务」认知，突然变语义会产生认知断裂。Goal 页两个入口：①「制定行动路线」（新，生成 Action 池）；②「拆今日任务」（旧，保留原语义原链路） |
| D2 | Action 阶段数 | ✅ **固定 3-6**，规则分档：短目标 <2 周 → 3；中目标 2 周-3 个月 → 4；长期 → 5-6。不做模型自由发挥（避免「第一阶段…第八阶段」无价值输出）。旧 computeStepRange（2-8）只服务于旧 task decompose，不动 |
| D3 | Goal 进度 | ✅ **Goal 看 Action、执行看 Schedule**——不双源混合（避免「任务 100% 但目标 20%」困惑）。Goal 卡主进度 = `行动阶段 X/Y`（Action 完成率）；「本周执行 8/10」属 Execution 维度，数据源是 Schedule，**Step 3/4 落地前不显示**。过渡兜底：无 actions 有旧 tasks → 退 tasks 派生；都无 → 0。taskCount 展示随旧任务自然淡出 |
| D4 | 行动列表 UI | ✅ **Goal 卡片内嵌展开**。Step 2 只验证「Action 生成 → 展示 → 状态变化」，不扩范围；独立详情页 + 「安排计划」入口留 Step 3 一并做 |
| D5 | Action 标完成 | ✅ **不入 records/账本，但记录 `completed_at`**——未来聊天「你什么时候完成这个阶段」要能答，时间戳落 actions.completed_at（→ **012 迁移补列**）；避免 Action 完成 + Schedule 完成双计，也避免与 records 重复计奖 |

### 审核发现的补充项（用户额外提，已并入正文）

1. **012 迁移：`actions.completed_at`**——011 冻结时 actions 无 completed_at 列，D5 要求记录完成时间 → 必须 `alter table actions add column completed_at timestamptz`（新文件 `012_action_completed_at.sql`）。repo `updateAction` 需补：置 completed 时 `coalesce(completed_at, now())`，撤销完成清空（对齐 `updateScheduleStatus` 模式，planner.ts:337）。
2. **ActionDraft.estimatedMinutes = 30~3000**（D6 补充决策）：30min 以下应进 Task（战术层），>3000min（50h）说明阶段过粗需再拆 → 服务端与校验器双限，feedback 重试让 LLM 修正；011 DB check（1-200000）不动。

### 迁移编号提醒（脚注）
`012` 原计划给 chat P2（chat_summaries / metadata jsonb，见 DESIGN_CHAT_PANEL 遗留）——现被 Step 2 占用，**chat P2 实施时顺延为 013/014**（chat 与 planner 互不依赖，仅编号登记冲突，已在今日工作日志记录）。

---

## 7. 记录的设计债（本期不做，2026-09-04 用户提示）

**actions 删除策略 → 未来 archived 软删除，不物理删**（用户 §五）

- 现状：`deleteAction`（planner.ts:169）物理删除 action + 清依赖
- 未来：`action.status` 增 `'archived'`（011 check 需扩展：`pending/planned/completed/archived`）；有历史 schedule / 完成记录的 action 一律走 archived，保留下「过去目标失败也是历史」的数据价值
- **Step 2 不做**：decompose 刚生成的 actions 都是 pending、无 schedule，物理删除无数据损失；等 Schedule 层落地（Step 3 后）再切软删除
- 迁移预案：届时 `alter table drop constraint + add check` 或新迁移扩展枚举（011 已落库；012 已被 completed_at 占用，届时用 013+）

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 改坏今日时间轴 / 旧任务 | §4.2 明列零改动清单；验收回归：旧账号全链路跑一遍 toggle/入账/晚报 |
| LLM 把阶段当整目标（「完成毕业论文」）或切太细 | 校验器保留 BIG_GOAL_WORDS 降级为提示 + estimatedMinutes 范围 30-3000 约束粒度 |
| 依赖引用悬空（dependsOnTitles 匹配不到） | 生成时把前序阶段标题随 context 带给 LLM 限制引用范围；落库前 title→id 精确匹配，未命中丢弃并告警，不回退整批 |
| 依赖成环（A→B→A） | Service 层拓扑环检测：落库后对新增依赖做 DFS 环检查，成环则去掉最后一条依赖 |
| 与旧校验器冲突 | 新建独立函数 + 独立文件，**不改** validateStep/validateSteps，eval 用例零回归 |
| 并发重复拆解 | 沿用事务内归一化去重（先查已有 actions 标题） |
| actions 大量生成无法管理 | 规则分档 3-6（D2 定稿，不做模型自由发挥）；不做拖拽排序（P2） |

---

## 9. 开发拆解与验证（用户定序：不直接改 decompose）

### Step 2a ActionPlan Generator（纯生成，可先不落库）
1. `012_action_completed_at.sql`：`alter table actions add column completed_at timestamptz`（D5 前置，先落库）
2. `lib/agent/core/pure.ts` 新增：`ActionStep` schema、`validateActionSteps`（title ≤60、estimatedMinutes 30-3000、BIG_GOAL_WORDS 降级提示、重复判拒）、`computeActionCount`（<2 周→3 / 2 周-3 个月→4 / >3 个月→5-6）
3. `lib/agent/action-decompose-generator.ts`：SYSTEM_PROMPT 面向「阶段级路线图」（禁止 30min 微任务、阶段可 50h 级、产出 dependsOnTitles 必须与同批 title 精确一致）→ LLM 15s×重试 1 → validateActionSteps → 规则回退（3-4 个链式阶段模板，estimated 500-1500 区间）
4. 验证：tsx 连库冒烟（不经 HTTP）——真实 goal 输入生成 ActionDraft[]，断言 3-6 阶段、时长 30-3000、无整目标词；LLM 关闭时规则回退可用

### Step 2b 接 repo + HTTP 闭环
1. `repo/planner.ts` 新增：`createActionsWithDepsTx(userId, drafts[])`（事务：批量插 actions → 按 title 精确匹配解析 dependsOn → 插 action_dependencies → 环检测成环去边）+ `updateActionStatus`（置 completed 记 coalesce completed_at、撤销清空）+ `listActionTitlesByGoal`（可复用 listActionsByGoal 现成，仅作别名）——updateAction 现有函数若扩展需保证不破坏既有语义
2. `lib/service/action-decompose.ts`：decomposeToActions（骨架同 decompose.ts:59，落点 actions）
3. `app/api/goals/[id]/actions/generate/route.ts`（新）——旧 /decompose 不动
4. 验证：typecheck/lint；tsx 连库端到端——真实 goal → generate → 断言 actions + deps 落库、**tasks 表 0 增长**、重复调用不产生重复标题、跨用户不可见；LLM 关掉规则回退仍可用

### Step 2c 前端（Goal 卡行动路线）
1. `GET /api/goals/:id/actions`（list，供 loadData 回显）+ `PATCH /api/actions/:id`（标完成/撤销，repo updateActionStatus）+ `DELETE /api/goals/:id/actions`（批量撤销，undo）
2. page.tsx：goal-card footer 双入口（「拆今日任务」改名 + 「制定行动路线」）；`actionsByGoal` state + loadData 拉取 + 卡片内嵌展开「行动路线」+ 标完成/撤销 + undo kind 区分
3. lib/service/goals.ts + repo/goals.ts：`countActionsByGoal` → GoalView 增 actionCount/completedActionCount；progress 派生 D3 规则（Action 优先 / 无则退 tasks / 都无 0）
4. 验证：build；浏览器手工回归——旧「拆今日任务」照常进今日；「制定行动路线」产物只出现在卡片行动列表；标完成/撤销刷新正确；undo 各自清理

### Step 2 验收清单（映射 §0）
- [ ] tasks 链路零改动回归（拆今日任务/toggle 完成入账/今日列表/晚报生成）
- [ ] 行动路线 → actions + dependencies 落库，`select count(*) from tasks` 无新增
- [ ] 今日页无行动路线产物
- [ ] 撤销行动路线 → actions + deps 全清
- [ ] 跨用户不可见 / 伪造 id 404/403
- [ ] LLM 不可用时规则回退仍产出可展示阶段
- [ ] 标完成记录 completed_at、不入 records/账本；撤销完成清空时间戳

---

## 10. 一句话总结

Step 2 新增一条**战略层链路**（Goal「制定行动路线」→ Action 池 + 依赖，等「安排计划」才进时间轴），与保留的**战术层链路**（Goal「拆今日任务」→ Task 进今日列表）双入口并存、互不替换——真正的语义升级在 ActionPlan Generator（阶段级 prompt、3-6 阶段分档、30-3000min 校验、显式依赖），今日时间轴零改动，靠「新产物只写 actions、前端不 setTasks」保证。
