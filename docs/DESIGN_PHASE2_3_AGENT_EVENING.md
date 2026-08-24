# Phase 2「Agent Context Layer」+ Phase 3「晚报自动生成」设计稿 v2（正式开发基线）

> 范围：0.3.0 MVP · 第 2、3 阶段（绑定开发：晚报 = Agent Context 的第一个落地场景）
> 日期：2026-08-24（v2 修订）
> 状态：用户审核通过，正式开发基线
> 配套路线：docs/ROADMAP_0.3.0.md（Phase 1 已完成并验收）
>
> v1 → v2 变更（用户审核意见，全部采纳）：
> 1. `completed_at` 补充边界说明：MVP 阶段记录**最后完成时间**，不代表历史完成轨迹；
> 2. 调度实现描述改为：setInterval 是 **MVP 调度实现**，保留 Scheduler 抽象，未来可替换外部 Cron；
> 3. Context 增加 `completionRate7d`（7 天完成率）；
> 4. `recentReport` 明确为**最近一条**晚报；
> 5. completed_at 索引改为 `idx_tasks_completed_at ON tasks(completed_at)`（按时间统计方便）。

---

## 1. 背景与目标

Phase 1 完成后，目标/任务已是真实数据。本阶段把 Agent 从"输入一句话 → 返回文本"升级为：

```
用户请求
   ↓
Context Builder（目标/任务/记录/7天统计/历史晚报）
   ↓
Prompt
   ↓
LLM（JSON 结构化输出）
   ↓
Schema 校验（失败规则回退）
   ↓
落库 evening_reports.content
```

并让晚报**服务端自动生成**（node-cron，`REPORT_TIME` 可配置），不再依赖"打开页面才触发"。

## 2. 现状核对（已核验代码）

| 现状 | 位置 |
|---|---|
| 晚报生成链路已有：拉当天记录 → summarizeRecords（纯函数）→ runAgent(review) → 规则回退 → 幂等落库 | `lib/service/evening.ts` |
| 生成接口支持用户/CRON_SECRET 双模式；`evening_reports` 表（summary 文本 + questions + source_count，UNIQUE(user_id, report_date)） | `app/api/evening-report/route.ts`、`003_evening_reports.sql` |
| Agent 现状：`runAgent` 返回文本 reply + 规则侧结构化 extracted（intent/kind/topic/…）；LLM 无 JSON 输出约定 | `lib/agent/provider.ts`、`understanding.ts` |
| 21:30 前端写死：懒触发 + 提醒定时器 | `page.tsx:77-78`（EVENING_REVIEW_HOUR/MINUTE，`:286/:357`） |
| 统计服务有：记录日期/每日分钟/证据计数/进行中目标 | `lib/repo/stats.ts` |
| **任务表无"完成时间"字段** → 算不出"近 7 天完成率"（scheduled_time 是文本、deadline 是日期） | `001_init.sql` tasks |
| Phase 1 已交付：Goal/Task CRUD、派生 progress、多用户隔离 | E-028/029 + e2e-goals.sh |

## 3. 设计决策（需你确认的 5 项）

1. **新增独立结构化生成路径，不改现有对话 Agent**：新增 `generateEveningDigest`（LLM JSON 输出），`runAgent`（对话）一行不动——避免结构化约束污染日常对话的意图解析语义。
2. **晚报结构化内容存 `content jsonb` 列**（migration 005 加列）：`{ summary, achievement[], problem[], suggestion[], evaluation }`；`summary` 文本列保留给人看（向后兼容，老数据不迁移）。
3. **任务加 `completed_at` 列**（migration 005）：toggle 完成写入 now()、撤销置 null。**账本链路零改动**（只在该 update 语句追加字段，idempotency-test.sh 回归兜底）。7 天完成率 = 近 7 天 completed_at 的任务数 / 当前任务总数。
4. **score 不参与业务**：LLM 输出只有 `evaluation`（文字评价），不返回数值分；派生进度/XP 仍由规则引擎按 tasks.status 计算。
5. **调度零新依赖，但保留 Scheduler 抽象**：MVP 调度实现用 `setInterval`（每分钟）检查上海时区当前时间 == `REPORT_TIME`（默认 21:30）且今日未跑过 → 触发；`lib/scheduler.ts` 导出独立触发函数（`runDailyEveningScheduler`），未来可平滑替换为外部 Cron（`CRON_SECRET` 系统模式接口已预留）。理由：无依赖、时区口径明确（Asia/Shanghai）、MVP 用户量小串行足够。

## 4. 数据层：migration `005_agent_evening.sql`

```sql
-- 晚报结构化内容（Phase 2；summary 文本列保留兼容）
alter table public.evening_reports
  add column content jsonb;

-- 任务完成时间（Phase 2；支撑 7 天完成率口径；toggle 完成写入/撤销清空）
-- 边界：MVP 阶段记录「最后完成时间」，不代表历史完成轨迹（不做完成历史追溯）
alter table public.tasks
  add column completed_at timestamptz;

-- 按完成时间维度统计（用户建议；后续周报/统计直接使用）
create index idx_tasks_completed_at on public.tasks(completed_at);
```

说明：全加列，兼容存量；`completed_at` 只在 `toggleTask` 的 update 语句追加（done → now()，undo → null），**账本结算逻辑零改动**。

## 5. Agent Context Layer

### 5.1 Context Builder（新增 `lib/service/context.ts`）

输入 userId → 输出（纯 SQL + 纯函数，不调 LLM）：

```ts
type AgentContext = {
  goal: { title: string; progress: number; taskCount: number; doneCount: number } | null; // 进行中目标，取最近 1 个
  tasks: Array<{ title: string; status: TaskStatus; kind: TaskKind }>;                     // 未完成任务（upcoming+current），最多 10
  todayRecords: Array<{ topic: string; text: string; kind: string | null; minutes: number }>; // 今日记录，最多 20
  weeklyStats: {
    activeDays: number;   // 连续记录天数（复用 computeStreak）
    minutes7d: number;    // 近 7 天投入分钟（复用 dailyMinutesSince）
    doneTasks7d: number;  // 近 7 天完成任务数（新 repo：completed_at 统计）
    completionRate7d: number; // 7 天完成率 = doneTasks7d / max(1, todayTotal)，百分比取整
    todayDone: number;    // 今日完成（status=done 且 completed_at 是今天）
    todayTotal: number;   // 当前任务总数
  };
  recentReport: string | null; // 最近一条晚报 summary（getLatestReport：按 report_date desc limit 1），供 Agent 参考连续性
};
```

- 新增 repo：`stats.ts` 加 `countDoneTasksSince(userId, sinceDate)`、`countTasks(userId)`；`evening.ts` 已有 `listRecordsByDate`、`getReportByDate`（新增 `getLatestReport(userId)` 取**最近一条**）。
- 新增纯函数 `contextToText(ctx)`：分组/截断为 token 可控的文本（沿用 summarizeRecords 的克制风格，不把原始敏感内容灌给 LLM）。

### 5.2 结构化生成（新增 `lib/agent/evening-generator.ts`）

- 签名：`generateEveningDigest(userId, contextText): Promise<{ content: EveningContent; replySource: "llm" | "rules" }>`
- LLM 路径：`chat/completions`，system 提示 = 成长教练角色 + **输出必须为合法 JSON**（给出 schema 示例），user = contextText；temperature 0.2、timeout 15s。
- **解析容错**：先 `JSON.parse` → 失败提取 ```` ```json ... ``` ```` 块 → 再失败规则回退。
- **Schema 校验**：`summary` string、`achievement/problem/suggestion` 为 string[]、`evaluation` string；类型不符 → 规则回退。
- **规则回退**（无 LLM/解析失败/超时）：`summary` = 现有 digest 文案；`achievement` = 今日记录主题（截断）；`problem` = []；`suggestion` = 三问引导；`evaluation` = 基于 todayDone/todayTotal 的固定话术。用户仍获得完整晚报体验（与现状回退一致）。

### 5.3 晚报生成改造（`lib/service/evening.ts`）

- `generateEveningReport`：`summarizeRecords` 后 → `contextToText` → `generateEveningDigest` → 落库 `{ summary: content.summary, content }`。
- 返回值扩展 `content`（前端可展示 achievement/suggestion）；`questions` 三问保留。
- `POST /api/evening-report` 返回体加 `content`。

## 6. 晚报调度（Phase 3）

### 6.1 调度器（新增 `lib/scheduler.ts` + `instrumentation.ts`）

- **MVP 调度实现**：Next.js 常驻进程启动时，`instrumentation.ts` 的 `register()` 挂载调度器（实现时先读 `node_modules/next/dist/docs/` 确认当前版本的注册方式；若不稳定则回退为 `scripts/start-with-scheduler.mjs` 包装启动）。
- **Scheduler 抽象**：`lib/scheduler.ts` 导出 `runDailyEveningScheduler()`（独立可调用的触发函数：遍历用户 + 幂等生成）与 `startEveningScheduler()`（内部 setInterval 轮询）；未来替换外部 Cron 时只改挂载点，触发逻辑复用（`CRON_SECRET` 系统模式接口同样调用它）。
- 逻辑：`setInterval(60s)` → 计算上海时区当前 `HH:MM` == `REPORT_TIME`（默认 `21:30`）且今日未触发过 → `runDailyEveningScheduler()`（`listUserIds()` 新 repo → 逐个 `generateEveningReport(userId)`，幂等、单用户失败不中断）→ 标记今日已跑。
- 环境变量：`REPORT_TIME=21:30`（解析失败用默认）。
- **部署边界**：MVP 调度只在常驻进程生效；`CRON_SECRET` 系统模式接口保留，供将来 serverless/外部定时器调用（不依赖本调度器）。

### 6.2 前端时间联动

- `GET /api/agent` 状态接口扩展返回 `eveningReportTime: "21:30"`（读 `REPORT_TIME`，默认 `21:30`）。
- `page.tsx`：`EVENING_REVIEW_HOUR/MINUTE` 常量改为运行时 state（ready 后从状态接口获取，fallback 21:30）；懒触发与提醒定时器统一用它。UI 写死的"21:30"文案同步改引用。

## 7. 页面改动

- **首页晚报卡**（`page.tsx` TodayHome 晚报区）：`ready` 且 content 存在时，展示 `summary` + 高亮 `achievement`（今日达成）与 `suggestion`（明日建议）；`no-report` 保持现有"21:30 轻提醒 + 开关"。三问展示保留。
- **移动壳**：晚报条文案时间改读 eveningReportTime（其余不动）。
- **晚报详情**：MVP 不做独立页面，首页卡内展示结构化摘要即可（周报阶段再做完整页）。

## 8. 验收方案

### 8.1 自动化（新增 `scripts/e2e-evening-context.sh`）

1. 注册用户 → 记录 2-3 条今日记录（/api/agent）；
2. `POST /api/evening-report`（用户模式）→ 201/200，返回含 `report.summary` 与 `content`（结构：summary/achievement/problem/suggestion/evaluation，类型校验）；
3. 再次 POST → `created=false`（幂等）；
4. PATCH 完成一个任务 → 校验 `GET /api/tasks` 返回含 `completedAt`（新增字段映射）且 `stats.doneTasks7d` ≥ 1（context 口径可验）；
5. 无 LLM 配置（demo 模式）→ 仍返回结构化 content（规则回退，replySource=rules）。

### 8.2 调度验收

- 设置 `REPORT_TIME=当前时间+2分钟` 启动服务 → 等待触发 → `GET /api/evening-report/today` 返回今日晚报（关闭浏览器也能生成）；
- 或直接 curl `POST /api/evening-report`（Bearer CRON_SECRET + body userId）验证系统模式仍可用。

### 8.3 回归

- `scripts/e2e-goals.sh`、`idempotency-test.sh`（账本未动）、`e2e-closed-loop.sh` 全过；`typecheck/lint/build` 全过。

## 9. 风险与边界

- **JSON 输出不可靠是最大风险**：三重兜底（解析容错 + schema 校验 + 规则回退），LLM 失败用户永远拿到完整晚报（退化到现状）。
- **不改对话 Agent**：`runAgent`、理解测验、Agent 路线卡行为不变（回归 e2e-closed-loop）。
- **账本红线**：toggleTask 只追加 completed_at 字段（MVP 记录最后完成时间，不代表历史完成轨迹），账本/幂等逻辑零改动（idempotency-test 兜底）。
- **调度器仅常驻进程**：serverless 部署不生效 → CRON_SECRET 接口保留为通用触发入口（文档注明）。
- **空数据**：今天无记录 → 规则回退文案（"今天还没有留下任何记录"），不阻塞生成。
- **token 控制**：contextToText 截断上限（目标 3 条/任务 10 条/记录 20 条），避免长上下文超限。
- **时区**：调度与"今日"统一 Asia/Shanghai（与既有 todayInShanghai 口径一致）。

## 10. 改动文件清单

新增：
```
supabase/migrations/005_agent_evening.sql
lib/service/context.ts            （Context Builder + contextToText）
lib/agent/evening-generator.ts    （结构化生成 + 解析容错 + schema 校验 + 规则回退）
lib/scheduler.ts                  （REPORT_TIME 调度器）
instrumentation.ts                （注册调度器；如版本不支持则改 scripts 包装）
scripts/e2e-evening-context.sh
```

修改：
```
lib/repo/evening.ts      （getLatestReport）
lib/repo/stats.ts        （countDoneTasksSince / countTasks）
lib/repo/tasks.ts        （toggleTask 追加 completed_at；TASK_SELECT 加 completed_at；mapTask 映射）
lib/repo/types.ts        （DbTask 加 completed_at；DbEveningReport 加 content）
lib/service/evening.ts   （生成链路接结构化 + content 落库 + 返回值扩展）
lib/service/seed.ts      （mapTaskToSeedTask 可选映射 completedAt）
app/api/evening-report/route.ts（返回体加 content）
app/api/agent/route.ts   （GET 状态加 eveningReportTime）
app/page.tsx             （晚报卡展示 achievement/suggestion；时间改运行时配置）
app/mobile-shell.tsx     （晚报条时间改读配置）
```

## 11. 预期效果

- Agent 真正"看见"用户：目标/任务/记录/7 天统计/历史晚报构成上下文，输出结构化成长反馈（不是固定模板）；
- 晚报 21:30 服务端自动生成（浏览器关着也生成），时间可配置；
- 首页晚报卡展示"今日达成 / 明日建议"；
- 为 Phase 5（周成长报告）铺路：weekly_reports 可复用 Context + 结构化生成路径。
