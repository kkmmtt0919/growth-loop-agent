# Agent Decompose V1 设计稿（目标拆解成行动）

> 范围：0.3.0 MVP · 目标「拆成行动」从固定模板升级为 Agent 规划
> 日期：2026-08-25
> 状态：待用户审核（审核通过后开发）
> 基线：用户 2026-08-25 审核确认（3 个工程修正 + 3 个 MVP 边界全部采纳）

---

## 0. 目标与边界

把当前固定模板（`从「目标」拆一步` + 15 分钟）升级为：

```
用户点击拆成行动（按钮 loading 禁用）
  → Backend Context（目标 + 已有任务）
  → 系统计算步数范围 → LLM Planner（范围内选步）
  → Schema Validate → Quality Validate（规则层，最多 1 次带反馈重试）
  → Category Mapper（语义层 → 系统层）
  → 事务批量创建（全有全无）
  → 返回 createdTaskIds → toast「已拆出 N 步 [撤销]」
```

**边界（不做）**：不做拆解方案预览确认（MVP 直接创建 + 可撤销）；不做无限重生成；移动端不新增拆解入口（维持"查看+完成"）；priority / user habits 不落库。

---

## 1. API：POST /api/goals/{id}/decompose

### 1.1 请求
```
POST /api/goals/:goalId/decompose
Authorization: Bearer <jwt>
Content-Type: application/json
Body: {}   // 无业务入参，上下文全部服务端收集
```

### 1.2 响应（成功 200）
```json
{
  "success": true,
  "count": 3,
  "source": "llm",              // "llm" | "rules"（规则回退）
  "createdTaskIds": ["uuid-1", "uuid-2", "uuid-3"],
  "tasks": [                    // 前端 Task 形状（mapTaskToSeedTask）
    {
      "id": "uuid-1", "title": "完成 Python 变量与循环练习",
      "subtitle": "用两个小程序练习变量、循环、函数", "time": "",
      "duration": "45 min", "xp": 0, "coin": 0,
      "status": "upcoming", "kind": "learn", "completedAt": null
    }
  ]
}
```

### 1.3 错误
| 状态 | 场景 |
|---|---|
| 400 | 目标没有可拆解内容（title 为空等） |
| 404 | 目标不存在 / 跨用户（id + user_id 双条件） |
| 409 | 目标下已存在同名任务（createTask 防重复） |
| 500 | 生成链路异常（规则回退也失败时，明确报错不静默） |

### 1.4 Service 流程（lib/service/decompose.ts）

```
decomposeGoal(userId, goalId)
  1. getGoal(userId, goalId) → 不存在 404
  2. 收集 Context：goal.title / description / horizon / start_date / end_date
                  + existingTasks（goal_id 下全部 tasks.title，按 created_at asc）
  3. 步数范围：computeStepRange(goal) → { min, max }（见 §2.2）
  4. LLM Planner：generateDecomposePlan(contextText, range) → { steps }（含 1 次重试，见 §4）
  5. Schema Validate（§3.2）
  6. Quality Validate（§4.2）→ 不合格步丢弃 / 带反馈重试 1 次 / 规则回退
  7. Category Mapper：category → kind（§5）
  8. 事务批量 createTask：goal_id + title + subtitle(description) + acceptance + duration_minutes(estimatedMinutes) + kind，scheduled_time=""
     - 事务内先查已有 title 集合，跳过重复标题的步（防并发双拆出重复）
     - 全有全无（任一步插入失败 → 整批回滚）
  9. 返回 { count, source, createdTaskIds, tasks }
```

规则回退（rules source）：无 LLM 配置 / 校验重试后仍失败 → 按步数范围取 min 步数，每步用模板
（`围绕「{goal.title}」的第 {n} 步` + 通用验收文案 + 30 分钟 + learn/focus 交替），保证用户永远拿到可用的拆解结果。

---

## 2. Migration 006 + 步数范围

### 2.1 `supabase/migrations/006_decompose.sql`
```sql
-- 目标拆解：任务验收标准（Agent Decompose V1；老任务为 null，展示时隐藏）
alter table public.tasks
  add column acceptance text;

-- 不新增索引：acceptance 仅作展示字段，无查询过滤场景
-- （goal_id 检索已有 idx_tasks_goal_status 覆盖）
```

### 2.2 步数范围（computeStepRange，纯函数）
优先用 end_date - today（上海时区）计算 durationDays；无 end_date 时按 horizon 文本启发式（匹配 "周/周目标" → ×7，匹配 "月" → ×30，否则默认 30 天档）：

| 周期 | min | max |
|---|---|---|
| <= 7 天 | 2 | 3 |
| 7–30 天 | 3 | 4 |
| 30–90 天 | 4 | 6 |
| > 90 天 | 5 | 8 |

Prompt 明确告知范围，Schema 校验强制 `min <= steps.length <= max`（越界 → 重试 1 次 → 失败按 max 截断并规则补足/回退）。

---

## 3. Agent Prompt v1 + Schema

### 3.1 System Prompt（lib/agent/decompose-generator.ts）
```
你是成长回路的目标拆解规划器。根据用户目标和已有任务，把目标拆成若干「今天就能开始的可执行行动」。

输入数据：
- goal：目标的标题、描述、周期
- existingTasks：该目标下已有的任务标题
- stepRange：系统建议的步骤数量范围 {min, max}

输出要求（必须只输出一个合法 JSON 对象，无任何其他文字）：
{
  "steps": [
    {
      "order": 1,
      "title": "行动名（不超过 40 字，可直接执行的动词开头，如『完成…』『整理…』『跑通…』）",
      "description": "这一步具体做什么（一两句话）",
      "acceptance": "完成标准：做到什么程度算完成（必须可验证，禁止『好好学』『认真做』）",
      "estimatedMinutes": 45,
      "category": "learning | exercise | coding | reading | creative | life | rest | other"
    }
  ]
}

硬性约束：
1. steps 数量必须在 {min}-{max} 之间，不得超出
2. 每步 estimatedMinutes 在 5-240 之间
3. 不得生成与 existingTasks 重复或高度相似的步骤
4. 禁止把大目标当行动：标题不得含『掌握』『精通』『学完』『全面学习』『彻底理解』『完成整个课程』『学会全部』
5. title 用动词开头，是 40 分钟内能启动的动作；如果目标太宏大，拆出的是它的第一个可执行切片，而不是路线图
6. category 从给定枚举选，不要自造
```

### 3.2 Schema Validate（确定性）
- `steps` 为数组，`min <= length <= max`
- 每步：order 数字递增；title/description/acceptance 为非空字符串；estimatedMinutes 数字 5–240；category 在枚举内
- 类型不符 / 越界 → 校验失败（进入 Quality 的重试/回退逻辑）

### 3.3 Example Output（Prompt 内附带一例）
```json
{
  "steps": [
    { "order": 1, "title": "跑通 Python 环境并写第一个程序",
      "description": "安装运行环境，运行 hello world 和两个变量运算示例",
      "acceptance": "能独立运行 3 个示例并解释每行作用", "estimatedMinutes": 60, "category": "coding" },
    { "order": 2, "title": "完成变量、循环、函数练习",
      "description": "用列表循环和函数改写一个小工具",
      "acceptance": "练习题正确率 ≥ 60%，错题记入笔记", "estimatedMinutes": 90, "category": "learning" }
  ]
}
```

---

## 4. Quality Validator（确定性规则层，不做无限重试）

### 4.1 每步规则（命中即判不合格）
| 检查 | 规则 |
|---|---|
| title | 非空且 ≤ 40 字符 |
| description | 非空 |
| estimatedMinutes | 5–240 整数 |
| 大目标词 | 标题命中 blacklist：`掌握 / 精通 / 学完 / 全面学习 / 彻底理解 / 完成整个课程 / 学会全部` |
| 与已有任务重复 | title 与 existingTasks 任一相似度 ≥ 阈值（包含关系或编辑距离 ≤ 3） |

### 4.2 处理优先级（绝不循环重生成）
```
1. 全部通过            → 进入 Category Mapper
2. 部分步不合格        → 丢弃不合格步；若剩余 >= min → 继续；否则进入 3
3. 剩余 < min / 全丢    → 带反馈重试 1 次（把不合格原因拼进 prompt）
4. 重试仍失败           → 规则回退（§1.4）
```
代价可控：最多 1 次额外 LLM 调用；失败不阻塞，用户始终拿到结果。

---

## 5. Category Mapper（语义层 → 系统层）

```ts
const CATEGORY_TO_KIND: Record<string, TaskKind> = {
  learning: "learn",
  exercise: "exercise",
  coding: "focus",
  reading: "learn",
  creative: "focus",
  life: "life",
  rest: "rest",
  other: "focus",
};
// 未知 category → "focus"（永远合法，前端样式稳定）
```
理由：LLM 语义层可自由演进（未来加 writing/meeting/habit 只改映射表），DB enum 与前端 `kind-*` 样式系统零改动。

---

## 6. 前端交互（app/page.tsx）

1. **拆解入口**：计划页目标卡「拆成行动」→ `isDecomposing` state（目标级：`decomposingGoalId`）→ 按钮 loading 文案「拆解中…」+ 禁用（防重复点击）；Agent 路线卡按钮同链路。
2. **成功**：`toast("已拆出 N 步", { undo: true })`——toast 带 `[撤销]` 按钮，5 分钟自动消失（前端 setTimeout，非服务端约束）。
3. **撤销**：点击 → `DELETE /api/tasks/batch { ids: createdTaskIds }` → 前端移除这些任务 + 刷新 goals（taskCount/doneCount 派生）+ toast「已撤销」。
4. **acceptance 展示**：任务卡（今日时间轴 schedule-card / 首页 HomeAgendaRow）点击展开一行 `完成标准：{acceptance}`（subtitle 保持 description，列表不被污染）；acceptance 为空不显示展开行。
5. **时间兜底**：拆解任务 scheduled_time 为空 → 时间轴 time 显示「今天」。
6. **失败**：规则回退也失败 → toast「拆解失败，请稍后再试」，按钮恢复。

### 6.1 新增 API：DELETE /api/tasks/batch
```json
// 请求
{ "ids": ["uuid-1", "uuid-2"] }
// 响应 200
{ "deleted": 2 }
```
事务删除，`id + user_id` 双条件（跨用户删除 0 条不报错）；**不冲正账本**（与 DELETE /api/tasks/:id 一致，§6.5 删除任务不扣分）。

---

## 7. 验收测试脚本（scripts/e2e-decompose.sh）

| 用例 | 断言 |
|---|---|
| 正常目标（有描述 + end_date） | 200；count ∈ [2,8]；每步 kind ∈ 5 枚举、acceptance 非空、duration_minutes ∈ [5,240]；scheduled_time 为空 |
| 空描述目标 | 仍返回 count >= 2（LLM 只靠 title 或规则回退 source=rules） |
| 二次拆解（增量） | 第二次返回的任务 title 与第一次集合无重复（相似度阈值内） |
| 防重复点击（并发两次） | 两次合并结果无重复 title（事务内查重兜底），不会建出两份相同任务 |
| 撤销 | `DELETE /api/tasks/batch` 删掉 createdTaskIds → GET /api/tasks 确认消失 |
| 越权 | 用户 B 对 A 的目标 decompose → 404 |
| 回归 | e2e-goals / idempotency / e2e-closed-loop / typecheck / lint / build |

---

## 8. 改动文件清单

新增：
```
supabase/migrations/006_decompose.sql
lib/service/decompose.ts          （Service 主流程 + computeStepRange + CATEGORY_TO_KIND）
lib/agent/decompose-generator.ts  （LLM Planner + Schema Validate + Quality Validator + 规则回退）
app/api/goals/[id]/decompose/route.ts
app/api/tasks/batch/route.ts      （DELETE 批量撤销）
scripts/e2e-decompose.sh
```

修改：
```
lib/repo/types.ts        （DbTask 加 acceptance）
lib/repo/tasks.ts        （TASK_SELECT 加 acceptance；createTask 入参加 acceptance；batchDeleteTasks）
lib/repo/goals.ts        （listTasksByGoal 已有 countTasksByGoal，新增 listTaskTitlesByGoal 或复用）
lib/service/tasks.ts     （createTaskForUser 透传 acceptance）
lib/service/seed.ts      （mapTaskToSeedTask 映射 acceptance → Task 形状）
lib/demo-data.ts         （Task 类型加 acceptance?: string | null）
app/page.tsx             （拆解入口 loading / toast+undo / acceptance 展开行 / time 兜底）
app/globals.css          （展开行、拆解中按钮、toast 撤销样式）
app/mobile-shell.tsx     （任务卡如展示 subtitle 不受影响；不做拆解入口）
README.md                （API 速查补 decompose / tasks batch）
```

## 9. 风险与边界

- **延迟**：LLM 一次 3–8s + 最多 1 次重试 → 前端 loading 必须明确（按钮禁用 + 文案）。
- **LLM 不可用**：规则回退保证可拆（source=rules），体验不归零。
- **并发双拆**：前端禁用 + 服务端事务内按 title 查重跳过，双保险。
- **存量任务**：acceptance 为 null → 前端不显示展开行，无迁移成本。
- **成本**：每次拆解 ≤ 2 次 LLM 调用（默认 1 次），MVP 可接受。
