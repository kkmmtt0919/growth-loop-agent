# 成长回路（Growth Loop）

把「今天做了什么」变成下一步行动的自我提升 Agent。用户用一句话告诉 AI 今天的学习、运动、生活与休息；Agent 负责理解、出行动路线、排进日程、复盘反馈，并把每一次可验证的行动沉淀成成长轨迹——形成一个 **Goal → Action → Schedule → Execution → Review → Reflection** 的完整回路（Smart Planner v1）。

> 当前为单机可部署的 MVP：Next.js Web + 标准 PostgreSQL + OpenAI-compatible LLM（可无 Key 运行，规则回退保证全流程可用）。Docker Compose 一键起服务。Android 壳与微信公众号属于仓库内的实验模块，不是主链路。

## 核心能力

| 能力 | 当前实现 | 入口 |
|---|---|---|
| 账号与持久化 | 邮箱/密码（bcrypt）+ JWT 会话（7 天）；数据层为**标准 PostgreSQL**，RLS 全开 + 服务端连接；注册可选播种演示数据 | `/api/auth/*` |
| 目标（Goal） | 真实 CRUD：目标 → 进度派生、防重复、删除语义 | `/api/goals`、计划页 |
| 行动路线（Action） | 手动添加或 **AI 一键分解**目标 → 可执行行动；带步骤校验与图可达性检查 | `/api/actions`、`/api/chat` |
| AI 对话 | 实时对话 + 三层记忆 + 意图识别；客户端幂等（`client_msg_id`）+ 限流；**LLM 缺失时规则回退** | `/api/chat`、`/api/agent`、今日页 |
| Smart Planner 排程 | 可用时间（Availability）→ **零落库预览** → 确认 → 排进今日时间轴；每次参考近期反思与当日执行情况校准 | `/api/availability`、`/api/schedules` |
| 执行打卡 | 按排程执行并记录实际时长/备注；懒计算是否逾期 | `/api/executions` |
| 记录与账本 | 学习/运动/生活/休息记录（mood/remark）→ XP/Coin 幂等结算（DB 唯一约束 + `ON CONFLICT`） | `/api/records`、`/api/tasks` |
| 晚间复盘 | Agent Context（目标/任务/记录/7 天统计/当日执行）→ 结构化晚报（达成/阻碍/建议/评分）；本地懒触发 + 生产 Cron 入口 | `/api/evening-report`、首页晚报卡 |
| 周报与成长仪表盘 | Weekly 双轨统计（计划 vs 实际 + 达成率）；成长页 7 天趋势/复盘/反馈/AI 运行记录 | `/api/weekly`、`/api/growth`、成长页 |
| 反思反馈（Reflection） | 目标级快捷反馈（认可/有压力）+ 历史列表；**作为参考注入下一次 Planner** | `/api/reflections`、计划页 |
| Agent 可观测（Trace） | 每次 LLM 调用记录类型/版本/耗时/成败，只读摘要，**不含明文输入输出** | `/api/agent-runs`、成长页折叠 |
| 理解测验 | 学习记录 → 生成 2–3 题 → LLM 或规则评分 → XP 回写 | `/api/quiz` |
| 首次体验引导 | 新账号（无目标）在计划页看到三步引导卡：建目标 → AI 行动路线 → 排进每天 | 计划页空态 |
| 部署 | Docker Compose（app + PostgreSQL 16）+ `db:setup` 幂等迁移 001–015 + env 预检 | `Dockerfile`、`docker-compose.yml` |

## Agent 闭环

一次完整的「回路」长这样：

```mermaid
flowchart TD
  U[用户一句话记录/对话] --> A[Agent 理解]
  A --> G[Goal 目标]
  G -->|AI 分解| AC[Action 行动池]
  AC -->|Planner 参考可用时间+近期反思| PV[Preview 预览 零落库]
  PV -->|Accept| SC[Schedule 今日时间轴]
  SC --> EX[Execution 执行打卡 实际时长]
  EX --> ST[Stats 双轨: 计划 vs 实际]
  ST --> W[晚间复盘 21:30]
  ST --> K[Weekly 周报 + 达成率]
  G -.目标页随时反馈.-> R[Reflection 认可/有压力]
  R -. 作为参考注入下一轮 Planner .-> A
```

设计要点（对应各阶段设计文档，见文末文档地图）：

- **排程不等于完成**：Schedule 完成不自动推进 Action/Goal；只有 Execution 打卡才入账、才推动成长。
- **Execution 自动生成**（`schedule_id` 唯一），实际时长可改；overdue 一律懒计算。
- **Preview 零落库**：Planner 预览确认前不写任何数据，Accept 才落 Schedule。
- **数据层隔离**：Repo 层所有 SQL 显式带 `user_id`；Service 只处理已通过 JWT 校验的用户身份。

## 技术栈

| 层 | 选型 |
|---|---|
| Web 框架 | Next.js 16.3（App Router）+ React 19.2 + TypeScript strict |
| 数据层 | PostgreSQL（标准 SQL，不依赖任何 Supabase 专有能力）+ `pg` 驱动 + 参数化查询 |
| 鉴权 | bcryptjs 密码哈希 + jose JWT（`JWT_SECRET` 签发，7 天有效） |
| LLM 接入 | OpenAI-compatible `/chat/completions`；支持 `demo / openai / deepseek / glm`，可缺省（规则回退） |
| 规则内核 | `lib/agent/core/pure.ts` 确定性规则（离线可测） |
| 部署 | Docker multi-stage（node:22-alpine）+ Compose（postgres:16-alpine） |
| 移动壳（实验） | Capacitor 8 Android（指向远程 Next 服务） |

架构分层（自上而下单向依赖）：

```mermaid
flowchart LR
  subgraph C[客户端]
    Web[Web App]
    Android[Android 壳 实验]
  end
  C -->|HTTPS/JSON + Bearer JWT| API[API Routes app/api]
  API --> AUTH[JWT 校验中间层]
  AUTH --> SV[Service 层 lib/service<br/>业务与权限, 只收已验证 userId]
  SV --> RP[Repo 层 lib/repo<br/>参数化 SQL, 全部带 user_id]
  RP --> PG[(PostgreSQL)]
  API -.可选.-> LLM[OpenAI-compatible LLM<br/>缺失时规则回退 lib/agent/core/pure.ts]
```

迁移到云托管 PostgreSQL（如腾讯云）只需更换 `DATABASE_URL`，业务代码零改动。

## 快速开始

环境要求：Node.js 22+、npm；Docker 部署需要 Docker（含 Compose 插件）。

### 方式 A：本地 demo（无需数据库，最快看效果）

```bash
git clone https://github.com/kkmmtt0919/growth-loop-agent.git
cd growth-loop-agent
npm install
cp .env.example .env.local
npm run dev
```

打开 <http://127.0.0.1:3000>。默认 `LLM_PROVIDER=demo`、未配置 `DATABASE_URL`，页面直接使用内置确定性演示数据与规则回退，**不需要 API Key**。此模式无账号体系、数据不落库。

生产式本地回归：

```bash
npm run build
npm run start -- --hostname 127.0.0.1 --port 3000
```

### 方式 B：本地完整模式（邮箱/密码 + PostgreSQL 持久化）

1. 准备一个 PostgreSQL（本地 Docker、Supabase 或腾讯云均可）。
2. `.env.local` 填入 `DATABASE_URL` 与 `JWT_SECRET`（生成：`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`）。
3. 应用数据库迁移（幂等，可重复执行）：

```bash
npm run db:setup        # 读取 .env.local 的 DATABASE_URL，按文件名顺序应用 supabase/migrations/*.sql
npm run db:check        # 连接诊断
```

4. 启动并注册账号体验：注册默认播种一套演示目标/任务（`ENABLE_DEMO_SEED=false` 可关闭，见下）。

### 方式 C：Docker Compose 一键（app + PostgreSQL）

```bash
cp .env.example .env    # 不填 DATABASE_URL 也行：compose 默认连内置 db
docker compose up -d --build
docker compose exec app npm run db:setup   # 显式应用迁移（不自动执行，避免生产误启改库）
```

打开 <http://localhost:3000>。`db` 服务映射本机 `5432`；如需连接内置库，宿主侧用 `postgresql://gl:gl_dev_pw@127.0.0.1:5432/growth_loop`。

**生产切换**：把 `.env` 的 `DATABASE_URL` 指向外部托管 PG，并注释掉 `docker-compose.yml` 里的 `db` 服务与其 `depends_on`（见文件头注释）。

## 环境变量

模板见 [.env.example](.env.example)，部署前可跑 `node scripts/check-env.mjs prod` 预检。

| 变量 | Demo | 生产 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 留空 = demo 模式 | **必填** | PostgreSQL 连接串；Docker 场景由 compose 覆盖为内置库 |
| `JWT_SECRET` | 有 DB 时必填 | **必填** | 长随机串，签名会话 |
| `CRON_SECRET` | 可选 | **必填** | 外部 Cron/SCF 调 `POST /api/evening-report` 的系统凭据 |
| `LLM_PROVIDER` | `demo` | `openai`/`deepseek`/`glm` | 见下 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 可空 | 建议填 | 通用 OpenAI-compatible 参数 |
| `DEEPSEEK_*`/`OPENAI_*`/`GLM_*` | 可空 | 可选 | 按 provider 读取对应变量 |
| `REPORT_TIME` | 可空 | 可空 | 晚报生成时刻 `HH:MM`，默认 `21:30`（上海时区） |
| `ENABLE_DEMO_SEED` | `true` | `false` | 注册时是否播种演示数据；生产关掉让新用户从空开始走引导 |
| `WECHAT_APP_ID/SECRET/TOKEN/ENCODING_AES_KEY` | 留空 | 可选 | 微信公众号实验模块专用 |

> 不配置 LLM 时，对话/排程/复盘/出题全部走**规则回退**，功能不阻塞，仅回答质量降级；`GET /api/agent` 返回非敏感配置状态。

## 数据库迁移

- 全部迁移：`supabase/migrations/001_init.sql … 015_agent_runs.sql`（15 个，均为标准 PostgreSQL）。
- 一键应用：`npm run db:setup` —— 扫描目录按文件名顺序执行，用 `schema_migrations` 表记录已应用文件，**幂等可重跑**（跳过已应用）；每个文件包在单事务里，失败即回滚该文件不影响其他。
- 连接诊断：`npm run db:check`。
- 历史单文件工具：`scripts/run-migration.mjs`（可指定单个迁移文件）。

## 验证命令

```bash
npm run typecheck   # TS strict 全量检查
npm run lint        # ESLint
npm run build       # Next 生产构建
npm run eval        # Agent 离线评测：69/69 确定性规则（目标分解/排程/周报/理解/晚报）
npm run env:check   # env 预检（dev/prod）
```

`npm run eval` 覆盖 `lib/agent/core/pure.ts` 的确定性判定：行动步骤校验、图可达性、排程环检测、deadline-aware、周报字段对齐等——**不依赖 LLM，任何一次改动后都能快速回归**。服务端链路冒烟/端到端脚本集中在 [scripts/](scripts/)（`*-smoke.ts`、`*-http-e2e.mjs`、`e2e-*.sh`），浏览器验收主路径见 [docs/DEVELOPER_HANDBOOK.md](docs/DEVELOPER_HANDBOOK.md)。

## Demo / 使用流程

**演示模式**（无 `DATABASE_URL`）：打开首页即见内置演示数据，可体验 AI 对话与今日/计划/记录各页面（无账号、数据不落库）。要体验完整的「排程→打卡→复盘→反馈」闭环，请进入完整模式。

**完整模式**（登录后）建议按此顺序体验一次「回路」：

1. **注册登录** → 创建第一个目标（无目标时计划页出现三步引导卡）。
2. 在目标详情点 **AI 制定行动路线**（或手动添加行动）。
3. 设置每周可用时间（Availability）。
4. 生成 **Planner 预览**（不落库）→ 确认后排进今日时间轴。
5. 按时间轴**执行打卡**（可填实际时长/备注）。
6. 目标页给 **AI 反馈**（认可/有压力/一句话）——下次排程会参考。
7. 21:30 自动生成**晚间晚报**；周日在成长页看 **Weekly 双轨周报**与 7 天趋势。
8. 成长页底部展开 **AI 运行记录**：查看每次 Agent 调用的类型/版本/耗时/成败。

## 实验模块

- **微信公众号**：服务端明文回调 + 签名校验 + 规则回退，非登录/支付。配置与边界见 [docs/WECHAT_INTEGRATION.md](docs/WECHAT_INTEGRATION.md)。正式对外前需补加密回调、重放保护、限流与审计。
- **Android 壳**：Capacitor 8，独立移动壳，页面指向远程 Next 服务。构建与调试见 [docs/ANDROID_BUILD.md](docs/ANDROID_BUILD.md)、[docs/ANDROID_APK_DEBUG_AI.md](docs/ANDROID_APK_DEBUG_AI.md)，移动端交互约束见 [docs/ANDROID_MOBILE_PRODUCT_DESIGN.md](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md)。

## 文档地图

| 文档 | 内容 |
|---|---|
| [Smart Planner 总设计](docs/DESIGN_SMART_PLANNER_V1.md) | 产品闭环、Step 1–5 设计（Goal→Action→Planner→Schedule→Execution→Weekly） |
| [Step 6：Reflection + Trace + Eval](docs/DESIGN_SMART_PLANNER_STEP6.md) | 反思反馈注入、LLM 调用链路追踪、离线评测体系 |
| [Step 7：部署与可交付性](docs/DESIGN_SMART_PLANNER_STEP7.md) | Docker、首次体验引导、Agent 观测、README 重写 |
| [开发者与 AI 手册](docs/DEVELOPER_HANDBOOK.md) | clone 到发布的完整交接手册 |
| [网页服务配置](docs/WEB_SERVICE_SETUP.md) | 干净 clone、环境变量、Web/Node 服务验收与地址边界 |
| [0.3.0 Roadmap](docs/ROADMAP_0.3.0.md) | MVP 范围与分阶段路线 |
| 各阶段设计 | [Agent 晚间](docs/DESIGN_PHASE2_3_AGENT_EVENING.md)、[记录](docs/DESIGN_PHASE4_RECORDS.md)、[周报](docs/DESIGN_PHASE5_WEEKLY.md)、[Eval](docs/DESIGN_PHASE6_EVAL.md)、[聊天面板](docs/DESIGN_CHAT_PANEL_V1.md) 等 |
| 归档 | 过期设计稿已移入 [docs/archive/](docs/archive/) |

## 数据、安全与边界

- **无数据库 = demo 原型**；配置 `DATABASE_URL` 才启用真实持久化与账号。
- 四层架构：API Route → Service（业务/权限）→ Repo（`pg` + 参数化 SQL，显式 `user_id`）→ 标准 PostgreSQL。**不依赖 Supabase 专有能力**，云迁移只换 `DATABASE_URL`。
- 密码 bcrypt 哈希；会话 JWT 7 天有效；RLS 在 public 表全开、零策略（服务端连接直通，属 MVP 过渡形态）。
- 任务/XP/Coin 等写操作由受控服务端 + 幂等账本完成（`idempotency_key` 唯一约束 + `INSERT … ON CONFLICT`）；LLM 永不直接写库。
- 微信回调仅支持明文文本；Android APK 为 debug 签名；两者正式发布前需补齐加密/签名/合规（详见各自文档）。
- 不要提交 `.env.local`、`.env`、API Key、`android/local.properties`、构建产物与密钥。

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面能开但登录不可用 | 缺 `DATABASE_URL`/`JWT_SECRET`；demo 模式无账号体系属预期 |
| 打开页面只有内置演示数据 | 同上，属 demo 模式；配好 DB 并 `db:setup` 后重启即切换 |
| 新建账号就有目标 | 注册播种所致：`.env.local` 设 `ENABLE_DEMO_SEED=false` |
| 对话只有规则回复 | LLM 未配置或 Key 无效：`GET /api/agent` 看状态，属降级预期 |
| `docker compose up` 后 3000 被占 | 本机已有服务占用 3000；停掉后重试或改 compose 端口映射 |
| 内置 db 起不来/端口 5432 冲突 | 本机已有 PG 占用 5432；改用外部 `DATABASE_URL` 并注释 db 服务 |

## 贡献与提交

1. 从 `main` 创建短分支；改动前阅读 `AGENTS.md`（Next.js 16.3 有破坏性变更）与相关设计文档。
2. 只提交本次任务范围内的文件；密钥/构建产物/模拟器缓存一律排除。
3. 至少通过 `typecheck`、`lint`、`build`、`eval`；改动涉及链路时补跑对应 `scripts/*-smoke.ts` 或 `*-http-e2e.mjs`。
4. 提交信息说明意图；大改动按功能拆多个 commit 便于回滚。

## 当前状态

Smart Planner Step 1–7 已实现（Agent 闭环 + 反思注入 + Trace + Eval 69/69 + Docker 部署 + 首次体验引导 + 观测页），正处于 Step 7 收尾与 release review 阶段。数据库迁移总数 15；版本标签随 release review 定版。
