# Phase 4 记录查询完善 设计稿 v2（Record Query API + mood/remark）

> 范围：0.3.0 MVP · 记录查询完善（ROADMAP_0.3.0.md 阶段 4）
> 日期：2026-08-26（v2 修订于同日）
> 状态：**用户审核定稿 v2，可进入开发**
> 基线：ROADMAP_0.3.0.md 第 4 阶段；复用 Phase 2 的统计口径与上海时区约定

---

## 0. 目标与边界

当前记录只有写入（/api/agent）与全量列出（listRecords limit 100 经 /api/demo 注入），没有面向"回看"的查询能力。本阶段补齐：

```
records 表加 mood(枚举)/remark 列（migration 008）
  → 3 个查询接口：today / history / recent?days=7
  → PATCH /api/records/[id]（mood/remark 回写）
  → 前端：新 records 入口 + history 分页 + mood/remark 展示 + emoji 快捷标记
  → 旧 dashboard 数据源零改动（不迁移 /api/demo）
completion_rate 双指标：旧口径保留（Phase 2 零波及）+ 新增 weekly 指标
```

### v1 → v2 变更要点（用户审核定稿）

| # | v1 | v2 | 依据 |
|---|---|---|---|
| 1 | mood 自由文本/emoji，DB `text` 无约束 | mood **枚举值** `great/good/normal/bad/terrible`，DB `varchar(20)` + **CHECK 约束** | 数据干净，Phase 5 可统计；与 tasks.status/records.kind 约束风格一致 |
| 2 | `GET /api/records/week` | `GET /api/records/recent?days=7`（默认 7，可扩展 ?days=30） | recent 天然滚动窗口语义，无自然周歧义，未来支持月度回顾 |
| 3 | history 有 kind 筛选参数 | **删除 kind 筛选参数**，但返回字段保留 kind/intent/evidence | MVP 控制接口面；kind 过滤属分析维度留 Phase 5 |
| 4 | ready 模式数据源迁移到 history 分页 | **不迁移**，旧 dashboard 零改动；新增独立 records 入口消费查询能力 | 收敛回归面，Phase 4 目标=建立查询能力而非重构前端数据流 |
| 5 | completion_rate 改新口径 | **旧口径不动**（Phase 2 零波及）+ **新增 weeklyCompletionRate** | 避免 agent 历史上下文 prompt 行为变化，Phase 5 再统一 |
| 6 | PATCH 前端范围模糊 | 明确只做**记录卡片 emoji 快捷标记**，不做编辑弹窗/备注管理页 | 闭环"生成→反馈→沉淀"，限定最小交互 |

---

## 1. Migration 008：records 加 mood(枚举)/remark

`supabase/migrations/008_records_mood_remark.sql`

```sql
-- =============================================================
-- 008：记录查询完善 —— records 加心情(枚举)/备注
-- =============================================================
-- 设计（DESIGN_PHASE4_RECORDS.md v2，用户审核定稿 2026-08-26）：
--   1. mood 用枚举值（非 emoji/自由文本），与 tasks.status、records.kind 的
--      CHECK 约束风格一致；Phase 5 周报可直接按枚举统计
--   2. 枚举值英文，前端映射 emoji（moodMapper 常量），与 status/kind 英文风格一致
--   3. 无新索引：查询走 user_id + 上海时区日期表达式，个人量级（百条级），
--      既有 idx_records_user_created（user_id, created_at desc）已覆盖前缀
-- =============================================================
alter table public.records
  add column mood   varchar(20)
    check (mood in ('great', 'good', 'normal', 'bad', 'terrible')),
  add column remark text;   -- 备注：自由文本，可空；长度上限在应用层限 500
```

类型（lib/repo/types.ts）：
```ts
export type Mood = 'great' | 'good' | 'normal' | 'bad' | 'terrible';
export type DbRecord = {
  /* ...既有字段... */
  mood: Mood | null;
  remark: string | null;
};
```

---

## 2. API 概览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/records/today | 今日记录 + 今日任务完成统计 |
| GET | /api/records/history | 历史记录分页 + 筛选（**无 kind**，时间/mood） |
| GET | /api/records/recent?days=7 | 近 N 天滚动窗口（含今天）+ 汇总 |
| PATCH | /api/records/[id] | 回写 mood/remark（白名单锁死） |

全部走 `authenticate(request)`（JWT），所有查询 `user_id` 显式携带；按 id 操作一律 `id + user_id` 双条件（跨用户 404）。

### 统一记录形状 RecordItem（API 返回 camelCase，前端直用）
```json
{
  "id": "uuid", "text": "学了变量与循环", "topic": "Python 基础",
  "kind": "learn", "minutes": 25, "output": null,
  "mood": "good", "remark": "状态不错，明天继续",
  "intent": "quick_log", "evidence": "输入 + 输出", "xp": 3, "coin": 1, "mode": "llm",
  "occurredAt": "2026-08-26T03:00:00.000Z", "createdAt": "2026-08-26T03:00:00.000Z"
}
```
> kind/intent/evidence 是 records 表既有字段（001_init），随行返回供前端展示，不作为查询参数。

---

## 3. GET /api/records/today

### 响应 200
```json
{
  "items": [RecordItem...],   // 今日记录（Asia/Shanghai 今天，occurred_at asc）
  "tasksDone": 3,             // 今日完成任务数（completed_at 落在今天）
  "tasksTotal": 8,            // 当前任务总数（与 Phase 2 todayTotal 同口径）
  "completionRate": 38        // 派生：round(tasksDone / max(1, tasksTotal) * 100)，不落库
}
```

### 错误
| 状态 | 场景 |
|---|---|
| 401 | 未认证 |

口径说明：`completionRate` 是**今日完成率**，沿用 Phase 2 既有口径（今日完成数 / 全部任务数），本阶段不动。今日口径的 all-time 分母失真影响有限（今日完成数本身小），且改它会牵动 Phase 2 agent context。

---

## 4. GET /api/records/history

### 请求（全部可选）
```
GET /api/records/history?from=2026-08-01&to=2026-08-26&mood=good&limit=50&offset=0
```
| 参数 | 规则 |
|---|---|
| from / to | YYYY-MM-DD（Asia/Shanghai 口径）；两者都给时 from <= to |
| mood | 枚举值 `great/good/normal/bad/terrible`，空 = 不限 |
| limit | 1–200，默认 50 |
| offset | >= 0，默认 0 |

> **无 kind 参数**（v1→v2 删除）：records 虽有 kind 字段（001_init），但 kind 过滤属分析维度，留 Phase 5 周报。返回行仍带 kind/intent/evidence。

### 响应 200
```json
{
  "items": [RecordItem...],   // occurred_at desc，id desc（稳定分页）
  "total": 137,               // 匹配总数（count(*) over()，与分页同一条 SQL）
  "hasMore": true,
  "offset": 50
}
```

### 错误
| 状态 | 场景 |
|---|---|
| 400 | from/to 格式非法、from > to、limit > 200、mood 不在枚举内 |
| 401 | 未认证 |

---

## 5. GET /api/records/recent?days=7

近 N 天**滚动窗口**（含今天，今天在前），非自然周——用户随时打开都有意义。`days` 默认 7，可传 30 支持月度回顾（Phase 5 复用）。

### 请求
```
GET /api/records/recent          // 默认 days=7
GET /api/records/recent?days=30  // 月度窗口
```
| 参数 | 规则 |
|---|---|
| days | 1–90，默认 7 |

### 响应 200
```json
{
  "days": [
    {
      "date": "2026-08-26", "label": "今天",
      "records": [RecordItem...],   // 当日记录（occurred_at asc）
      "tasksDone": 2,               // 当日完成任务数
      "minutes": 45                 // 当日投入分钟（minutes 求和，无记录为 0）
    },
    { "date": "2026-08-25", "label": "昨天", "records": [], "tasksDone": 1, "minutes": 0 }
  ],
  "doneTasks7d": 12,              // sum(days.tasksDone)，raw 计数（与 Phase 2 countDoneTasksSince 同口径）
  "weeklyCompletionRate": 60,     // 【新口径派生】round(windowDone / max(1, windowScoped) * 100)，不落库
  "activeDays": 5,                // 有记录的天数（records.length > 0）
  "totalMinutes7d": 320
}
```
label 服务端计算（今天/昨天/周一…周日），避免前端时区/语言差异。

> **不再返回 completionRate7d（旧口径）**：避免一个接口里两个完成率混淆。Phase 2 agent context 的 completionRate7d 由它自己调 stats.ts 独立计算，**完全不受本接口影响**。

### 实现要点（查询次数收敛）
- 新增 repo `listRecordsBetween(userId, from, to)` 一次查 N 天记录（SQL 里 `(occurred_at at time zone 'Asia/Shanghai')::date::text as shanghai_day`，Service 层按日分组），替代 N 次 `listRecordsOnDay`；
- 新增 repo `countDoneTasksPerDay(userId, since)` 一次聚合每日完成任务数，替代 N 次 `countDoneTasksOnDay`；
- `dailyMinutesSince(userId, since)` 一次拿 N 天分钟；
- `countWindowScopedTasks` / `countWindowScopedDoneTasks` 一次拿新口径分母/分子（§7）。
共 4 次查询（days 数不增查询次数）。

---

## 6. PATCH /api/records/[id]（mood/remark 回写）

mood/remark 没有写入路径就是死字段。记录由 /api/agent 自然语言创建（Agent 提取 topic/text/kind/minutes，mood 提取不稳定、MVP 不做），所以心情采用**记录卡片上 emoji 快捷标记**（§11.3），老记录也能补标。

### 请求
```json
{ "mood": "good" }              // 只改 mood（枚举值）
{ "remark": "备注内容" }         // 只改 remark
{ "mood": null }                // 清除 mood（remark 同理）
```
- mood 必须是枚举值之一或 null；remark <= 500 字符；body 至少提供其一。
- **白名单锁死**：body 出现 mood/remark 以外的任何字段（topic/text/kind/minutes/output/intent/evidence/xp/coin/mode/occurred_at 等）一律忽略，不更新——Repo 层显式只 SET mood/remark。

### 响应 200：更新后的 RecordItem；错误：400（mood 非枚举/remark 超长/空 body）、404（不存在/跨用户）、401。

### Repo 实现
按请求中实际提供的 key 动态拼 SET（列名白名单固定，值参数化，无注入风险）；`coalesce` 无法区分"显式置 null"与"未提供"，故必须动态拼。

---

## 7. completion_rate 双指标口径（核心：旧不动 + 新增）

| 指标 | 公式 | 口径 | 用途 | Phase 2 影响 |
|---|---|---|---|---|
| 今日完成率（today 接口 `completionRate`） | `round(tasksDoneToday / max(1, countTasks_all) * 100)` | 旧（all-time 分母） | today 接口展示 | 无（保持既有） |
| 7天完成率（Phase 2 context `completionRate7d`） | `round(countDoneTasksSince(7d) / max(1, countTasks_all) * 100)` | 旧（all-time 分母） | agent 上下文 | **不动**（零波及） |
| **weekly 任务完成率（recent 接口 `weeklyCompletionRate`）** | `round(windowDone / max(1, windowScoped) * 100)` | **新（窗口内分母）** | recent 接口展示 | 无（新指标，Phase 2 不读） |

### 新口径定义（weeklyCompletionRate）
- **分母 windowScoped**：近 N 天**创建或截止**的任务数（去重，OR 谓词按行计数天然不重复）
  ```sql
  select count(*) from public.tasks
  where user_id = $1
    and (
      (created_at at time zone 'Asia/Shanghai')::date >= $2
      or (deadline is not null and deadline >= $2::date)
    )
  ```
  > tasks 既有 `created_at`（001）与 `deadline date`（004 加，可空），无需新字段。
- **分子 windowDone**：上述集合中 `status = 'done'` 的任务数（不限 completed_at 时间，语义"最近一周计划的任务落实了多少"）
  ```sql
  select count(*) from public.tasks
  where user_id = $1
    and status = 'done'
    and (
      (created_at at time zone 'Asia/Shanghai')::date >= $2
      or (deadline is not null and deadline >= $2::date)
    )
  ```
- 比率恒 ∈ [0,1]，**不随总任务数膨胀**，根治 all-time 分母失真。

### 为什么不直接替换旧口径
旧 `completionRate7d` 已被 Phase 2 Agent Context 使用（注入 agent prompt）。替换会改变 agent 历史上下文，可能导致 prompt 行为变化、无法比较前后效果。MVP 阶段不无理由改变已有指标，**Phase 5 周报再统一**（届时 agent context 一并迁移到新口径）。

---

## 8. Service 层（lib/service/records.ts，新文件）

```ts
listTodayRecords(userId)              → { items, tasksDone, tasksTotal, completionRate }
listHistoryRecords(userId, q)         → { items, total, hasMore, offset }   // q 校验在 Service（§4 错误表）
listRecentRecords(userId, days)       → { days[], doneTasks7d, weeklyCompletionRate, activeDays, totalMinutes7d }
patchRecord(userId, recordId, patch)  → RecordItem                        // 404 走 ServiceError
```
- 校验全部收在 Service（400 由 ServiceError 抛出），Repo 不做业务校验；
- 复用 lib/repo/stats.ts 既有函数（countTasks / countDoneTasksOnDay / dailyMinutesSince / countDoneTasksSince），新增 countDoneTasksPerDay / countWindowScopedTasks / countWindowScopedDoneTasks 放 stats.ts；
- 多用户隔离：所有函数显式 userId，patch 用 id + user_id 双条件。

---

## 9. Repo 层（lib/repo/records.ts 扩展）

新增：
```ts
listRecordsOnDay(userId, day)             // 今日/单日记录（与 evening.listRecordsByDate 同逻辑，放 records.ts；evening.ts 保留不动）
listRecordsBetween(userId, from, to)      // N 天窗口一次查，行带 shanghai_day 分组键
queryRecords(userId, { from, to, mood, limit, offset })
  → { rows: (DbRecord & { total: string })[] }   // 单条 SQL：count(*) over() as total；无 kind 参数
patchRecordFields(userId, id, patch)      // 动态 SET（mood/remark 白名单）
```
核心 SQL（queryRecords，参数化，**无 kind 条件**）：
```sql
select r.*, count(*) over()::text as total
from public.records r
where r.user_id = $1
  and (r.occurred_at at time zone 'Asia/Shanghai')::date >= coalesce($2::date, '1970-01-01')
  and (r.occurred_at at time zone 'Asia/Shanghai')::date <= coalesce($3::date, '9999-12-31')
  and (r.mood = $4 or $4 is null)
order by r.occurred_at desc, r.id desc
limit $5 offset $6
```
stats.ts 新增：
```ts
countDoneTasksPerDay(userId, sinceDate)          // → [{ day, count }]，一次聚合替代 N 次 countDoneTasksOnDay
countWindowScopedTasks(userId, sinceDate)        // → 新口径分母（创建或截止落窗）
countWindowScopedDoneTasks(userId, sinceDate)    // → 新口径分子（上述中 status='done'）
```

---

## 10. mood 枚举定义（DB CHECK + 前端映射）

### DB 枚举值（英文，与 status/kind 风格一致）
```text
great / good / normal / bad / terrible
```
DB 层 CHECK 约束兜底（§1），应用层 Service 也校验非法值（400）。扩展枚举需 `alter table ... drop constraint, add constraint`（一次性成本，与 tasks.status 扩展同流程）。

### 前端映射常量（lib/mood-mapper.ts 或 app 内常量）
```ts
export const MOOD_OPTIONS = [
  { value: 'great',    emoji: '😄', label: '很好' },
  { value: 'good',     emoji: '🙂', label: '不错' },
  { value: 'normal',   emoji: '😐', label: '一般' },
  { value: 'bad',      emoji: '😞', label: '不好' },
  { value: 'terrible', emoji: '😣', label: '很差' },
] as const;
```

### Phase 5 预留
周报按枚举直接统计（great/good 归积极，normal 归中性，bad/terrible 归消极），无需文本归类。本轮不实现分析，只保证字段可存可取。

---

## 11. 前端（新 records 入口，旧 dashboard 零改动）

### 11.1 范围原则
- **旧 dashboard（app/page.tsx RECENT ACTIVITY 面板）零改动**：继续走 /api/demo 全量注入，不迁移到 history 分页（v1→v2 收敛，规避最大回归面）。
- 新增**独立 records 入口**消费 Phase 4 查询能力。入口形式实现时定（独立路由页 app/records/page.tsx 或 dashboard 内"查看全部记录"抽屉），倾向独立路由页（URL 可分享、不污染首页）。

### 11.2 记录卡片渲染（新入口内）
- RecordItem 类型加 `mood?: Mood; remark?: string`；
- mood 非空 → 在 topic 前显示对应 emoji（弱色圆形底，查 MOOD_OPTIONS 映射）；
- remark 非空 → 卡片第二行弱色斜体文本（截断 2 行）；
- 卡片同时展示既有元数据 kind/intent/evidence（轻量标签）。

### 11.3 心情快捷标记（PATCH 消费端，限定最小交互）
- 记录卡片显示 5 个 emoji 快捷按钮（MOOD_OPTIONS）；
- 点击 → `PATCH /api/records/[id] { mood }` → 乐观更新卡片；
- 再点相同 emoji → `{ mood: null }` 清除；
- toast「已标记心情」。
- **不做**：编辑弹窗、备注管理页面、复杂交互。
- remark 的编辑入口：卡片上「添加备注」小按钮 → 行内 input → PATCH remark（最小实现，可后续轮次）。

### 11.4 历史分页 + 近 N 天视图（新入口内）
- 默认视图：`GET /api/records/recent?days=7` → 7 行（label + 记录数 + 完成条 + minutes），点击行展开当日记录列表（复用记录卡片，可标记心情）。
- 「历史」切换：`GET /api/records/history?limit=50` → 列表 + 底部「加载更多」（offset += 50，hasMore=false 隐藏）。
- 空数据显示「还没有记录」。
- demo 模式隐藏新入口（原型无真实 id，不做 PATCH）。

---

## 12. 验收测试（scripts/e2e-records.sh，新脚本）

| 用例 | 断言 |
|---|---|
| 今日记录 | 造 3 条今日 + 2 条昨日记录 → GET /today 只含今日 3 条、occurred_at asc；tasksDone/completionRate 数值正确且 0<=rate<=100 |
| 分页 | 造 12 条 → limit=5 分 3 页；total=12、hasMore 正确、offset 递增；无重叠 |
| 筛选 | mood=good 只返回该 mood；from/to 过滤生效（上海时区边界）；**无 kind 参数**（传 kind 应被忽略或 400，实现时定） |
| 非法参数 | from=abc → 400；from>to → 400；limit=500 → 400；mood=happy（非枚举）→ 400 |
| recent | 返回 7 天含今天、今天在最前；label 今天/昨天正确；无记录的天 records=[] 且仍返回；doneTasks7d=sum(days)、activeDays=有记录天数；days=30 返回 30 行 |
| weeklyCompletionRate | 造窗口内创建/截止任务 + 部分完成 → 分子/分母/比率正确；比率∈[0,100]；不随历史任务数膨胀 |
| mood/remark 回写 | PATCH mood=good → GET /today 可见；PATCH remark → 可见；PATCH mood=null → 清除；空 body → 400；mood=非枚举 → 400；body 含 topic 字段 → 被忽略、不改 topic |
| 越权 | 用户 B PATCH 用户 A 的记录 → 404；用户 B 的 history/recent 查不到 A 的记录 |
| 回归 | e2e-goals / e2e-evening / idempotency / e2e-closed-loop / e2e-decompose + typecheck / lint / build；**Phase 2 agent context 不受影响**（completionRate7d 口径不变，抽检 context 输出） |

---

## 13. 改动文件清单

新增：
```
supabase/migrations/008_records_mood_remark.sql
lib/service/records.ts                    （4 个 Service 函数 + 校验）
lib/mood-mapper.ts                       （MOOD_OPTIONS 枚举映射）
app/api/records/today/route.ts
app/api/records/history/route.ts
app/api/records/recent/route.ts           （替代 v1 的 week/route.ts）
app/api/records/[id]/route.ts             （PATCH mood/remark）
app/records/page.tsx                      （新 records 入口，独立路由页）
scripts/e2e-records.sh
```

修改：
```
lib/repo/types.ts        （DbRecord 加 mood: Mood|null / remark；新增 Mood 类型）
lib/repo/records.ts      （listRecordsOnDay / listRecordsBetween / queryRecords / patchRecordFields）
lib/repo/stats.ts        （countDoneTasksPerDay / countWindowScopedTasks / countWindowScopedDoneTasks）
lib/demo-data.ts         （LearningLog 类型加 mood/remark，供 mapRecordToLearningLog 透传）
app/globals.css          （mood/remark/记录卡片/快捷标记/近N天视图样式）
README.md                （API 速查补 records 4 接口）
```

> **不改**：app/page.tsx（旧 dashboard 零改动）、lib/service/context.ts（Phase 2 agent context 不动）、lib/repo/evening.ts。

---

## 14. 风险与边界

- **completion_rate 双指标并存**：近期 today 用旧口径、recent 用新口径，两套数字可能让用户困惑。文档与 UI 文案区分（today 标"今日完成率"、recent 标"本周任务完成率"）。Phase 5 统一。**Phase 2 agent context 零波及**（核心风险规避）。
- **新 records 入口**是新增页，不动旧 dashboard，回归面小；但需确认路由与首页导航衔接（首页加"记录"入口跳转）。
- **PATCH 消费端限定**：只做 emoji 快捷标记 + 最小 remark 行内编辑，不做编辑弹窗/备注管理页——避免范围蔓延。
- **mood 枚举**：CHECK 约束兜底 + Service 校验，数据干净；扩展枚举需 DROP/ADD CONSTRAINT（与 tasks.status 同流程）。
- **recent 滚动窗口**：周一打开与周日打开内容不同是预期行为（非自然周）；命名 recent 已表达语义。
- **查询次数**：today=3 次（records/tasksDone/countTasks）、history=1 次、recent=4 次（records-perday/done-perday/minutes/window-scoped），个人量级无性能顾虑，days 数不增查询次数。
- **老记录**：mood/remark 为 null → 前端不显示、可补标，无迁移成本。
