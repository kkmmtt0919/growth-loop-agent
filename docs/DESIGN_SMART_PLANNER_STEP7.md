# Step 7「产品化收尾」设计方案 v1

> 日期：2026-09-05
> 状态：**已审核冻结（用户 2026-09-05 批复，微调见 §10 审核记录）**
> 前置：Step 6 已归档（`d6c25fc`，Smart Planner v1.0 Agent Loop 完整闭环）
> 定位：**工程版本冻结后的产品化收尾**。目标不是加功能，而是把「一个能跑的工程」变成「clone 下来能跑、demo 一遍能讲清、别人能看懂」的可展示产品。

---

## §1 现状摸底（2026-09-05 核对结论）

| 维度 | 现状 | 缺口判断 |
|---|---|---|
| README | 263 行，内容停在 v0.3.0 早期：clone URL 指向 **upstream**（`redmaplewww`）；快速开始只提到 migration 001/002（实际已有 **015**）；能力表无 Smart Planner/Reflection/Eval | ❌ 明显过期，需重写 |
| 环境管理 | `.env.example` 12 键齐全（LLM×4 + DATABASE_URL + JWT_SECRET + CRON_SECRET + ENABLE_DEMO_SEED + WECHAT×4）；`.env.local` 另有 `DB_POOL_SIZE`、`USE_SUPABASE_AUTH` 未入 example | ⚠️ `.env.example` 缺 2 键 |
| LLM 接入 | `lib/agent/provider.ts`：demo 缺省；openai/deepseek/glm 三类，BASE_URL/API_KEY/MODEL 按 provider 前缀；对话 Agent 与晚报/周报/planner 共用 readConfig | ✅ 已抽象良好 |
| 调度器 | `instrumentation.ts` 挂 `startEveningScheduler`（**setInterval 常驻进程**，MVP）；`runDailyEveningScheduler()` 独立可调用；`/api/evening-report` POST 已支持双模式（用户 JWT / CRON_SECRET 系统触发，body userId） | ⚠️ **serverless 部署需外部 Cron 触发**，MVP 常驻调度在无状态托管上不生效 |
| 数据库 | 15 个 migration（001-015）流水线齐整；`scripts/db-check.mjs`、`scripts/run-migration.mjs` 已有 | ✅ 只缺「一键应用全部迁移」收口 |
| Docker / CI | **无 Dockerfile、无 docker-compose、无 .github/workflows、无 vercel/netlify/fly/render 配置** | ❌ 部署足迹为零 |
| 测试资产 | smoke×15 + http-e2e×8 + eval 69/69 + RLS check | ✅ 充足，可作为 CI 存量 |
| Demo 主流程 | 代码闭环完整；demo 模式（ENABLE_DEMO_SEED）有确定性 seed；但 PlanPanel 在 demo 模式无 actions → 无法一键演示 Planner 链路 | ⚠️ Demo 引导需补齐 |
| 版本 | Next 16.3.0；Node ≥22（README 已声明）；依赖极简（next/react/pg/jose/bcryptjs/lucide-react/capacitor） | ✅ 可 Docker 化 |

---

## §2 范围冻结

**做**：7a 一键部署（Docker + env 整理 + migration 一键 + README）；7b Demo 主流程打磨（3 分钟闭环演示路径）；7c Agent 可观测性（只读轻量页，非后台）；7d 文档（README 重写 + Agent Flow 图）。

**不做**：后台管理系统、Eval dashboard、Trace 可视化、权限/RBAC 扩展、监控告警体系、CI 流水线（YAGNI，文档给出配方即可）、微信/支付/商业化。

> 7c 底线：**只读** + **不引入图表库**（用现有 CSS/表格）+ 复用 agent_runs 存量数据。任何「管理操作」都不做。

---

## §3 7a 部署收口

### 3.1 交付物

| # | 改动 | 说明 |
|---|---|---|
| 1 | `Dockerfile` | multi-stage：`node:22-alpine` build（next build）→ runner（next start）。含 `NODE_OPTIONS=` 规避 build 脚本兼容（沿用项目已知做法） |
| 2 | `docker-compose.yml` | 两个服务：`app`（build .，端口 3000）+ `db`（postgres:16-alpine，volume 持久化）。**migration 不自动执行**（见 D8 决策），由 `npm run db:setup` 显式跑 |
| 3 | `scripts/setup-db.mjs`（新增）+ `npm run db:setup` | 顺序执行 `supabase/migrations/*.sql` 全部未应用迁移（复用 run-migration 的 pg 逻辑做目录扫描 + 记录 applied 表），幂等可重跑 |
| 4 | `.env.example` | 重构为带分节注释模板：头部总说明 + 部署必填 4 键（DATABASE_URL/JWT_SECRET/CRON_SECRET/LLM_API_KEY）。**不补 `DB_POOL_SIZE`/`USE_SUPABASE_AUTH`**（核对发现二者在 .env.local 存在但代码零引用，属僵尸键，不进模板以免误导部署者） |
| 5 | `scripts/check-env.mjs`（新增） | 启动前校验：mode=dev 需 DATABASE_URL+JWT_SECRET；mode=prod 额外需 CRON_SECRET + LLM 配置（无 LLM 则警告降级规则回退） |
| 6 | README「部署」节 | 见 7d |

### 3.2 部署模式（决策表，需用户拍板）

| | 模式 A：单机 Docker（推荐初版） | 模式 B：VPS + PM2 裸跑 | 模式 C：托管 serverless |
|---|---|---|---|
| 形态 | compose 起 app+db | 手动 psql 建库 + `next start` | Vercel/Fly + 外部 PG |
| 调度 | 容器内常驻进程 | 常驻进程 | **必须外部 Cron** 打 `/api/evening-report`（CRON_SECRET） |
| 迁移 | `docker compose up` 后显式 `npm run db:setup`（两步） | run-migration 手动 | 需迁移 CI 或手动 |
| 适配国内 | 云服务器任意（腾讯云/阿里云轻量） | 同左 | Vercel 被墙风险 |
| 复杂度 | 中（需 Docker） | 低 | 中高（重构调度挂载点） |

> 推荐 **A**：与「常驻调度 + 标准 PG + 任意云服务器」匹配度最高；A/B 迁移到腾讯云只换 DATABASE_URL。C 留作文档备选（当前 instrumentation 注释已预留 CRON_SECRET 外部触发语义）。
> **D8（审核新增决策）：migration 不做容器 entrypoint 自动执行**——`docker compose up` 与 `npm run db:setup` 明确两步。原因：001-015 已有 run-migration，entrypoint 自动改库开发体验好但生产风险高（误启即改库）。

---

## §4 7b 首次体验引导（onboarding）

### 4.1 目标
一条 3 分钟路径，把 **Smart Planner 核心 onboarding** 讲成故事：**注册 → 创建第一个 Goal → 生成行动路线 → 安排一天计划 → 执行 → 反馈**。
（命名修正：**首次体验引导**，不是「空状态 3 步卡」——产品核心不是展示空页面，而是引导用户走进 Planner 闭环。）

### 4.2 现状差距与改动

| 环节 | 现状 | 差距 |
|---|---|---|
| 注册→建目标 | 已有 | 无 |
| AI 分解 | decompose 双入口已接 | 引导缺失 |
| 安排计划 | Planner 链路完整 | demo 无 availability 数据 → 首排需引导 |
| 执行→反馈 | 已接 | 无引导 |
| Planner 参考反馈 | D5 已注入 | 反馈后再次排程可见调整 |

### 4.3 最小改动清单（原则：不动产品代码，只加引导；**明确不加 demo seed**）

1. **首次体验引导卡**：登录后无目标时显示引导：「① 创建一个目标 ② 让 AI 帮你拆成行动路线 ③ 排进你的日程」，每步链接到对应入口。**不展示空态，展示下一步行动。**
2. **Decompose/Planner 首用提示**：局部文案「AI 已按你的可用时间排好」（复用现有生成成功 toast 位置，不新增组件库）。
3. **README Demo 脚本**：文字化「3 分钟讲稿」+ 预期 UI 顺序（供自测与人讲）。

> **D9（审核新增决策）：不加入 demo seed**。项目价值在「用户输入 → Agent 理解 → Planner 生成 → Execution 反馈」的真实闭环，seed 会削弱它。7b 只在真实（或规则回退）链路上做引导。

---

## §5 7c Agent 可观测性（只读最小）

### 5.1 范围（审核收紧版）
- 新路由 `GET /api/agent-runs?limit=20`：最近 N 条，**仅返回轻量展示字段**：
  ```json
  [{ "agentType": "planner", "promptVersion": "planner-v1", "success": true, "latencyMs": 1200, "createdAt": "..." }]
  ```
- **不返回** `input_context` / `output_json`（Step 6 已考量隐私，用户页只看到「AI 运行记录」摘要）。
- 复用现有 `agent_runs` 表 + repo 层（新增只读查询），**零 schema 改动**。
- 前端位置：**成长页底部只读折叠**「AI 运行记录（最近 20）」，不加 tab、不做独立后台。

### 5.2 指标
| 指标 | 来源 |
|---|---|
| 最近 Agent 调用列表 | agent_runs（已落库） |
| 成功率 | success 字段聚合（一次查询） |
| 平均 latency | duration_ms 聚合 |
| prompt version | prompt_version 列展示 |

> 不做：失败重试按钮、删除、分页器、图表。**只有读。**

---

## §6 7d 文档

README 重写为 **Smart Planner 定位**，目标结构（用户定稿）：

```
# Smart Planner（一句话介绍：把「今天做了什么」变成下一步行动的自我提升 Agent）
## Features          能力表（含 Smart Planner 全链路 + Reflection + Eval）
## Architecture      4 层架构图（API/Service/Repo/PG）
## Tech Stack        Next 16.3 / React 19 / TS strict / PostgreSQL / Capacitor
## Quick Start       1 clone 2 env 3 database 4 migration 5 run（本地 + Docker 两种）
## Agent Loop        Planner 闭环 mermaid 图
## Evaluation        69/69 说明
## Development       脚本/冒烟/文档索引
```

1. **README 重写**：clone URL 改 fork（kkmmtt0919）或占位；migration 说明改「`npm run db:setup` 或手动 001-015」；新增「首次体验引导」节 + 「部署」节（Docker 两步）。
2. **Agent Flow 图**：README mermaid 加 Planner Loop 闭环图（Goal→Action→Schedule→Execution→Weekly→Reflection→Planner 参考）。
3. **架构分层图**：4 层简化图 + 关键设计决策索引（链接各 DESIGN_*.md）。

---

## §7 验收标准

| # | 验收 | 通过条件 |
|---|---|---|
| 21 | clone 即跑 | 新环境 `git clone && npm install && cp .env.example .env.local && npm run dev`（demo 模式）能开首页 |
| 22 | DB 一键迁移 | `npm run db:setup` 在空 PG 上全量 001-015 幂等成功，重跑不报错 |
| 23 | Docker 起服务 | `docker compose up -d` 后 127.0.0.1:3000 可注册/登录/建目标 |
| 24 | 首次体验闭环可讲 | 按 README 引导走完注册→建目标→行动路线→排程→执行→反馈全流程（真实或规则回退链路） |
| 25 | 可观测性只读 | GET /api/agent-runs 返回 `{agentType,promptVersion,success,latencyMs,createdAt}`，**不含 input/output 明文**；未登录 401 |
| 26 | env 校验 | 缺 DATABASE_URL 时 check-env 明确报错并退出（dev 无 DB 走 demo 需显式说明） |
| 27 | 零回归 | typecheck/lint/build/eval 69/69 + 全套 smoke 回归绿 |
| 28 | README 准确 | 文中所有路径/命令/API 与实际代码核对一致（无 upstream 残留、无过期 migration 描述） |

---

## §8 决策点（含审核定稿）

| # | 决策 | 定稿 |
|---|---|---|
| D1 | 部署模式 | ✅ **A 单机 Docker**（Compose + PostgreSQL + 外部 LLM API），即 **D6** |
| D2 | Docker db 是否随 compose 起 | ✅ compose 内带 db（本地一键），生产改外部 DATABASE_URL |
| D3 | 7c 观测入口位置 | ✅ 成长页底部只读折叠（不占主导航） |
| D4 | demo planner seed | ✅ **不加**（用户定稿：seed 削弱真实闭环价值）→ 并入 **D9** |
| D5 | 提交策略 | ✅ 按 7a/7b/7c/7d 四 commit，沿用 Step5/6 归档习惯 |
| D6 | **部署目标（审核新增）** | ✅ 只承诺 **Docker Compose 单机 + PostgreSQL + 外部 LLM API**；不承诺 K8s/Serverless/云厂商模板（避免范围膨胀） |
| D7 | **Step7 完成标准（审核新增）** | ✅ 别人 clone 后走 `git clone → cp .env.example .env → docker compose up -d → npm run db:setup → npm run dev` 能看到：注册、创建 Goal、生成计划、执行、反馈、Weekly 全流程 |
| D8 | **migration 执行方式（审核新增）** | ✅ `docker compose up` 与 `npm run db:setup` **明确两步**；不做容器 entrypoint 自动迁移（生产误启即改库风险） |
| D9 | **demo seed（审核新增）** | ✅ 不加。项目价值=「用户输入→Agent 理解→Planner 生成→Execution 反馈」真实闭环 |

---

## §9 开发顺序（定稿）

```
方案冻结（本版）
  ↓
7a 部署工程化（Dockerfile/compose/env check/db:setup + 验收 21-23/26）
  ↓
7b 首次体验引导（onboarding + 引导文案 + 验收 24）
  ↓
7c Agent 观测（agent-runs 查询 API + 成长页折叠 + 验收 25）
  ↓
7d README 重写（Architecture/Quick Start/Agent Loop + 验收 27-28）
  ↓
v1.0 release tag（release review：完整度/简历描述/Demo 流程/技术亮点）
```

---

## §10 审核记录（2026-09-05 用户批复）

- **总体**：✅ 通过。Step 6=Agent 能力闭环，Step 7=工程可交付性，**不继续堆 AI 功能**。
- 7a：通过；**改「自动 migration 容器执行」为显式两步**（compose up 后 `npm run db:setup`）。
- 7b：通过；改名「**首次体验引导**」（非空状态卡）——核心是 Smart Planner onboarding（注册→第一个 Goal→行动路线→安排一天）；**明确不加 demo seed**（seed 削弱「用户输入→Agent→Planner→Execution 反馈」闭环价值）。
- 7c：通过；**范围收紧**——只返回 `agentType/promptVersion/success/latencyMs/createdAt`，**不返回 input_context/output_json**（隐私考量，用户只看到「AI 运行记录」摘要）；位置=成长页底部折叠，不做独立后台。
- 7d：**必须做**，项目最大短板（README v0.3 旧地址/旧 migration 描述与 Smart Planner v1 现状严重不符）。最终结构按 §6 用户定稿。
- D6/D7 补充确认；Step7 完成后进入 **v1.0 release review**（项目完整度/简历描述/Demo 流程/技术亮点提炼），不做 Step 8 功能扩展。
- 范围冻结确认版：7a 部署 / 7b 首次体验 / 7c Agent 观测 / 7d 文档。**不做**：后台管理、监控平台、CI/CD、K8s、自动 Prompt 优化、数据分析 Dashboard。

---

<!-- 本文件为方案文档：已审核冻结（§10），按 §9 顺序进入实现。实现记录追加于文末 §11。 -->

## §11 交付记录（追加）

### 7a 部署工程化 ✅（2026-09-05 交付，方案 §10 冻结后）

- **交付物**：`Dockerfile`（node:22-alpine multi-stage：builder npm ci+next build → runner 拷产物，CMD next start 0.0.0.0:3000）；`docker-compose.yml`（app+db 双服务，db postgres:16-alpine + healthcheck + volume；**migration 不自动执行**=D8 两步式；DATABASE_URL 用 compose 变量插值 `:-` 默认连内置 db，填 .env 即切外部库）；`.dockerignore`；`scripts/setup-db.mjs`（扫描 migrations 目录 + schema_migrations 记录表 + 逐文件事务 + **legacy 库保护分支**——检出 profiles 已存在但无迁移记录则拒绝重放并提示）；`scripts/check-env.mjs`（dev/prod 两态校验）；`package.json` +`db:setup`/`db:check`/`env:check`；`.env.example` 重构分节（部署必填 4 键）。
- **核对修正**：方案原文「补 DB_POOL_SIZE/USE_SUPABASE_AUTH」经核对为 **僵尸键（代码零引用）→ 不进模板**（避免误导部署者）；`public/` 目录不存在 → Dockerfile 移除对应 COPY（app 无静态资源引用）。
- **实测（Docker daemon 可用）**：`docker-compose build` 成功；db 容器 healthy；**容器内 setup-db 空库全量 15/15 applied + 幂等重跑「已全部应用」**；app 镜像以 3100 端口起容器 → 首页 200 → **register 200 / me 200(xp25) / create goal 201**（验收 22/23 通过）。本机 3000 被 dev server 占用故容器映射 3100 验证；测试容器与 compose 已 down 清理。
- **未验证项**：`docker compose up -d`（映射 3000）整体体验留待无端口冲突环境/README 步骤核验；验收 21（clone 即跑）随 7d README 落地后由用户或新环境核。

### 7b/7c/7d 状态
- 7b 首次体验引导：⬜ 待实现
- 7c Agent 观测：⬜ 待实现
- 7d README 重写：⬜ 待实现
