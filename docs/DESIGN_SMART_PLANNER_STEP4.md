# DESIGN_SMART_PLANNER_STEP4 — 今日时间轴迁移到 schedules（时间语义层）

> 上游：`docs/DESIGN_SMART_PLANNER_V1.md`（冻结）§2.6 / §5 Step 4；`docs/DESIGN_SMART_PLANNER_STEP3.md`（冻结）
> 依赖：Step 1（schedules/user_availability 表 + repo）✅ · Step 2a/2c（行动路线）✅ · Step 3（Planner accept/reset 已能写 schedules + fixed 语义）✅
> 日期：2026-09-05
> 状态：**待用户审核**（审核通过后开发）
> 定位：**Step 4 不是「任务列表换接口」，而是给整个应用建立「时间语义层」**——执行视图只回答「今天真正安排了什么」，不再回答「数据库里还有什么没完成」。

---

## §1 目标态一句话

> 今日执行视图（首页「今天要做的事」+ 计划地图「今日时间轴」）的唯一数据源变为 **`GET /api/schedules/today`**：返回当日 action/manual 排程 + 固定时间块，按时间排序。**旧 tasks 不删、不迁移、不进时间轴**，只作历史/统计/晚报/兜底存在。

## §2 现状与根因

| 项 | 现状 | 问题 |
|---|---|---|
| 「今日时间轴」面板（`page.tsx:1683`，计划地图页 plan-layout） | 平铺**全量 tasks**（`Task[]`，来自 `/api/dashboard.todayTasks`，tasks 无日期语义） | 昨天未完成任务今天仍出现；task 是「待办」不是「日程」 |
| 首页「今天要做的事」agenda（`TodayHome`，`tasks.slice(0,4)`） | 同样吃 tasks | 同上 |
| schedules 表 | 已有数据（Step 3 accept 写入），repo 有 `listSchedulesByDate`/`updateScheduleStatus`/`createSchedules` | **无任何 API/前端消费**——accept 完的排程用户看不到 |
| user_availability | 周模板；`title=''`=可排空档 / `title≠''`=固定块 | fixed 块只在设置卡可见，不进时间轴 |

## §3 目标数据模型：TimelineItem（统一结构，后端聚合，前端零拼接）

```ts
// GET /api/schedules/today 返回 { date: string, items: TimelineItem[] }
type TimelineItemType = "action" | "manual" | "fixed";
type TimelineItem = {
  key: string;            // 前端稳定 key：schedule 用 `s:{id}`，fixed 用 `f:{id}`
  type: TimelineItemType;
  title: string;
  startTime: string;      // HH:MM
  endTime: string;        // HH:MM
  status: "planned" | "completed"; // fixed 恒为 "planned"（只读）
  scheduleId?: string;    // action/manual 有，fixed 无
  actionId?: string | null;
  goalId?: string | null;
  source?: "action" | "manual";
};
```

### 三条来源与各自规则

| type | 来源 | 进入条件 | 交互 |
|---|---|---|---|
| action | `schedules.source='action'`，`date=today` | accept 后排程落今天 | 可完成/撤销（PATCH）；**完成不推进 action.status**（Step3 验收 E 已锁） |
| manual | `schedules.source='manual'`，`date=today` | 用户在时间轴「+ 手动安排」创建 | 可完成/撤销/删除 |
| fixed | `user_availability`，`weekday=today` | **仅 `title≠''` 行实例化到今天**（`title=''` 是可排空档，不展示） | 纯展示，无按钮 |

排序：`startTime asc`，同刻按 `created_at asc`。**已完成的今天日程仍显示**（灰显勾选态）——时间轴回答"今天安排了什么 + 做了什么"，不随完成消失。

## §4 后端设计

### 4.1 repo（`lib/repo/planner.ts` 增 1 个）
- `deleteSchedule(userId, scheduleId): Promise<number>` —— 直接删。manual-only 限制在 service。

已有且够用：`listSchedulesByDate`（date=today，按 start_time 排序）、`updateScheduleStatus`（completed 记 coalesce 首完成时间、回退清空）、`listAvailability`（按 weekday 排序）、`createSchedules`。

### 4.2 service（新文件 `lib/service/timeline.ts`）
- `buildTodayTimeline(userId): Promise<{ date: string; items: TimelineItem[] }>`
  1. `listSchedulesByDate(userId, today)` → action/manual 两型（map 加 `key:s:{id}`）
  2. `listAvailability(userId)` → 过滤 `title≠''` 且 `weekday === dateToDbWeekday(today)` → 实例化为 fixed（`key:f:{id}`，date=today，status='planned'）
  3. 合并 → `startTime` 排序 → 返回
- `setTimelineStatus(userId, scheduleId, status: "planned" | "completed")`：校验存在（404）、非本人 404；包 `updateScheduleStatus`。**白名单只有 planned/completed**（doing/overdue 本期不在时间轴暴露）
- `createManualSchedule(userId, input: { title; startTime; endTime })`：校验 title 1-200、`HH:MM`、`end > start`；`createSchedules(userId, [{ source:'manual', date: today, ... }])`（action_id/goal_id 为 null）
- `deleteManualSchedule(userId, scheduleId)`：读行 → `source==='manual'` 才删，否则 409（**action 排程单条不可删**——要撤请用「撤销安排」，保护 planned 状态机）

### 4.3 API
| route | 方法 | 说明 |
|---|---|---|
| `/api/schedules/today` | GET | `buildTodayTimeline` 聚合（用户 §六：不让前端拼） |
| `/api/schedules` | POST | 手动添加（body `{title,startTime,endTime}` → manual） |
| `/api/schedules/[id]` | PATCH | `{status:'planned'\|'completed'}`（时间轴勾选完成/撤销） |
| `/api/schedules/[id]` | DELETE | 仅 manual（action 排程 409） |

注意 Next.js 路由：`today/` 是静态段，优先于 `[id]/` 动态段，可并存。

## §5 前端设计（page.tsx + globals.css，无新路由组件）

### 5.1 state 与数据流（**唯一来源**）
- 新 state：`timeline: TimelineItem[]`、`timelineLoading`
- `loadTodayTimeline()`：ready 模式下 `GET /api/schedules/today`；在「登录/register 成功后」「切到今日/计划 tab 时（懒刷新）」以及完成/添加/删除操作成功后调用
- **Goal 卡不存任何 schedule 状态**（封版检查 1 已确认：唯一 Schedule 来源是今天这个接口，Planner 相关状态只活在弹层会话里，accept/reset 后一律 `refreshGoals()` + `loadTodayTimeline()`）

### 5.2 渲染：抽 `TimelinePanel` 组件（两处复用）
1. **首页「今天要做的事」agenda**：`tasks.slice(0,4)` → timeline 未完成/接下来优先取前 4
2. **计划地图 plan-layout「今日时间轴」面板**（`page.tsx:1683`）：`tasks.map` → `timelineItems.map`；`count-badge` = 可操作项里 completed 数

item 结构（复用 schedule-card 骨架）：
```
HH:MM–HH:MM   [AI安排/手动/固定时间]  标题
action/manual：右侧完成圆钮（PATCH）· manual 追加小删除钮
fixed：无按钮
```

**降级分支（关键，保旧用户与 demo）**：`timeline` 为空且存在未完成旧 tasks 时 → 时间轴渲染旧 tasks 视图（原 schedule-card + `onToggleTask`，保留"完成即入账"），顶部提示「还没有排程，先显示待办任务」。demo 模式（无后端）恒走降级。**渐进迁移：老用户一 accept 计划，时间轴立即被 schedules 接管，旧 tasks 自动退到折叠池（见 P4）。**

### 5.3 handlers
- `toggleTimelineItem(item)`：action/manual → `PATCH /api/schedules/{id}`；乐观更新（失败回滚 + notify）
- `addManualSchedule(title,start,end)`：`POST /api/schedules` → 成功入列 + notify
- `removeManualSchedule(id)`：confirm → `DELETE` → 出列
- demo 分支沿用现有 toggleTask 路径

### 5.4 样式
追加 ~60 行贴合现有 schedule-card 的 variant（fixed 底色、AI badge、无 reward 行）。

## §6 完成逻辑冻结（Step 4 最大风险点）

| 规则 | 实现 |
|---|---|
| 完成一个 schedule 时段 | `updateScheduleStatus('completed')`，只记 `completed_at`（首次完成时间 coalesce） |
| **不自动推进 action** | Step 3 验收 E 已在 repo/service 层面锁死（schedule 完成对 action.status 零影响），本期时间轴 PATCH 走同一 `updateScheduleStatus`，天然延续 |
| **不自动入账**（P2 默认） | schedule 无 xp/coin 字段；90 分钟执行切片 ≠ 目标完成奖励。奖励语义保留给「记一笔」records 链路（现状已如此，本期不新增任何 schedule→ledger 代码） |
| 撤销完成 | 同 PATCH → `planned`，清空 `completed_at` |
| 昨天未完成（overdue） | **不显示**（`listSchedulesByDate` 只查 date=today，天然过滤）——验收 A 硬保证；overdue 生命周期留给 Step 5 |

## §7 旧 tasks 处理（不删不迁）

- tasks 表、`/api/tasks` 全链路、toggle 完成入账逻辑**零改动**（历史 records/账本/晚报引用不动）
- tasks 只作三处存在：① goals 进度兜底（无 action 时 progress 退 tasks，2c 已实现）；② 晚报/周报/chat context/stats 双窗口（全读 tasks+records，本次**不碰**）；③ 前端「待办折叠池」（P4）
- 不再有新的 tasks 写入入口？→ **「拆今日任务」按钮保留写 tasks**（战术层链路零改），产物在折叠池可见可完成（仍入账）

## §8 决策点（P1–P5，均给默认，可改）

| # | 点 | 默认（推荐） | 理由 |
|---|---|---|---|
| P1 | 执行视图覆盖范围 | 首页 agenda + 计划页时间轴**同步切**到 timeline；空则降级 tasks | 一步立起时间语义层；降级保证旧用户/demo 不空屏 |
| P2 | schedule 完成是否奖励 | **不入账、不显示 +xp**；奖励走「记一笔」 | schedule 是执行切片非目标完成；避免"切片=奖励"扭曲；账本红线零新增 |
| P3 | manual 创建形态 | 时间轴顶部「+ 手动安排」：标题 + 起止时间（必填，time input）；仅 manual 可删 | 表约束 `end>start NOT NULL`；手动事项是"承诺的执行计划" |
| P4 | 「拆今日任务」产物（旧 tasks）的呈现 | 保留按钮写 tasks；时间轴有 schedule 时 tasks 收进**折叠池**「N 个待办旧任务（可展开勾选，仍入账）」；无 schedule 时走降级视图 | 战术层旧链路不破坏，又不再占据执行主视图 |
| P5 | 昨日未完成提示 | **不做**（验收 A 严格：昨天 planned 今天不出现在 timeline） | overdue 生命周期 + 提示语留给 Step 5 统一设计 |

## §9 验收清单（含用户 A–E）

| # | 验收 | 断言点 |
|---|---|---|
| A | 昨天任务不出现 | 造 `date=yesterday status=planned` schedule → GET /today 不含它 |
| B | action schedule 显示 | accept 计划（含今天日期 item）→ GET /today 出现该 action item |
| C | manual 不受影响 | 建 manual → 显示；`plan/reset` 后 manual 仍在（回归 Step3 已锁）；DELETE manual 才移除 |
| D | fixed 展示规则 | `title=''` 空档不显示；`title='健身'`（今天 weekday）显示为 fixed |
| E | 完成隔离 | PATCH schedule completed → `getAction` 断言 action 仍 pending/planned（不是 completed） |
| F | 完成/撤销往返 | PATCH completed → 灰显勾选；再 PATCH planned → 恢复；刷新一致；completed_at 首完成保留 |
| G | 排序与已完成展示 | 按 start_time asc；今天已完成仍显示（不消失） |
| H | 零回归 | 晚报/周报/chat context/账本用例全过（数据源未动）；旧 tasks toggle 完成入账不受影响 |
| I | 空态降级 | 无 schedule 用户 + 有旧 tasks → 时间轴降级显示 tasks 不白屏；全新空用户 → 引导「先制定行动路线/安排计划」 |

## §10 开发顺序

```
Step4a 后端    repo.deleteSchedule + service/timeline.ts + GET/POST/PATCH/DELETE 路由
              → tsx 连库冒烟（scripts/timeline-smoke.ts）：A–E + F 断言 + manual 删除 409 保护
Step4b 前端    TimelinePanel（抽组件）→ 首页 agenda + 计划页时间轴切源 → 手动添加/删除
              → demo/空态降级 → tsc/lint/build
Step4c 回归    HTTP e2e（真实 LLM accept → today 断言）；旧链路回归（晚报/周报/chat/账本）；记忆
```

## §11 已知差异（记录，不处理）

- 晚报/周报/chat context 仍只见 tasks+records，**看不到 schedule 执行情况**——计划地图/今日执行与"AI 回顾"出现双轨视角，Step 5 统一校准。
- stats 双窗口（7/30 天 feasibility）基于 records 实际投入，schedule 完成不计入 minutes——与上面同源，Step 5 一并设计「schedule 完成 → 执行记录」映射。
