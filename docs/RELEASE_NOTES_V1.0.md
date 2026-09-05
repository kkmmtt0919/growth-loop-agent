# Release Notes — v1.0.0（2026-09-05）

> 成长回路（Growth Loop）首个对外可交付版本。定位：**Smart Planner v1**——把「今天做了什么」变成下一步行动的自我提升 Agent，Agent 负责理解、规划、排程、复盘，并把每次可验证的行动沉淀为成长轨迹。

## 相对 0.2.0-prototype 的主要变化

0.2.0-prototype 完成了「邮箱/密码 + PostgreSQL 持久化」的数据层闭环。v1.0.0 在此之上落地 **Smart Planner Agent 闭环 Step 1–7**，并从「可运行的本地原型」推进到「单机可部署的 MVP」。

### 核心闭环（Step 1–6）

- **目标 → 行动路线**：Goal 真实 CRUD；AI 一键把目标分解为可执行 Action（LLM 缺失时规则回退，含步骤校验与图可达性检查）。
- **排程引擎（Planner）**：可用时间 → 零落库预览 → 确认后排进今日时间轴；每次排程参考近期反思与当日执行情况校准。
- **执行打卡**：按排程执行、记录实际时长/备注；Schedule 完成≠Action 完成，只有 Execution 打卡才推动成长；overdue 懒计算。
- **复盘与周报**：晚间晚报（21:30，上海时区可配 `REPORT_TIME`）+ Weekly 双轨统计（计划 vs 实际 + 达成率）+ 成长页 7 天趋势。
- **反思反馈（Reflection）**：目标级认可/有压力反馈 + 历史列表，作为参考注入下一次 Planner。
- **Agent 可观测（Trace）**：每次 LLM 调用记录类型/版本/耗时/成败；只读 API 刻意裁剪，不含明文输入输出。
- **离线评测（Eval）**：69 个确定性断言覆盖目标分解/排程/周报/理解/晚报，不依赖 LLM，可快速回归。

### 产品化与工程交付（Step 7）

- 首次体验引导：新账号从空开始，计划页三步引导（建目标 → AI 行动路线 → 排进每天）。
- Docker Compose 一键部署（app + PostgreSQL 16）；`npm run db:setup` 幂等迁移 001–015（`schema_migrations` 记录、单文件事务、legacy 库保护）。
- env 预检（`check-env.mjs` dev/prod）；README 全面重写对齐 Smart Planner v1。

## 数据与迁移

- 15 个标准 PostgreSQL 迁移（`supabase/migrations/001_init.sql … 015_agent_runs.sql`），不依赖任何 Supabase 专有能力。
- 一键应用：`npm run db:setup`（幂等可重跑）。云托管迁移只需更换 `DATABASE_URL`。

## 验证证据

| 项 | 结果 |
|---|---|
| `npm run typecheck` / `lint` / `build` | 全部通过（构建 34/34 页面） |
| `npm run eval` | 69/69 通过 |
| Docker 实测（7a） | 空库 15/15 applied + 幂等重跑；容器内 register/me/goal 全通 |
| 链路 e2e | reflection-http-e2e 7/7、agent-runs-http-e2e 10/10 等脚本位于 `scripts/` |

代码基线：`main@6923d06`（Step6 三连 `9d261b1/261aff5/d6c25fc` + PHASE8 归档 `a3fe21b` + Step7 三连 `3498bef/f1dc97d/6923d06`）。

## 已知边界（暂不在此版本交付）

- **无账号体系外通道**：仅邮箱/密码；微信登录、小程序不做。
- 微信公众号为实验模块：仅服务端明文文本回调（非登录/支付），正式对外前需补加密回调、重放保护、限流与审计。
- Android APK 为 debug 签名壳（Capacitor），非商店发布形态。
- 不包含 CI/CD、监控平台、K8s/Serverless/云厂商部署模板；数据层已按标准 PG 编写，正式上云仅需替换 `DATABASE_URL`（如腾讯云 PG）。
- 生产环境建议：`ENABLE_DEMO_SEED=false`、配置真实 `LLM_PROVIDER`、由外部 Cron 用 `CRON_SECRET` 触发晚报。

## 运行

见 [README](../README.md)：本地 demo（无需数据库）、本地完整模式、Docker Compose 三种启动路径。
