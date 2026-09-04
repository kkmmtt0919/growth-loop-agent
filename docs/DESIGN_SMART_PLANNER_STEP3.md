# Smart Planner Step 3：Planner 排程建议（安排计划）

> 上游：`docs/DESIGN_SMART_PLANNER_V1.md`（冻结）§2 Planner 核心 / §4 Step 3
> 依赖：Step 1（actions/schedules/user_availability 表 + planner repo）✅ · Step 2a（行动路线生成）✅ · Step 2c（Goal 卡行动路线 + completed 标记）✅
> 日期：2026-09-04
> 状态：**设计冻结**（2026-09-04 用户审核通过；修订记录见 §0，随后按 8a 后端 → 8b 前端 → 8c 回归开发）
> 定位：用户对「行动路线」点**安排计划** → Planner 只出**建议预览**（不落库）→ 用户「接受」才写 `schedules`。AI 是规划助手，不替用户做决定。

## 0. 审核修订记录

### v2（2026-09-04 用户审核通过冻结）

1. **availability.title 空/非空语义（必须写明，防止歧义）**：`title=''` → **可用于 Planner 安排的自由时间（可排空档）**；`title≠''`（如「上课」「运动」）→ **固定时间块，Planner 不可占用，仅展示**。设置卡文案同步此语义。
2. **「撤销安排」(reset) 只删 `source='action'` 的计划中 schedules**：绝不碰 `source='manual'`（未来手动日程与 Planner 无关）；SQL 过滤 `source='action' and status='planned'`，按该 goal 下 action 范围删除。
3. **Preview 零落库是 Step 3 最关键边界，入验收**（§0 验收 #9）：`POST /plan` 后 `schedules` 计数不变、`actions.status` 不变；只有 `POST /plan/accept` 才变化。
4. **Action 状态机推进时机明确**：生成 Preview / 用户未接受 → action **保持 pending**；只有 accept 落库时才 `pending → planned`（预览不预推进）；reset 再把 planned 回 pending（已完成不动）。

### v3（2026-09-04 用户 3a 代码/架构复审，进入 3b 前记录）

5. **设计债①（availability 只支持周模板，不支持一次性事件）**：模型无法表达「9月10日 18:00-20:00 朋友聚餐」这类临时占用。未来需要拆两层：`availability_template`（周模板）+ `calendar_events`（一次性日历事件，排程时叠加占用）。**MVP 保持现状正确，不做**（Step 4/5 后再评估）。
6. **设计债②（Rule Scheduler 简单贪心 → 未来 deadline-aware）**：多 action 且 deadline 逼近时，贪心「先塞完长 action」可能挤压小 action 导致后者无空间。当前范围（14 天窗口 / ≤90min 切片 / 单目标规划）够用不优化；登记 Phase3 后续 = critical-path + deadline aware scheduler。
7. **验收 A（Preview 多次生成仍零落库）**：连续多次 `POST /plan`（每次结果可能不同），`schedules` 计数与 `actions.status` 恒定不变（防“偷偷写”回归）。
8. **验收 B（accept 后改 availability，旧 schedule 不自动移动）**：schedule 是用户已承诺的执行计划；accept 之后修改可用时间**不得自动挪动/重排已落库 schedules**（自动移动只属于未来“重新规划”，reset → 再 plan → 再 accept）。

---

## 0. 目标与验收

| # | 验收项 | 判定 |
|---|---|---|
| 1 | 用户能维护「每周可用时间」（availability 设置），Planner 只在其空档内排 | ✅ 前置能力（本轮新增） |
| 2 | 无可用时间 → 不排程，给出引导（先去设置固定时间） | ✅ 不空转不瞎排 |
| 3 | 点「安排计划」→ 生成**建议预览**（可行性 + 未来 2 周精确 slot），**不写库** | ✅ 核心 |
| 4 | 点「接受计划」→ 写 `schedules`（source='action'）+ 对应 action → planned；**幂等**（已安排的阶段跳过） | ✅ |
| 5 | 建议时间落在可用空档内、**互不重叠**、不占用固定块 | ✅ Rule Scheduler 保证 |
| 6 | 行动阶段状态闭环：pending →（接受）→ planned（卡片显示「已安排」） | ✅ |
| 7 | 提供「撤销安排」把该目标所有计划中的 schedules 清掉、actions 回到 pending | ✅ 控制权 |
| 8 | 今日时间轴**一行不改**（仍读 tasks）——schedule 进时间轴是 Step 4 | ✅ 不越界 |
| 9 | **Preview 零落库**：POST /plan 后 schedules 计数不变、actions.status 不变；仅 accept 后变化 | ✅ Step3 最关键边界（审核补充） |
| 10 | **Preview 多次生成仍零落库**（验收 A）：连续多次 POST /plan（结果可不同），schedules/actions 恒定不变 | ✅ v3 复审补充 |
| 11 | **accept 后改 availability，旧 schedule 不自动移动**（验收 B）：schedule 是已承诺执行计划，自动重排只属于未来 replan | ✅ v3 复审补充 |

**不做**（Step 3 边界）：今日时间轴读 schedules / fixed 块合并展示（Step 4）；晚报未完成流转与计划完成率（Step 5）；跨目标并行规划 / 手动拖拽微调 schedule / 历史进度反推重排（P2）。

---

## 1. 现状核对（file:line）

| 事实 | 位置 |
|---|---|
| actions / schedules / user_availability 3 表 + repo CRUD 已就绪 | 011 / lib/repo/planner.ts |
| action 状态机 pending→planned→completed；schedule 独立（开发规范②） | planner.ts updateAction / updateScheduleStatus |
| Rule Scheduler 决策（纯函数贪心，LLM 不产精确 slot） | DESIGN_SMART_PLANNER_V1 §2.3（冻结） |
| 双窗口历史数据：`dailyMinutesSince(userId, sinceDate)` → `{day, minutes}[]`（records 实际分钟，无记录的天不返回） | lib/repo/stats.ts:32 |
| 可用时间模板语义：`user_availability.title=''` → 可排候选池；`title≠''` → 固定块不可占用（011 头注释） | 011_smart_planner.sql:84-85 |
| availability **无 service / 无 API / 无前端 UI**（表空） | —— 本轮新增 |
| 行动路线 UI：Goal 卡内嵌区块（2c），「安排计划」入口尚未存在 | page.tsx goal-actions-list（2c 已交付） |
| reset 需要的事务基础：schedules.action_id FK cascade / status 过滤现成 | 011 |

---

## 2. 链路设计（目标态）

```
Goal 卡行动路线 →「安排计划」(仅当有 pending 阶段)
        │
        ▼
POST /api/goals/:id/plan                    （建议预览，不落库）
  ├─ collectInputs：goal + 待排 actions(含依赖/时长/优先级) + deadline + availability + 历史双窗口
  ├─ 无可用空档 → 返回 { blocked: "no-availability" }（前端引导设置可用时间）
  ├─ LLM Planner（lib/agent/planner-generator.ts，复用 llm-json 骨架）
  │    输出 Plan JSON：ordering（建议执行序）+ estimates（可微调工作量）+ weekly 提示 —— 不产时间
  ├─ 校验：依赖拓扑（环→去边）、action 属当前 goal
  ├─ Rule Scheduler（lib/service/planner-scheduler.ts，纯函数贪心）
  │    按 ordering 把每个待排 action 的总时长拆进未来 14 天可用空档（≤90min/段、不跨天、不重叠、跳过固定块）
  └─ 返回 { feasibility, weeks:[{date,start,end,actionId,title}], scheduledMinutes, remainingMinutes }
        │
        ▼
前端建议面板（预览：可行性结论 + 逐日时间表 + 未排完提示）
        │  用户点「接受计划」
        ▼
POST /api/goals/:id/plan/accept  { items:[…建议原样回传] }
  ├─ 服务端校验：每 item.action 属于该 goal/用户 且 status=pending（已 planned 跳过 = 幂等）
  ├─ 事务：insert schedules(source='action') + actions.status='planned'
  └─ 返回 { accepted, skipped }
        │
        ▼
POST /api/goals/:id/plan/reset        （可选，把该目标「计划中」schedules 清掉 + actions 回 pending）
```

**两份设计边界不变**：① LLM 只给「顺序/工作量/周投入建议」，精确 slot 由规则算法排（杜绝 19:00-20:30 与 20:00-21:30 冲突）；② accept 前零落库。

---

## 3. Rule Scheduler 算法（第一版 = 简单贪心，开发规范③）

输入：
- `actions`：待排阶段（status=pending），每项 `estimatedMinutes`（总投入，2a 语义）+ `priority` + 依赖已由 LLM ordering 或拓扑序确定先后
- `availability`：该用户模板（weekday 0=周一…6=周日，start/end）
- `fromDate`（今天 Asia/Shanghai）、窗口 = 未来 14 天

规则：
1. **候选空档** = 模板中 `title=''` 的行（011 语义：固定块=有 title，任何 type 都不可占用；`title=''` 视为可投入时间）。按 `weekday ∩ [fromDate, +13d]` 展开为当日区间。
2. **固定块** 只参与“跳过”，不落 schedule。
3. 贪心：按 `ordering`（LLM 给；回退=依赖拓扑序，同层按 priority 升序）逐个阶段填：
   - 阶段剩余分钟 `remain`，按日期升序找当天第一个足够 15 分钟的空档；
   - 一段 = `min(remain, 空档剩余, 90min)`，`end = start + 段`，写入 item 并把空档起点前移（同一天可多段但每段整点/半小时粒度，start/end 对齐到 5 分钟）；
   - 当天无空档 → 次日；14 天耗完仍有余量 → 该阶段标 `remaining>0`（预览提示「后续按此节奏续排」，P1 不自动续排）。
4. 输出 items 按 `(date, start)` 排序；同 action 一天允许多段（如两段 90 分钟 = 一次完整阶段拆解）。

**不做的优化（P1）**：全局最优、周末均匀、避免碎片化、availability 冲突重排 —— 全部留后，先跑通闭环（开发规范③）。

---

## 4. feasibility（纯规则，不依赖 LLM）

```
totalMinutes     = Σ 待排 action.estimated_minutes
remainingDays    = deadline - 今天（无 deadline → 以最近 90 天占位并提示）
requiredPerDay   = totalMinutes / remainingDays
shortTermPerDay  = Σ dailyMinutesSince(近7天).minutes / 7      （含 0 天，真实节奏）
longTermPerDay   = Σ dailyMinutesSince(近30天).minutes / 30
verdict          = 规则分档（示例）：
    requiredPerDay ≤ longTermPerDay×0.85        → "on-track"   「按你 30 天节奏可完成，保持即可」
    requiredPerDay ≤ longTermPerDay×1.15        → "tight"      「有压力，建议每周多投入一点」
    else                                          → "risk"      「按当前节奏会超期，建议缩小范围或加时」
message          = 组装中文一句话（含 7/30 天两个数 —— 双窗口，用户定稿 D5）
```
> 输入来自 `dailyMinutesSince(userId, dateMinusDays(today,6))` 与 `…(userId, dateMinusDays(today,29))` 两次调用（repo/stats.ts:32），无数据缺口。

---

## 5. 数据 / API 设计

### 5.1 复用 repo（无需新表 / 无新迁移）

| 新函数（lib/repo/planner.ts 追加） | 说明 |
|---|---|
| `acceptPlanTx(userId, items[], pendingActionIds[])` | 单事务：insert schedules（source='action'，复用 createSchedules SQL）+ 这些 action `status='planned'`；items 与 actions 归属校验前置在 service |
| `resetGoalPlanTx(userId, goalId)` | 单事务：删该 goal 下 **`source='action' and status='planned'`** 的 schedules（审核补充②：**绝不碰 `source='manual'`**）；对应 `action.status='planned'` → `'pending'`（不碰已完成/completed 的 schedule） |

### 5.2 新增 service

| service | 职责 |
|---|---|
| `lib/service/availability.ts` | `getAvailabilityView(userId)` / `saveAvailability(userId, items)`（校验 weekday 0-6、HH:MM 格式、end>start，title 默认 ''）→ repo replaceAvailability |
| `lib/service/planner.ts` | `generatePlan(userId, goalId)`（收集→LLM→scheduler→feasibility，不落库）/ `acceptPlan(userId, goalId, items)` / `resetPlan(userId, goalId)` |
| `lib/agent/planner-generator.ts` | Plan JSON：LLM 输出 `{ ordering:[title…], estimates:{title:min}, note }`（基于 context 里的待排阶段清单+依赖+双窗口统计）；失败 → 纯规则回退（拓扑序+priority） |
| `lib/service/planner-scheduler.ts` | §3 纯函数（无状态，独立单测） |

### 5.3 路由

```
GET  /api/availability                     → { items:[{weekday,startTime,endTime,type,title}] }
PUT  /api/availability  {items}            → 整组替换（复用 replaceAvailability 先删后插）
POST /api/goals/:id/plan                   → 预览 { feasibility, weeks[], remainingMinutes }
POST /api/goals/:id/plan/accept {items}    → { accepted, skipped }（幂等：已 planned 跳过）
POST /api/goals/:id/plan/reset             → { removedSchedules, resetActions }
```

---

## 6. 前端改动（page.tsx + globals.css，无新页面路由）

1. **可用时间设置卡**（计划地图页「本周可用时间」小卡，可折叠）：
   - 行 = 「周几 · HH:MM-HH:MM · 标签(可选)」+ 删除；
   - 「+ 添加空档」表单（weekday 多选、起止、标签可空；**标签留空 = 可排空档**，填了（如"上课/运动"）= 固定块只展示）；
   - 预设快捷按钮：「工作日 19:00-22:00 学习」一键添加；
   - 保存 → PUT /api/availability → 本地刷新。
2. **行动路线区块**：action.status='planned' 显示「**已安排**」（非『待安排』）；该 goal 有 pending 阶段时，区块尾部显示「**安排计划**」按钮；已有 planned 阶段时显示「**撤销安排**」按钮。
3. **计划建议弹层**（复用 quiz-overlay 的遮罩模式，避免 Goal 卡变成超级页面 —— 你早前担心的点）：
   - 顶部 feasibility：`总工作量 / 剩余天数 / 每天需 X 分钟` + 7/30 天实际投入 + verdict 文案；
   - 逐日时间表（未来 2 周）：`9月7日 周一 · 19:00-20:30 阅读相关论文`；
   - 尾部：剩余未排完阶段提示（若有）+「接受计划」按钮；无可用时间时仅显示引导 + 「去设置可用时间」按钮（滚到设置卡）。
   - 接受成功 → 关闭弹层 → refreshGoals()（planned 徽标）→ notify「已安排 N 个阶段」。
4. **undo 语义不动**：lastGenerate 只管「刚生成行动路线」的撤销；「撤销安排」是 reset 的独立按钮，与生成 undo 分开。

---

## 7. 需要用户拍板的决策点

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| P1 | 可排空档判据 | A 仅 `type='learn'`；B **`title=''` 即可排**（任何 type 无标签视为可投入；有 title=固定块只展示） | B —— 与 011 头注释一致，标签语义简单：填空=能学，填了=被占 |
| P2 | 排程窗口与单段上限 | 窗口 7 天 / 14 天 / 30 天；单段 ≤60/90/120min | **14 天 + ≤90min/段、不跨天**（预览可审核，段数可控）；剩余提示续排 |
| P3 | accept 幂等与撤销 | A 只防重（已 planned 跳过）不留撤销；B 防重 + 提供「撤销安排」reset | **B**：用户控制权优先；reset 只清计划中（planned）schedules，不碰已完成 |
| P4 | 建议面板位置 | A 卡片内展开（延续 2c）；B **弹层遮罩**（复用 quiz-overlay） | B：时间表信息量大，弹层不撑爆 Goal 卡；2c 已有遮罩样式可复用 |
| P5 | LLM 参与度（P1） | A LLM 必参与（ordering/estimates）；B LLM 失败静默回退规则 | 冻结设计既定 A+回退；**无可用空档时不调 LLM** 直接引导（省成本） |

---

## 8. 开发拆解（一次交付，含回归）

1. **8a 后端**：availability service + GET/PUT 路由；repo `acceptPlanTx`/`resetGoalPlanTx`；`planner-generator.ts`（Plan JSON LLM→回退）；`planner-scheduler.ts`（纯函数贪心，先给 30 行级单测：重叠/固定块跳过/跨天/余量标记）；`service/planner.ts`（generate/accept/reset）；3 个 plan 路由。验证：typecheck/lint + tsx 连库冒烟（构造 availability → generate 断言 items 不重叠且在空档内 → accept 落库 + action planned → 重复 accept skipped → reset 清空回 pending → 无 availability 引导分支）。
2. **8b 前端**：可用时间设置卡 + 安排计划按钮 + 建议弹层 + 接受/reset + planned 徽标文案；CSS。
3. **8c 回归**：tsc/lint/build；HTTP e2e 增补（availability PUT → plan → accept → GET /api/goals 见 planned → reset）；Step 2 全回归（生成/标记完成/undo/删目标级联）；**今日时间轴断言仍零变化**。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM ordering 破坏依赖 | 校验时拓扑重排：LLM ordering 若违反依赖 → 按依赖校正（依赖优先），仅在同层参考 LLM |
| 空档碎片/一天多段体验差 | P1 接受简单贪心（开发规范③）；预览可见，接受权在用户 |
| 重复 accept 产生重复 schedule | accept 前置校验 action.status：已 planned → skipped（幂等）+ 前端按钮防连点 |
| 无 deadline 目标 | remainingDays 用 90 天占位 + feasibility 文案注明「未设截止，按 90 天估算」 |
| 排程超窗口排不完 | remainingMinutes>0 → 预览明示「后续按此节奏续排」，不自动续（P1） |
| availability 误把学习时间设成固定块（title 填了） | 设置卡文案解释：标签=固定占用；误设导致空档不足时，预览/无空档分支给引导提示检查标签 |
| 历史「每天投入」语义是 records 分钟，非排程执行 | 明示：仅用于可行性节奏参考，不自动改可用时间（未来 Step5 再闭环校准） |

---

## 10. 一句话总结

Step 3 给「行动路线」配上**时间维度**：用户先声明每周可用时间 → Planner 只出「未来 2 周的排程建议」（可行性用 7/30 双窗口真实节奏校准，slot 由纯函数贪心保证不冲突不占固定块）→ 用户接受才落 `schedules`、把阶段推进到 planned → 随时可撤销安排。今日时间轴依然一行不动，等到 Step 4 才成为 schedule 的展示层。
