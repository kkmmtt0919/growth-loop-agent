-- =============================================================
-- 013_execution_records.sql — Smart Planner Step 5「执行闭环」
-- 语义（DESIGN_SMART_PLANNER_STEP5 §0 决策冻结表）：
--   Schedule 完成 → 自动生成 execution_record（系统事实，schedule_id UNIQUE）
--   撤销完成 → 撤回事实（删 execution + 清 completed_at）
--   execution_records = 客观投入事实，**永不入账**（xp/coin 只来自手动 records/quiz）
--   action 保持独立状态机：schedule 完成不推进 action.status
-- 编号占用说明：013 归 Smart Planner Step5 → chat P2（summaries/metadata）顺延 014/015
-- 红线：不开 Supabase 专属能力；纯标准 PG + RLS enable 无 policy（沿用 007 口径）
-- =============================================================

create table public.execution_records (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  -- 一个排程至多一条执行事实（重复完成由 UNIQUE + on conflict do nothing 兜住）
  schedule_id    uuid not null unique references public.schedules(id) on delete cascade,
  -- 冗余列：manual 排程（action_id null）也留痕但不计入 Action 进度
  action_id      uuid references public.actions(id) on delete cascade,
  actual_minutes integer not null check (actual_minutes between 1 and 1440),
  note           text,   -- 预留：复盘备注（Step 6 reflection；本期前端不编辑，API 可写）
  completed_at   timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index idx_execution_user_date  on public.execution_records(user_id, completed_at);
create index idx_execution_action     on public.execution_records(action_id);

alter table public.execution_records enable row level security;
