# 0.3.0 MVP 开发路线图

> 日期：2026-08-24
> 状态：**已完成（2026-09-05）**——0.3.0 规划目标经 Smart Planner Step 1–7 全部落地，随 **v1.0.0** 发布（见 [RELEASE_NOTES_V1.0.md](RELEASE_NOTES_V1.0.md)）。本文档保留为历史规划。
> 定位：从 0.2.0 原型 → 0.3.0 产品化闭环（不是从零搭 MVP，是把已有能力串起来）

## 1. 版本目标

> **0.3.0 MVP：一个用户注册后，可以真实创建自己的成长目标，AI 根据用户行为持续分析，每晚生成个性化晚报，并形成长期成长反馈闭环。**

数据闭环：

```
目标 Goal → 任务 Task → 每日记录 Record → AI 分析 Agent → 晚报 Report → 成长总结 Growth → 用户调整 Goal
```

## 2. 范围

### 做
- ✅ Goal 真实 CRUD（计划地图真实化，消灭 demoSeed）
- ✅ Task 真实 CRUD（含目标拆解、防重复）
- ✅ Record 查询完善（复用 records 表）
- ✅ Agent Context Layer（目标/任务/记录/历史完成率 → LLM → 结构化输出）
- ✅ 晚报自动调度（node-cron，REPORT_TIME 可配置）
- ✅ 周成长报告（统计 + AI 总结，改 Goal 需用户确认）
- ✅ Agent 评测集、错误处理
- ✅ 删除账号（最小合规版）

### 不做（后续版本）
- ❌ 微信登录 / 订阅提醒
- ❌ 小程序
- ❌ Android 发布
- ❌ 腾讯云迁移（Supabase 托管 PG 够 MVP 用）
- ❌ 运营后台 / 商业化
- ❌ 复杂权限系统

## 3. 开发顺序（用户最终版，勿改）

| 序 | 阶段 | 要点 | 依赖 |
|---|---|---|---|
| 1 | **计划地图真实化** | migration 004 加列；Goal/Task CRUD API；桌面+移动壳去 demoSeed；拆任务落库+防重复；派生进度 | 无 |
| 2 | **Agent Context Layer**（核心） | Context Builder（目标/任务/今日记录/7 天完成率/历史晚报）→ Prompt → LLM → Schema 校验 → 落库；结构化输出 summary/achievement/problem/suggestion/evaluation（score 不参与业务） | 阶段 1 |
| 3 | **晚报自动生成调度** | node-cron + REPORT_TIME=21:30；复用既有生成接口/幂等/evening_reports/CRON_SECRET；晚报 = Agent Context 第一个落地场景，与阶段 2 绑定开发 | 阶段 2 |
| 4 | **记录查询完善** | records 加 mood/remark 列；GET /records/today\|history\|week；completion_rate 派生不存 | 阶段 1 |
| 5 | **周成长报告** | weekly_reports 表；7 天统计（目标推进/完成率/连续天数/行为变化）+ AI 总结；AI 建议调整 Goal → 用户确认 → 才改 | 阶段 2-4 |
| 6 | **Agent 评测** | 意图/抽取/晚报质量离线集；schema 失败/空上下文/超时处理 | 阶段 2-3 |
| 7 | **数据删除** | DELETE /user（级联删业务数据）；导出推迟 | 阶段 1 |

## 4. 关键技术约定（红线）

- **不新建表**：goals/tasks/records/evening_reports 均为既有表，migration 增量加列（004 起），每个 migration 对应一个阶段验收。
- **goals.status 保留中文枚举**（进行中/待复盘/已归档）；Service 层用 `GOAL_STATUS`/`TASK_STATUS` 常量，不散落中文。
- **progress 是 legacy cache**：事实来源是 tasks.status，业务代码禁止写 progress 列；API 返回派生 progress/taskCount/doneCount。
- **任务状态变化唯一通道 = PATCH /api/tasks**（幂等结算/冲正账本）；PUT 只改元数据，拒绝 status/xp/coin。
- **DELETE task 不冲正账本**（产品设计 §6.5）；DELETE goal 事务内先置空关联任务 goal_id 再删。
- **修改长期目标必须用户确认**（产品设计 §7.2）：周报只能给建议，不能自动改 Goal。
- **调度用 node-cron**（Next.js/TS 栈，不用 Spring）；只适合常驻进程部署，CRON_SECRET 系统模式接口保留供外部定时器。
- **多用户隔离**：所有 repo SQL 显式 user_id；按 id 操作一律 id + user_id 双条件（跨用户返回 404）。
- 架构四层（API→Service→Repo→PG）不变；后续接小程序只需新增客户端，不推翻核心架构。

## 5. 最终 MVP 验收标准

**Day 1**：注册 → 创建目标 → 拆任务 → 记录今天
**Day 2-7**：每天完成任务 + 填写记录
**Day 7**：系统生成每日晚报 + 周成长总结

验收通过后展示口径：
> 本项目实现了一个基于 LLM Agent 的个人成长闭环系统，通过用户目标、任务执行和行为记录构建上下文，自动生成每日反馈和阶段性成长建议。

## 6. 阶段文档

| 文档 | 说明 |
|---|---|
| `docs/DESIGN_PHASE1_PLAN_REAL.md` | Phase 1 设计稿 v2（正式基线，已通过） |
| `docs/ROADMAP_0.3.0.md` | 本文件（总路线） |

## 7. 变更记录

- 2026-08-24｜定稿 0.3.0 范围与 7 阶段顺序（用户审核确认）；Phase 1 设计稿 v1 → v2 通过（修改项：start/end 可空、移动壳范围表述、CRUD 隔离显式化、拆任务防重复）；落本路线图。
