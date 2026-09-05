# Phase 8「数据导出」设计稿 v1

> 日期：2026-08-27
> 状态：待用户审核
> 前置：Phase 7「数据删除」已交付（`6697707`）。本阶段补齐合规闭环的另一半「可导出 / 可删除」（产品设计 §12）。

---

## 1. 目标与范围

### 1.1 一句话

新增 `GET /api/privacy/export`，把当前登录用户的**全部业务数据**打包成一份机器可读、自描述的 JSON 文档返回，供用户下载留存或迁移。

### 1.2 做

- `GET /api/privacy/export`：JWT 鉴权后返回完整数据快照（JSON）。
- 数据按「顶层 profile + 分表数组」组织，逐字段对齐数据库真实列，不做业务加工。
- 一个冒烟脚本 `scripts/smoke-export.mjs` 验证闭环。

### 1.3 不做（本期明确排除）

- ❌ **不产出文件下载**（不生成 zip / 不写对象存储）。直接返回 JSON 响应体，由前端/用户决定如何保存。
- ❌ **不做异步导出任务 / 进度查询**。当前个人数据量级（百条级记录）同步返回足够。
- ❌ **不做「分表增量导出」**。一次性全量快照即可。
- ❌ **不做加密 / 签名 / 时间戳校验**（那是生产合规的加分项，非 MVP 必需）。
- ❌ **不新增表**。导出是纯读，零 migration。
- ❌ **不做前端下载按钮 UI**（本期只交付 API + 冒烟；前端入口留后续阶段，避免 UI 范围膨胀）。

### 1.4 为什么不做 UI

产品 §12 要求「可导出」是后端合规能力。前端「我的」页目前仍是 demo 数据（账号区真实化在 P7 已确认留后续阶段），现在加下载按钮会悬空在未真实化的页面上。**先交付可独立验收的后端闭环**，UI 等「我的」页真实化阶段一并接入。

---

## 2. 数据范围（9 张表）

导出以下**当前用户全部**数据（`user_id = 鉴权 userId`）：

| 分组 | 表 | 说明 | 复用现有 repo |
|---|---|---|---|
| profile | `profiles` | 账号画像（**绝不含 password_hash**） | `findById` |
| goals | `goals` | 目标 | `listGoals` ✅ |
| tasks | `tasks` | 任务 | `listTasks` ✅ |
| records | `records` | 行动/学习记录 | `listRecords`（需传大 limit）|
| ledger | `ledger_entries` | XP/COIN 账本流水 | `listLedger`（需传大 limit）|
| quiz | `quiz_sessions` | 理解测验 | **新增** `listQuizSessions` |
| evening | `evening_reports` | 每日晚报 | **新增** `listEveningReports` |
| weekly | `weekly_reports` | 周报 | `listWeeklyReports` ✅ |

> `profiles` 用 `findById`；`listRecords`/`listLedger` 现有默认 limit 过小（100/50），导出需全量，因此给这两个函数增加可选 `limit` 覆盖，或新增专用全量查询（见 §5 决策 D2）。

---

## 3. 导出文档格式

### 3.1 顶层结构

```jsonc
{
  "schemaVersion": 1,                 // 导出格式版本，未来结构演进用
  "exportedAt": "2026-08-27T09:12:33.000Z",   // ISO 8601 UTC，生成时间
  "user": {
    "id": "uuid",
    "email": "a@b.com",
    "displayName": "小明",
    "level": 3,
    "role": "探索者",
    "streak": 5,
    "xpBalance": 120,
    "coinBalance": 40,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "goals":  [ { ...DbGoal camelCase... } ],
  "tasks":  [ { ...DbTask camelCase... } ],
  "records": [ { ...DbRecord camelCase... } ],
  "ledger":  [ { ...DbLedgerEntry camelCase... } ],
  "quizSessions": [ { ...DbQuizSession camelCase... } ],
  "eveningReports": [ { ...DbEveningReport camelCase... } ],
  "weeklyReports": [ { ...DbWeeklyReport camelCase... } ]
}
```

### 3.2 字段命名

数据库列是 `snake_case`（`display_name`），导出对外用 `camelCase`（`displayName`）——与现有 API 对外契约（`toPublicProfile` 等）的驼峰风格一致。

### 3.3 关键点

- **profile 剥离 `password_hash`**：复用 `toPublicProfile` 的「解构剔除」手法。
- **`id` 保留 uuid 原文**，便于跨环境迁移定位。
- **jsonb 字段**（`quiz.questions/answers`、`evening.content`、`weekly.content`）原样透传，不二次解析。
- **时间字段**保留 DB 原文（timestamptz 序列化字符串），不重算时区。
- 空表也返回 `[]`（不省略 key），保证结构稳定、机器可解析。

---

## 4. 三层改动

### 4.1 Repo 层（`lib/repo/`）

- 新增 `lib/repo/export.ts`（**单一聚合查询**，一个文件收拢全部「按 user 全量取数」，避免散落）：
  - `getUserDataForExport(userId)`：并行 `Promise.all` 拉 8 组数据（复用 `findById`/`listGoals`/`listTasks`/`listRecords`/`listLedger`/新增 quiz/evening/`listWeeklyReports`），返回原始 `DbXxx[]`。
  - 或按现有惯例「每表一个 repo」把 quiz/evening 的全量查询加到各自 repo。**倾向新增独立 `export.ts`**（见 D1）。

- 补齐两个缺失的全量查询（放各自 repo 更内聚）：
  - `lib/repo/quiz.ts`：`listQuizSessions(userId)` → `select * where user_id = $1 order by created_at asc`。
  - `lib/repo/evening.ts`：`listEveningReports(userId)` → 同理（`evening_reports` 当前只有按日期/最新查询，无全量）。

### 4.2 Service 层（`lib/service/`）

- 新增 `lib/service/export.ts`：
  - `exportUserData(userId)`：
    1. `getProfileById(userId)`（查无 → 404，复用 auth.ts 现有函数）；
    2. 调 repo 聚合取数；
    3. 组装 §3 文档，逐表 `snake_case → camelCase` 映射（纯函数，可单测）；
    4. 返回 `ExportDocument` 对象。

### 4.3 API 层（`app/api/`）

- 新增 `app/api/privacy/export/route.ts`（`GET`）：
  - `authenticate(request)` → `exportUserData(userId)` → `NextResponse.json(doc)`。
  - 错误处理与 `/api/auth/delete` 同构（AuthError → 401、ServiceError → 对应状态、未知 → 500）。

---

## 5. 待确认决策

- **D1｜聚合查询放哪**：推荐**新增 `lib/repo/export.ts` 独立聚合文件**（一次性把 8 组取数收拢，跨表只读无副作用，避免污染各业务 repo；quiz/evening 的全量查询则加回各自 repo 保持内聚）。备选：全塞进 service 直接调各 repo。
- **D2｜listRecords/listLedger 的 limit**：推荐给这两个函数**增加可选 `limit` 参数**（默认值不变，导出传 `Number.MAX_SAFE_INTEGER` 或一个足够大的数如 100000），避免新增重复 SQL。备选：新增 `listAllRecords`/`listAllLedger` 专用函数。
- **D3｜camelCase 映射实现**：推荐**显式手写映射函数**（`mapRecordToExport` 等），逐字段可控、类型安全；不做通用 `snakeToCamel` 递归（jsonb 内字段是业务数据，不应被递归改写，手写能精确控制边界）。
- **D4｜是否含 `password_hash` 以外的敏感字段**：确认 `email` 可以出现在导出里（用户自己的邮箱，合规上可导出）；无其它敏感字段。

---

## 6. 改动文件清单

| 文件 | 动作 |
|---|---|
| `lib/repo/export.ts` | 新增（聚合取数，D1） |
| `lib/repo/quiz.ts` | 加 `listQuizSessions` |
| `lib/repo/evening.ts` | 加 `listEveningReports` |
| `lib/repo/records.ts` | `listRecords` 加可选 `limit`（D2） |
| `lib/repo/ledger.ts` | `listLedger` 加可选 `limit`（D2） |
| `lib/service/export.ts` | 新增（组装 + camelCase 映射 + 404） |
| `app/api/privacy/export/route.ts` | 新增 GET 路由 |
| `scripts/smoke-export.mjs` | 新增冒烟测试 |

---

## 7. 验证方案

`scripts/smoke-export.mjs`（对齐 smoke-delete 风格，8 组断言）：

1. 注册用户 A → 建 goal / task / record / 触发一次晚报（或直接 insert）→ 记 ledger。
2. `GET /api/privacy/export`（带 token）→ 200，返回 `schemaVersion=1`。
3. 校验 `user.email` 正确、`user` 对象**无 `passwordHash`/`password_hash` 字段**。
4. 校验 `goals/tasks/records/ledger` 数组长度 ≥ 1，且含刚创建的实体 id。
5. 校验 `quizSessions/eveningReports/weeklyReports` 为数组（可为空 `[]`）。
6. 未鉴权 `GET` → 401。
7. 隔离：注册用户 B 后，A 的导出**不含 B 的任何数据**（遍历比对 id 集合）。
8. 字段命名：抽查 `displayName`、`xpBalance` 等 camelCase 存在，`snake_case` 不存在于顶层。

另：`npm run typecheck && npm run lint && npm run build` 全绿。

---

## 8. 与既有约定的一致性

- 纯标准 PG，零 Supabase 依赖、零 migration（红线不变）。
- 四层架构不变：API → Service → Repo → PG。
- 多用户隔离：所有取数显式 `user_id = userId`（复用现有 repo，天然满足）。
- JWT 语义与 P7 一致：删号后旧 token 能过 `authenticate`，但 `getProfileById` 查无 → 返回 404。

---

## 9. 变更记录

- 2026-08-27｜P8 方向经用户确认（数据导出）；产出本设计稿 v1，含 D1-D4 待确认决策。
