-- =============================================================
-- 007：开启 RLS（关闭 Supabase 默认公开暴露面）
-- =============================================================
-- 背景：
--   Supabase 对 public schema 的表默认暴露 PostgREST REST API（公开 URL +
--   anon key 即可访问）。RLS 未开启时，任何人可对全表读 / 写 / 删。
--   2026-08-23 Supabase 安全告警：rls_disabled_in_public。
--
-- 修复（已连库验证 rolbypassrls=true）：
--   对 7 张业务表 ENABLE ROW LEVEL SECURITY，不创建任何 policy。
--   - 公开 API（anon / authenticated 角色）→ 无策略 = 默认拒绝全部 → 漏洞关闭
--   - 应用（postgres 用户，BYPASSRLS=true）→ 绕过 RLS → 直连 pg 正常工作
--   - 纯标准 PG，无 auth.uid()、无 supabase-js、无 PostgREST 依赖（遵守红线）
--
-- 为什么不影响业务链路：
--   架构为 前端 → API → Service → Repo(pg 直连)，数据库不直接暴露给用户。
--   登录 / 目标 / 任务 / 记录 / 账本 / 测验 / 晚报全部经后端，用 DATABASE_URL
--   连库的角色具备 BYPASSRLS，故开启 RLS 后业务零改动。
--
-- 长期演进（用户补充，重要）：
--   仅依赖 BYPASSRLS 是 MVP 过渡方案，不是最终生产形态。迁移到腾讯云 PG 时，
--   应用用户为表 owner，PG 规则下 owner 默认绕过 RLS（除非 FORCE RLS），
--   且腾讯云 PG 无公开 PostgREST API，无副作用。
--   若将来接入 Supabase Auth 前端直连 / Storage / Edge Function，
--   应改为：service_role + 明确 policy，或 app_user + RLS policy。
--   当前阶段是干净的 B 端 SaaS 架构：数据访问全部经过后端。
-- =============================================================

alter table public.profiles        enable row level security;
alter table public.goals           enable row level security;
alter table public.tasks           enable row level security;
alter table public.records         enable row level security;
alter table public.ledger_entries  enable row level security;
alter table public.quiz_sessions   enable row level security;
alter table public.evening_reports enable row level security;
