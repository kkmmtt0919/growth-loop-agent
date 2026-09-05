-- =============================================================
-- 014_reflection_records.sql — Smart Planner Step 6a「Reflection」
-- 语义（DESIGN_SMART_PLANNER_STEP6 §1）：用户反馈进 Agent Loop 的唯一入口。
--   MVP 只记录 + 查询；planner prompt 注入最近 ≤3 条作「仅参考」文本（D5），不做规则化自动调整（D1）。
--   **不进 XP/coin**（红线，同 execution_records）。
-- 编号占用说明：014 归 Step 6a → chat P2（summaries/metadata）顺延 016/017
-- 红线：纯标准 PG + RLS enable 无 policy（沿用 007 口径）
-- =============================================================

create table public.reflection_records (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  goal_id    uuid references public.goals(id) on delete cascade,     -- nullable
  action_id  uuid references public.actions(id) on delete cascade,   -- nullable（与 goal_id 至少给一个）
  source     text not null check (source in ('planner','weekly','manual')),
  content    text not null check (char_length(content) between 1 and 500),
  rating     text check (rating in ('good','bad')),                  -- nullable
  created_at timestamptz not null default now()
);

create index idx_reflection_user on public.reflection_records(user_id, created_at desc);

alter table public.reflection_records enable row level security;
