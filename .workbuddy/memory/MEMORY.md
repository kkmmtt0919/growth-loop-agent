# 成长回路（Growth Loop）长期项目笔记

## 用户协作偏好（重要）

- **设计先行，先审核再写代码**：用户要求任何实现开始前，先呈现设计（含数据流、改动点、预期效果），审核确认后才动手。不要在用户要求审核时继续写代码。
- **上线导向**：最终目标是国内上线；决策优先考虑生产可用性（合规、国内访问、可迁移性）。
- **方案偏好**：国内上线前先用 Supabase（PG）验证数据层，正式上线迁腾讯云 PG；PG→PG 迁移。
- **行动导向**：用户不喜欢只给建议不落地；但落地前必须过设计审核。

## 技术决策记录

- 数据库：PostgreSQL；MVP 用 Supabase 托管起步（只当托管 PG 用），上线迁腾讯云 PG。
- **架构原则（用户审核定稿，2026-08-21，8.5/10 + 三处修改）**：不把业务绑定 Supabase 特有能力。分层（用户 ASCII 图为权威版本）：
  - L1 API 路由：只依赖 Service 接口。
  - L2 Service：JWT **身份提取**（不负责签名验证）· 业务权限校验 · 多用户隔离**决策**。JWT 签名/有效期验证由独立的 **Auth Middleware**（`authenticate(request) → userId`，API 入口步骤）负责，Service 只收已验证的 userId。
  - L3 Repo：pg 连接池、参数化 SQL、事务/ON CONFLICT、**所有查询显式携带 user_id**（函数签名强制 userId 参数，编译期保证）。
  - L4 PostgreSQL：**尽量使用标准 PG，避免 Supabase 专属能力**（红线：auth.* schema、auth.uid()/auth.jwt()、PostgREST 链式 API、supabase-js、Storage/Realtime/Edge Functions；允许：标准 SQL、内置函数、常用扩展如 citext、触发器/索引/FK）。
  - 迁移 = **Schema/Migration 重放 + 数据迁移（pg_dump/restore）+ 换 DATABASE_URL**，业务代码基本不动。
  - 托管：MVP Supabase PostgreSQL → 正式腾讯云 PostgreSQL。
- **MVP 第一阶段登录闭环（用户明确要求）**：先做邮箱/密码登录，验证"注册→保存数据→重新登录→数据还在"闭环；**不做匿名登录、不做微信登录**（微信 OAuth 留到闭环验证后再接）。密码 bcrypt 哈希，会话 JWT。
- 账本幂等：ledger_entries.idempotency_key 唯一约束 + Repo 层事务（INSERT ... ON CONFLICT DO NOTHING + 更新余额），不用数据库函数。
- 改版 Next.js 16.3：写代码前必须读 node_modules/next/dist/docs/（AGENTS.md 要求）；本机 build 需 `NODE_OPTIONS= npm run build`（--use-system-ca 问题）。

## 数据层现状（2026-08-21 最终：已实现 + 端到端验证通过）

- **架构**：四层落地——lib/repo（pg 连接池+参数化 SQL，函数签名强制 userId）→ lib/service（auth/workspace 业务）→ lib/auth（bcrypt+jose JWT+authenticate 中间件）→ /api 路由。纯标准 PG schema（001_init + 002 task version），无 Supabase 依赖。
- **验证**：typecheck/lint/build 全过；端到端注册→播种→保存→重登→隔离→幂等全通过（scripts/e2e-closed-loop.sh、idempotency-test.sh 为回归工具）。
- **已知要点**：Supabase pooler 裸连接可用（pool.ts 剥离 sslmode）；seed 账本 key 带 userId 前缀；任务入账 key 带 version。
- **运维**：scripts/db-check.mjs（连接诊断）、scripts/run-migration.mjs（本地执行 migration）。
