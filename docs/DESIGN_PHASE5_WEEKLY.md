# Phase 5 周成长报告 设计稿 v2（Weekly Report + AI 总结 + 目标建议确认）

> 范围：0.3.0 MVP · 周成长报告（ROADMAP_0.3.0.md 阶段 5）
> 日期：2026-08-26
> 状态：**已审核定稿（v2）**——用户逐项审核 + 反驳调整后落定
> 基线：ROADMAP_0.3.0.md 第 5 阶段；复用 Phase 2-4 的 Agent Context / 晚报生成链路 / 统计口径 / 上海时区约定
> 红线：**修改长期目标必须用户确认**（PRODUCT_DESIGN_V1 §7.2）——周报只给建议，采纳动作由用户显式触发

---

## 0. 目标与边界

闭环已覆盖"目标→任务→记录→Agent→晚报"，缺**周维度成长总结**：用户看不到"这周做得怎么样、下周调什么"。本阶段补齐：

```
weekly_reports 表（migration 009，含 RLS）
  → 规则引擎算周统计 stats（数值不进 LLM 输出，防幻觉）
  → LLM 生成 AI 总结（summary/achievement/problem/suggestion）
  → LLM 生成目标调整建议 goalSuggestions（只建议、不执行、仅 update_title）
  → 前端周报页展示 + 用户"采纳"→ 复用 PUT /api/goals/[id]（显式确认）
  → 懒触发（无系统调度，不加每日/每周心跳）
```

### 明确不做（MVP 边界）
- ❌ 不建目标历史快照表（goal progress 是 legacy cache，目标推进用本周窗口完成数 + 当前派生进度表达）
- ❌ 不做"一键全采纳"批量改目标（§7.2 要求逐个确认）
- ❌ **不加 `POST /weekly/generate` 系统模式 API**（现状无云函数/定时任务/worker，提前开是维护未来接口；生成能力仅留在 service 层 `generateWeeklyReport()`，等 Phase 6/7 真有调度再开 `/internal/weekly/generate`）
- ❌ 不改 scheduler 心跳
- ❌ goalSuggestions 第一版**只支持 `update_title`，暂不开放 `archive`**（归档是破坏性动作，误点即丢）
- ❌ 不接微信推送

---

## 1. Migration 009：weekly_reports 表

`supabase/migrations/009_weekly_reports.sql`

```sql
-- =============================================================
-- 009：周成长报告
-- =============================================================
-- 设计（docs/DESIGN_PHASE5_WEEKLY.md v2，用户审核定稿 2026-08-26）：
--   1. 与 evening_reports 同构：UNIQUE(user_id, period_start) 是幂等根基
--   2. period_start/period_end 由服务端按 Asia/Shanghai 计算（周一为一周开始），不接收前端传入
--      period_start 语义是"滚动 7 天快照起点"（非固定自然周一），命名避免 week_start 误导
--   3. content jsonb 存结构化内容 { schemaVersion, stats, summary, achievement[], problem[], suggestion[], goalSuggestions[], replySource }
--      summary 文本列保留（与 evening_reports.summary 同风格，便于快速展示与检索）
--   4. 新表必须 ENABLE ROW LEVEL SECURITY（延续 007 修复：public 表一律 deny-all + 应用直连绕过）
-- =============================================================

create table public.weekly_reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  period_start  date not null,               -- 滚动快照起点（周一，Asia/Shanghai）
  period_end    date not null,               -- 滚动快照终点（周日）
  summary       text not null,
  content       jsonb not null,              -- 结构化内容（见 §3）
  source_count  int  not null default 0,     -- 本周记录条数
  created_at    timestamptz not null default now(),
  generated_at  timestamptz not null default now(),
  unique (user_id, period_start)
);

create index idx_weekly_user_start on public.weekly_reports(user_id, period_start);

alter table public.weekly_reports enable row level security;
```

类型（lib/repo/types.ts 追加）：
```ts
export type DbWeeklyReport = {
  id: string;
  user_id: string;
  period_start: string; // YYYY-MM-DD（周一）
  period_end: string;   // YYYY-MM-DD（周日）
  summary: string;
  content: Record<string, unknown> | null;
  source_count: number;
  created_at: string;
  generated_at: string;
};
```

---

## 2. API 概览（砍掉系统模式）

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| GET | /api/weekly/report | 查询本周报告（不存在返回 `{report:null}`，**不生成**） | 用户 JWT |
| POST | /api/weekly/report | 生成/刷新本周报告（幂等，返回 created 标识） | 用户 JWT |
| GET | /api/weekly/list | 历史周报分页（含 content，倒序） | 用户 JWT |

- 全部走 `authenticate`（**仅用户模式**；周报无系统调度，不需要 `resolveAuth` 双模式）。
- **采纳建议不新增写接口**：前端调既有 `PUT /api/goals/[id]`（已支持 title），服务端零绕过。
- 周报周期语义：**滚动本周**（`weekStartOf(today)` 起为本周，周内任意时刻生成 = "本周至今"快照；upsert 覆盖刷新，`generated_at` 更新）。

### GET /api/weekly/report —— 200
```json
{
  "report": {
    "id": "uuid",
    "periodStart": "2026-08-24",
    "periodEnd": "2026-08-30",
    "summary": "本周完成 7 个任务……",
    "sourceCount": 12,
    "content": { "schemaVersion": 1, "stats": {…}, "summary": "…", "achievement": […], "problem": […], "suggestion": […], "goalSuggestions": […], "replySource": "llm" },
    "generatedAt": "2026-08-26T14:00:00.000Z"
  }
}
```
未生成：`{ "report": null }`（前端据此进入 generating 态）。

### POST /api/weekly/report —— 200
```json
{ "id": "uuid", "periodStart": "2026-08-24", "created": true, "report": { …同上… } }
```
幂等：同日重复 POST 覆盖更新本周行，`created=false`（SQL `(xmax = 0) as inserted`，与 evening repo 同款）。

---

## 3. 周报内容结构 WeeklyContent（content jsonb）

```ts
type WeeklyStats = {
  periodStart: string;        // 周一
  periodEnd: string;          // 周日
  activeDays: number;         // 本周有记录的天数（0-7）
  recordCount: number;        // 本周记录条数
  minutes: number;            // 本周投入分钟（minutes 求和）
  doneTasks: number;          // 本周完成任务数（completed_at 落周窗口）
  windowTotal: number;        // 窗口任务数（created_at 或 deadline 落周窗口）
  completionRate: number;     // 计划执行率 = round(doneTasks / max(1, windowTotal) * 100)
  streak: number;             // 截至今天的连续记录天数（computeStreak 复用）
  goalProgress: Array<{       // 目标推进（进行中目标，全量）
    goalId: string;
    title: string;
    status: string;           // GOAL_STATUS 中文枚举
    progress: number;         // 当前派生进度 0-100（复用 deriveView）
    doneThisWeek: number;     // 本周窗口内完成的任务数
  }>;
  vsPrevWeek: {               // 行为变化（环比上周窗口 [periodStart-7, periodStart-1]）
    recordCount: number;
    minutes: number;
    doneTasks: number;
    completionRate: number;
  };
};

type GoalSuggestion = {       // 固定结构，LLM 不得自由发挥
  goalId: string;             // 必须存在并属于本人，否则丢弃
  action: "update_title";     // v2 仅此枚举（archive 暂不支持）
  newTitle: string;           // ≤40 字，否则丢弃该条
  reason: string;             // 建议理由（基于本周数据）
};

type WeeklyContent = {
  schemaVersion: number;       // = 1，迁移友好
  stats: WeeklyStats;         // 规则引擎独占，LLM 不可输出/不可改
  summary: string;            // LLM：≤3 句周总结，基于 stats 事实
  achievement: string[];      // LLM：本周亮点 1-3 条
  problem: string[];          // LLM：本周问题 0-2 条
  suggestion: string[];       // LLM：下周建议 1-2 条（肯定句、具体动作）
  goalSuggestions: GoalSuggestion[]; // LLM：目标调整建议（只建议；采纳需用户确认）
  replySource: "llm" | "rules";// 生成来源（规则回退时前端可标注"自动统计"）
};
```

### 口径约定（对齐既有，不另立新口径）
| 指标 | 口径 | 复用 |
|---|---|---|
| completionRate（标签「计划执行率」） | **Phase 4 新口径**：分母=created_at 或 deadline 落周窗口的任务（countWindowScopedTasks），分子=其中 done（countWindowScopedDoneTasks）。**只保留这一个完成率，不拆两个指标**（审核定稿：Phase 2 `countDoneTasksSince` 是半成品计数，不作成正式指标名，仅服务 dashboard/Agent Context，不进周报） | lib/repo/stats.ts 既有函数 |
| doneTasks | completed_at 落周窗口（countDoneTasksSince(periodStart)） | 既有 |
| minutes / activeDays | records 按上海时区落周窗口（dailyMinutesSince；activeDays 用新聚合 countRecordDaysBetween） | 既有 + 新增 |
| streak | computeStreak(recordDates, today) 复用 | 既有 |
| goalProgress.doneThisWeek | 新聚合 countDoneTasksByGoalSince：本周完成任务按 goal_id 分组 | 新增 repo 函数 |

---

## 4. 生成链路（复用晚报模式）

```
buildWeeklyContext(userId)        // 规则统计：stats 全量计算 + 目标/任务/记录抽样文本化
  → weeklyContextToText(ctx)      // 纯函数：分组/截断，token 可控
  → generateWeeklyDigest(text, ruleFallback)
      // LLM JSON（temperature 0.2, response_format json_object, 15s 超时）
      // → extractJson 三重容错（复用 evening-generator）
      // → isWeeklyContent schema 校验 + GoalSuggestion 语义校验
      // → 失败/无配置 → 规则回退
  → 组装最终 content：stats 永远用规则值，只取 LLM 文字字段（summary/achievement/problem/suggestion/goalSuggestions）
  → upsertWeeklyReport({userId, periodStart, periodEnd, summary, sourceCount, content})
      // ON CONFLICT (user_id, period_start) do update；(xmax=0) as inserted
```

### 规则回退（LLM 不可用时仍拿到完整周报）
- summary：基于 stats 模板拼接（`本周记录 X 条，投入 Y 分钟，完成 Z/ W 个任务（计划执行率 P%），连续记录 S 天。`）
- achievement：本周完成的前 3 个任务标题（截断 40 字）
- problem：completionRate < 50 时 `["本周计划执行率偏低（P%），可能有计划偏大或精力分散。"]`，否则 `[]`
- suggestion：`["从计划执行率最低的目标里挑一件 10 分钟能完成的小事先做"]`
- goalSuggestions：`[]`（规则不产目标建议，避免无依据的自动建议）
- schemaVersion: 1, replySource: "rules"

### LLM prompt 约束（写入 SYSTEM_PROMPT）
- 只允许输出 JSON 对象（字段见 §3），不输出其他文字
- **stats 已由系统计算，禁止重述或编造数字**；总结只能引用 stats 与上下文里出现的事实
- goalSuggestions 只对 status="进行中" 的目标提建议；没有需要调整的目标 → 空数组
- **action 仅 `update_title`**；必须附 newTitle（≤40 字）与 reason；**不输出 archive**（即使模型给也丢弃）
- 不评价人格、不做心理/医疗诊断（沿用晚报约束）

### 服务端校验（isWeeklyContent + 语义校验）
- schema 校验：stats 类型完整、summary string、数组元素 string、goalSuggestions 结构合法
- 语义校验：action 白名单（仅 update_title）；goalId 必须存在且属于该用户（查 goals by id+user_id，否则**丢弃该条**）；newTitle 非空且 ≤40 字（否则丢弃该条）
- **stats 数值始终用规则值**：生成器组装最终 content 时丢弃 LLM 输出里的 stats（规则值来自 stats 引擎，不信任 LLM 数字）
- 校验失败 → 规则回退（与晚报同策略，不做重试循环）

---

## 5. 目标建议 → 用户确认 → 改 Goal（§7.2 红线）

```
周报 goalSuggestions[i]（展示）
  └─ 用户点击"采纳"
       └─ action=update_title → PUT /api/goals/[id] { title: newTitle }
       └─ 成功 → 前端标记该条"已采纳"（本地 state），周报内容不变（历史快照）
```

- **采纳 = 用户显式操作**，满足"修改长期目标必须用户确认"。
- 复用既有 `PUT /api/goals/[id]`（Phase 1 已实现 title/status 校验 + id+user_id 双条件隔离），**零新增写接口、零绕过权限**。
- 采纳后周报内容不回写（周报是"当时快照"；目标已变更的事实由计划页体现）。

---

## 6. 前端：周报页（新增独立入口，旧页面零改动）

`app/weekly/page.tsx`（延续 Phase 4 "独立路由页消费查询能力"模式）
导航入口：加入顶部/侧边导航（与 records / plans 同级）。

```
状态机（复用晚报模式）：
  checking（GET 查询）→ 有报告 → ready
                       → 无报告 → generating（自动 POST 生成本周）→ ready / error
  error（500 显示重试）
```

页面区块：
1. **周统计卡**：活跃天数 / 记录数 / 投入分钟 / **计划执行率** / 连续记录天数；vsPrevWeek 环比箭头（↑红 ↓绿，与账本视觉一致）；无上周数据时显示"—"
2. **AI 周总结卡**：summary + achievement（亮点 ✓）/ problem（问题 ⚠）/ suggestion（下周建议 ▶）；`replySource=rules` 时角标"自动统计"
3. **目标推进表**：goalProgress（title + progress bar + doneThisWeek/W 本周完成）；只有进行中目标
4. **目标建议卡**：goalSuggestions 每条 = 目标标题 + reason + [采纳] 按钮（→ PUT /api/goals/[id]，乐观更新 + 标记已采纳 + 失败提示）；空则不渲染该卡

新增 lib/service/weekly.ts（业务编排）与 lib/agent/weekly-generator.ts（prompt/schema/规则回退），lib/repo/weekly.ts（upsert/查询/分页），lib/repo/stats.ts 加 countRecordDaysBetween / countDoneTasksByGoalSince。lib/service/time.ts 加 `weekStartOf(dateStr)`（周一，JS 计算）。

---

## 7. 验收脚本

`scripts/e2e-weekly.sh`（仿 e2e-records.sh）+ `scripts/smoke-weekly.mjs`：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 注册 + 种子 | 200 |
| 2 | 造本周数据（2 条记录 + 完成 2 任务） | 记录/任务可见 |
| 3 | POST /api/weekly/report | content.stats.activeDays/recordCount/doneTasks/completionRate 与造数一致 |
| 4 | 幂等 | 同日再 POST → created=false，行数=1 |
| 5 | goalSuggestions 语义校验 | 注入非法 action/非本人 goalId/超长 newTitle → 该条被丢弃（回退时空数组） |
| 6 | 采纳建议 | PUT /api/goals/[id] title 变更成功（复用既有接口） |
| 7 | 越权隔离 | B 用户 GET/POST 无 A 数据；B POST 后 A 报告不变 |
| 8 | 规则回退 | 无 LLM 配置（空 baseUrl）→ POST 仍返回完整报告 replySource=rules |
| 9 | GET /api/weekly/list | 分页倒序、含 content |
| 10 | 无系统模式 | 不存在 /api/weekly/generate 路由（设计上已砍） |

回归：e2e-records / e2e-goals / idempotency / e2e-closed-loop 全过；typecheck/lint/build 全过。

---

## 8. 变更记录

- 2026-08-26｜初稿 v1，待审核。
- 2026-08-26｜v2 定稿，按审核逐项调整：
  - 表 `week_start` 改名 `period_start`，新增 `period_end`。
  - 砍掉 `POST /api/weekly/generate` 系统模式 API，生成能力仅留 service 层。
  - goalSuggestions 仅 `update_title`，去掉 `archive`。
  - 完成率**只保留一个 `completion_rate`（Phase 4 窗口口径）**，不拆两个指标；展示标签「计划执行率」。
  - content 增加 `schemaVersion: 1` 与 `replySource`。
  - goalSuggestions 结构固定：`{ goalId, action, newTitle, reason }`，含 action 白名单 + newTitle ≤40 字服务端校验。
