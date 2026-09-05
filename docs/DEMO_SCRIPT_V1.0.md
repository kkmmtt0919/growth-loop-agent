# v1.0.0 Demo 脚本

> 目标：约 30 分钟，用一台新环境走通「部署 → 完整回路 → 后台验证」，可讲可演。配套 [Release Notes](RELEASE_NOTES_V1.0.md) 与 [README](../README.md)。
>
> 演示前提：Docker（含 Compose）、Node.js 22+、一个可用的 PostgreSQL（本地 Docker / Supabase / 腾讯云均可；本脚本用 Docker 内置库）。

## 0. 定位一句话（开场引导词）

> 「用户把今天做了什么告诉 AI，AI 会把它变成一条可执行、可打卡、可复盘的成长回路——这是一个人工智能驱动的 Smart Planner。」

## 1. 部署演示（约 8 分钟）

```bash
git clone https://github.com/kkmmtt0919/growth-loop-agent.git
cd growth-loop-agent
cp .env.example .env        # 不填 DATABASE_URL：compose 默认连内置库
docker compose up -d --build
docker compose exec app npm run db:setup   # 幂等迁移 001-015
```

**讲点**：迁移不自动执行（避免生产误启改库）；`db:setup` 用 `schema_migrations` 记录已应用文件，重跑会跳过；`.env` 填外部 `DATABASE_URL` 即切换托管 PG。

**验收动作**：
- 打开 http://localhost:3000 → 首页出现（demo 模式，无账号）。
- 重跑一次 `docker compose exec app npm run db:setup` → 提示已全部应用（幂等）。

## 2. 完整回路演示（约 15 分钟）

> 需完整模式（账号 + DB）。本地非 Docker 时：`.env.local` 填 `DATABASE_URL` + `JWT_SECRET`，`npm run db:setup` 后 `npm run dev`。

| 步 | 操作 | 预期 |
|---|---|---|
| 1 | 注册账号（邮箱/密码/昵称） | 登录进入，欢迎 XP；若 `ENABLE_DEMO_SEED=false` 则从空开始 |
| 2 | 计划页点「从一个目标开始」，建一个目标（如「30 天掌握 TypeScript」） | 计划页出现目标卡 |
| 3 | 目标卡上点「AI 制定行动路线」 | 生成可执行 Action 列表（LLM 缺失时走规则） |
| 4 | 设置每周可用时间（Availability） | 时间表保存成功 |
| 5 | 生成 Planner 预览 | 预览不落库，可调整 |
| 6 | 确认排程 | 今日时间轴出现排好的时段 |
| 7 | 到点执行打卡（填实际时长/备注） | 执行记录落库，进度推进 |
| 8 | 目标卡给 AI 反馈（认可/有压力/一句话） | 反馈入库，作为下次排程参考 |
| 9 | 触发一次晚间复盘（`POST /api/evening-report`，带 `CRON_SECRET` 或等 21:30） | 生成结构化晚报（达成/阻碍/建议/评分） |
| 10 | 成长页看趋势 + 底部展开「AI 运行记录」 | 每次 Agent 调用类型/版本/耗时/成败可见（无明文） |

**讲点**：Preview 零落库（确认才写）；Schedule 完成≠Action 完成（只有 Execution 打卡才推动成长）；Reflection 反馈注入下一轮 Planner；Agent Trace 字段刻意裁剪隐私。

## 3. 后台验证命令（约 5 分钟）

```bash
npm run typecheck          # TS strict
npm run lint               # ESLint
npm run eval               # 69/69 确定性规则（不依赖 LLM）
npm run env:check          # env 预检（dev/prod）
npm run db:check           # DB 连接诊断
node scripts/check-env.mjs prod   # 生产 4 键预检
```

可选链路回归（需本地服务 + DB）：

```bash
npx tsx scripts/reflection-smoke.ts        # 反思链路
npx tsx scripts/trace-smoke.ts             # LLM trace 落库
npx tsx scripts/execution-smoke.ts         # 执行打卡
node scripts/agent-runs-http-e2e.mjs       # agent-runs API（10 项）
node scripts/reflection-http-e2e.mjs       # reflection API（7 项）
```

> 浏览器人工验收项（未自动化）：引导卡出现条件、时间轴交互、成长页折叠面板视觉。

## 4. 结束语（可讲）

> v1.0.0 的完整回路已经闭环：目标 → 行动路线 → 排程 → 打卡 → 复盘 → 反馈 → 参考校准；下一步只需把它接到真实托管的 PostgreSQL 与生产 LLM Key 上即可上线。
