-- =============================================================
-- 015_agent_runs.sql — Smart Planner Step 6c「Agent Trace」
-- 语义（DESIGN_SMART_PLANNER_STEP6 §3）：每次 LLM Agent 调用一条 run，
--   成功/失败都记录；trace 落库失败 console.warn、绝不影响主链路（补充 B）。
--   user_id nullable：当前四类均有用户上下文；未来系统级 Agent 无用户（补充 A）。
--   input_context 只存元信息 + user 预览（≤2000 字），prompt 全文不入库（隐私/体积）。
-- 编号占用说明：015 归 Step 6a → chat P2（summaries/metadata）顺延 016/017
-- 红线：纯标准 PG + RLS enable 无 policy（沿用 007 口径）；不进 XP/coin
-- =============================================================

create table public.agent_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.profiles(id) on delete cascade,  -- nullable（系统级调用预留）
  agent_type     text not null check (agent_type in ('action-plan','planner','weekly','evening')),
  prompt_version text not null,
  input_context  jsonb,
  output_json    jsonb,
  latency_ms     integer,
  success        boolean not null,
  error_message  text,
  created_at     timestamptz not null default now()
);

create index idx_agent_runs_user_type on public.agent_runs(user_id, agent_type, created_at desc);

alter table public.agent_runs enable row level security;
