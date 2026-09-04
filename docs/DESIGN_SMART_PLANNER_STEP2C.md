# Smart Planner Step 2c：前端接入「制定行动路线」

> 上游：`docs/DESIGN_SMART_PLANNER_V1.md` §4 / `docs/DESIGN_SMART_PLANNER_STEP2.md` §5、§9（设计冻结）
> 依赖：Step 2a 后端已交付（POST /goals/:id/actions/generate + createActionsWithDepsTx + ActionView，冒烟 14/14）
> 日期：2026-09-04
> 状态：**设计冻结**（2026-09-04 用户审核通过；修订记录见 §0，随后开工 2c-1/2c-2/2c-3）
> 原则：今日页 / 旧「拆今日任务」链路 / records / 账本**零改动**；Step 2 只让「行动路线」在前端可生成、可看、可标完成。

## 0. 审核修订记录（2026-09-04 用户 v2，正文以代码实现为准）

1. **C1 拉取粒度改「数据内嵌，不裸全量」**：采纳 §七 建议——**后端聚合**，`GET /api/goals` 返回的每个 GoalView 直接内嵌 `actions: ActionView[]` + `actionCount/actionDoneCount`，**前端不再自己 merge 两个接口**（消除 actionsByGoal 独立 state）；同时实现 `GET /api/actions?goal_ids=id1,id2` 作为资源端点预留（goal_ids 可选，缺省=当前用户全部，MVP 可接受）。
2. **C2 默认展开**：MVP 阶段采纳默认展开（目标数少，正在验证 Action 价值）；折叠优化留 Step 3 后。
3. **C4 空态文案**：全 skipped 时不报错，toast「暂未生成行动阶段，可以重新规划」；部分生成正常提示 N 个阶段。
4. **命名**：`lastDecompose` → **`lastGenerate`**（现在承载 task/action 两类产物，不再只是 decompose）。
5. **依赖不阻塞完成**：Action 标完成**不做依赖校验**（依赖是 Planner 建议，不限制用户线性跳跃），允许跨未完成前置直接完成。
6. **状态模型收敛**：仅 `pending / completed` 互切（外加未来由 Planner 产生的 planned 只读「待安排」）；不引入 doing/blocked/skipped/abandoned。
7. **验收补充两条**：① 生成行动路线前后 `tasks` 计数不变、`actions` 增加（Step 2 最大价值）；② 删除 Goal 后 `actions` 与 `action_dependencies` 均归零（011 FK cascade 验证）。

---

## 0. 目标与验收

| # | 验收项 | 判定 |
|---|---|---|
| 1 | 旧「拆今日任务」按钮改名后仍走旧链路，任务照常进今日列表 | ✅ 不回归 |
| 2 | 「制定行动路线」按钮：生成 actions 后**只出现在 Goal 卡片内**，今日页无新内容 | ✅ 核心 |
| 3 | 卡片展示行动阶段进度：有 actions →「行动阶段 X/Y」（progress=Action 完成率）；无 actions 有旧 tasks → 退回任务模式 | ✅ D3 落地 |
| 4 | 行动阶段可「标记完成 / 撤销完成」：调 PATCH，状态 + completed_at 生效，不入 records/账本 | ✅ D5 落地 |
| 5 | 撤销刚生成的行动路线：5 分钟 undo 窗口，一次清理该批 actions（deps 级联） | ✅ |
| 6 | 刷新后行动路线仍在（GET /api/actions 回显）；删除目标连带前端状态清理 | ✅ |
| 7 | demo 模式（未登录）不出现行动入口 / 空态不破坏现有卡片 | ✅ |

**不做**（Step 2 边界）：「安排计划」按钮（Step 3 Planner 才做）、行动编辑/排序/删除单条（仅整批 undo）、独立目标详情页、schedule 相关一切。

---

## 1. 现状核对（file:line）

| 事实 | 位置 |
|---|---|
| 拆解按钮在 Goal 卡片 footer | page.tsx:1352（label「拆成行动」，onDecomposeGoal） |
| decomposeGoal：POST /decompose → setTasks 并入今日 | page.tsx:879-900（page.tsx:888 是关键切断点） |
| lastDecompose state（undo 锚点） | page.tsx:236 `{ ids, expireAt }` |
| undo 渲染为全局底部 bar | page.tsx:1153-1158（5 分钟窗口） |
| undoDecompose：DELETE /api/tasks/batch | page.tsx:903-920 |
| PlanGoal 前端类型 | page.tsx:102 `Goal & { taskCount, doneCount, startDate, endDate }` |
| mapApiGoal（/api/goals 响应 → PlanGoal） | page.tsx:783-796 |
| loadData 拉 goals + setGoals / refreshGoals | page.tsx:868-876 |
| 后端 GoalView / progress 派生自 tasks | lib/service/goals.ts:42-46 deriveView（countTasksByGoal） |
| Goal 卡进度 UI | page.tsx:1352 `goal-progress-row`（当前进度 X%）+ `goal-progress` bar + footer `taskCount 个任务 · doneCount 完成` |
| ActionView（2a 已产出） | lib/service/action-decompose.ts：`{id,goalId,title,description,estimatedMinutes,priority,status,completedAt,sortOrder,createdAt,dependsOnTitles}` |

---

## 2. 后端配合（小：repo/service 各 2-3 函数 + 3 个路由，不碰 2a 已交付核心）

> 现状缺口：2a 只做了「生成并落库」，还没有「读回 / 改状态 / 删整批」的入口；goals 派生视图还不会数 actions。

### 2.1 repo（lib/repo/planner.ts + lib/repo/goals.ts）

| 新函数 | 职责 | 说明 |
|---|---|---|
| `planner.listActionsByUser(userId)` | 当前用户全部行动 | 复用 ACTION_COLUMNS；供全量拉取（loadData 一次 GET 全部） |
| `planner.listDependenciesByUser(userId)` | 当前用户全部依赖 | 组装 dependsOnTitles 用（2a 已有 listDependenciesByGoal，补 user 级） |
| `planner.batchDeleteActions(userId, actionIds)` | 整批删 actions | 单条 `delete where user_id=$1 and id=any($2)`；011 FK 两个 on delete cascade 自动清两边依赖，无需手删（deleteAction 的手动清依赖是防御性冗余，可留可去） |
| `goals.countActionsByGoal(userId, goalId)` | {total, done} | 镜像 countTasksByGoal（repo/goals.ts:120），done = status='completed' |

### 2.2 service（lib/service/goals.ts + lib/service/action-decompose.ts）

| 改动 | 说明 |
|---|---|
| `goals.deriveView` 扩展 | 并行 count tasks + count actions → GoalView 增 `actionCount/actionDoneCount`；**progress 规则（D3 定稿）**：actionsTotal>0 → `round(done/total*100)`；否则原 tasks 派生；都无 → 0。taskCount/doneCount 字段保留（前端老 UI 兜底用） |
| `action-decompose.listActionViews(userId, goalId?)` | 组装函数抽公共（2a 的 generate 内联组装 → 提取 `buildViews(actions, deps)`）：listByUser + listDepsByUser → ActionView[]（带 dependsOnTitles） |
| `action-decompose.setActionStatus(userId, actionId, status)` | 白名单仅 `'completed' \| 'pending'`（planned 由 Step3 Planner 置，2c 拒绝 400）；getAction 归属校验 → updateAction（012 已支持 completed_at）→ 返回 ActionView |
| `action-decompose.removeActions(userId, actionIds)` | 归属 + 整批删 → 返回删除数 |

### 2.3 API 路由（app/api/actions/*）

```
GET    /api/actions?goalId=<可选>        → { actions: ActionView[] }     // 全量回显；goalId 过滤留给单目标刷新
PATCH  /api/actions/[id]  body {status}  → { action: ActionView }        // 标记完成/撤销（D5）
DELETE /api/actions       body {actionIds} → { removed: number }          // undo 整批撤销
```
（actions 是资源根；`/goals/:id/actions/generate` 保持 2a 形态不变。authenticate + ServiceError/AuthError 处理与既有路由一致。）

---

## 3. 前端改动点（app/page.tsx + app/globals.css，无新组件文件）

### 3.1 类型与 state

- `PlanGoal`（page.tsx:102）增 `actionCount?: number; actionDoneCount?: number;`
- `mapApiGoal`（783）映射 `actionCount/actionDoneCount`（g.actionCount ?? 0）
- 新增本地类型 `ActionRow`（对齐 ActionView 字段，page 内定义即可，沿用 Task 先例不进 demo-data）
- 新 state：
  - `actionsByGoal: Record<string, ActionRow[]>`（空对象起步）
  - `generatingGoalId: string | null`（行动路线按钮 loading，与 decomposingGoalId 并列互斥）
  - `lastDecompose` 类型扩为 `{ kind: "task" | "action"; ids: string[]; expireAt: number } | null`（page.tsx:236）

### 3.2 数据加载（loadData / 登录后）

- `loadData` 成功路径并行追加 `GET /api/actions`：把返回 `{ actions }` 按 `goalId` 分组写入 `actionsByGoal`（只覆盖，不依赖 goals 数组）。
- demo 模式（authMode 非 ready / 无 token）：不拉 actions，保持 `{}`，卡片自动走任务模式 → 无回归。

### 3.3 Goal 卡片双入口（page.tsx:1352 goal-footer）

| 按钮 | 动作 | 说明 |
|---|---|---|
| 旧「拆成行动」→ 改名「**拆今日任务**」 | 原 decomposeGoal | label 变化仅文案；语义/链路零改动 |
| 新增「**制定行动路线**」 | 新 `generateRoute(goalId)` | POST `/api/goals/:id/actions/generate` → 成功：`actionsByGoal[goalId]` 合并返回 actions（按 id 去重）→ `setLastDecompose({kind:"action", ids, expireAt:+5min})` → notify `已生成 N 个行动阶段` → refreshGoals()；重复生成（全部 skipped）→ notify「这次没有新增阶段（与已有阶段重复）」；busy 期两按钮都 disabled |

### 3.4 卡片进度与行动区（D3/D4）

- **进度行**：`goal.actionCount > 0` 时，`goal-progress-row` 文案显示「**行动阶段 X/Y 已完成**」（X=actionDoneCount, Y=actionCount），进度条 width 用 progress（Action 完成率，后端已算）；`actionCount === 0` 保持现状（footer 仍显示 `任务 N·M 完成`，老数据兜底）。
- **行动路线区块**（goal.actions.length > 0 才渲染，插在 goal-footer 之后）：
  ```
  行动路线
  [✓/○] 阶段标题            预计 Xh
         依赖：前置阶段（无则不显示）     [标记完成|撤销完成]
  ```
  - 状态徽标：pending 灰 / completed 划线勾（样式级），planned 显示「待安排」（Step3 后才会出现）
  - 时长换算：`estimatedMinutes >= 60 ? Xh(Ym) : Ym`
  - 操作按钮调 `toggleActionStatus(action)`：PATCH `/api/actions/:id` `{status: action.status==="completed" ? "pending" : "completed"}` → 本地替换该行（乐观更新 + 失败回滚 notify）；完成后不产生任何 toast 积分（D5 不入账）
- **删除目标连带清理**：现有 deleteGoal 成功回调里同时 `setActionsByGoal` 删掉该 key（防幽灵数据）

### 3.5 undo 适配（page.tsx:1153 undo-bar + 903 undoDecompose）

- bar 文案：`kind==="task"` →「已拆出 N 步行动」；`kind==="action"` →「已生成 N 个行动阶段」
- undoDecompose 分支：
  - task → 原 DELETE /api/tasks/batch + 今日列表移除（不动）
  - action → `DELETE /api/actions {actionIds}` → 从 `actionsByGoal` 所有分组移除这些 id → refreshGoals()；成功 notify「已撤销行动路线」

### 3.6 CSS（globals.css 追加 ~60 行）

`.goal-actions` / `.goal-action-row` / `.goal-action-status`（含 pending/completed/planned 三种态）/ `.goal-action-meta` / 时长与依赖徽标，视觉贴合现有 `.goal-card`（同色系 border/radius、小字号 muted），浅色完成态 `is-done`。

---

## 4. 决策点（建议默认，可改）

| # | 点 | 建议 |
|---|---|---|
| C1 | 拉取粒度 | `GET /api/actions` 一次拉全部（当前用户 actions 量级小）；goalId 过滤参数留作未来详情页用 |
| C2 | 行动区展开策略 | 有 actions 即渲染在卡片内（不折叠）；「生成成功后立即可见」优先于「默认收起减少视觉噪音」 |
| C3 | 状态白名单 | 手动仅 completed/pending 互切；planned 出现即显示「待安排」且禁点（Step3 才产生） |
| C4 | 生成重复提示 | 全部 skipped 时通知「这次没有新增阶段」，不报错（幂等友好） |

---

## 5. 开发顺序（本轮一次交付，含回归）

1. **2c-a 后端配合**：repo（listActionsByUser/listDepsByUser/batchDeleteActions/countActionsByGoal）→ service（deriveView 扩展 + buildViews 抽取 + listActionViews/setActionStatus/removeActions）→ 3 个路由 → typecheck/lint + 连库冒烟扩展（generate→list 回显一致、PATCH completed_at、DELETE 级联、跨用户 403/空）
2. **2c-b 前端**：类型/state/loadData → goal-footer 双按钮 + generateRoute → 进度行与行动区块 + toggleActionStatus → undo 分支 → deleteGoal 清理 → CSS
3. **2c-c 验证**：tsc/lint/build；dev server 手工回归清单（§0 表格逐项）；旧「拆今日任务」全链路点一遍

---

## 6. 一句话总结

Step 2c 是 2a 的「消费端」：给 Goal 卡片装上战略层的眼睛——**双入口按钮、行动阶段进度与状态切换、undo 撤批**；靠「前端只写 actionsByGoal 分组、旧 tasks state 一个都不碰」保证今日时间轴继续零污染。
