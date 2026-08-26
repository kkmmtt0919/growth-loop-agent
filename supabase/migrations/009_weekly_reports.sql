-- =============================================================
-- 009：周成长报告
-- =============================================================
-- 设计（docs/DESIGN_PHASE5_WEEKLY.md v2，用户审核定稿 2026-08-26）：
--   1. 与 evening_reports 同构：UNIQUE(user_id, period_start) 是幂等根基
--   2. period_start/period_end 由服务端按 Asia/Shanghai 计算（周一为一周开始），不接收前端传入
--      period_start 语义是"滚动 7 天快照起点"（非固定自然周一），命名避免 week_start 误导
--   3. content jsonb 存结构化内容 { schemaVersion, stats, summary, achievement[], problem[], suggestion[], goalSuggestions[], replySource }
--      summary 文本列保留（与 evening_reports.summary 同风格，便于快速展示与检索）
--   4. 新表必须 ENABLE ROW LEVEL SECURITY（延续 007 修复：public 表一律 deny-all + 应用直连绕过，
--      否则 Supabase 再次告警 rls_disabled_in_public）
-- =============================================================

create table public.weekly_reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  period_start  date not null,               -- 滚动快照起点（周一，Asia/Shanghai）
  period_end    date not null,               -- 滚动快照终点（周日）
  summary       text not null,
  content       jsonb not null,              -- 结构化内容（见 DESIGN_PHASE5_WEEKLY §3）
  source_count  int  not null default 0,     -- 本周记录条数
  created_at    timestamptz not null default now(),
  generated_at  timestamptz not null default now(),
  unique (user_id, period_start)
);

create index idx_weekly_user_start on public.weekly_reports(user_id, period_start);

alter table public.weekly_reports enable row level security;
