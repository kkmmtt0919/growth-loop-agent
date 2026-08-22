-- =============================================================
-- 成长回路（Growth Loop）初始 schema —— 纯标准 PostgreSQL
-- =============================================================
-- 设计原则（用户审核定稿）：
--   1. 尽量使用标准 PG，避免任何 Supabase 专属能力
--      （无 auth.* schema、无 auth.uid()、无 PostgREST、无 RLS 依赖）
--   2. 多用户隔离在 Service 层决策 + Repo 层查询显式带 user_id
--   3. 账本幂等：ledger_entries.idempotency_key 唯一约束
--   4. 迁移 = Schema/Migration 重放 + 数据迁移 + 换 DATABASE_URL
--
-- 兼容性：PostgreSQL 13+（gen_random_uuid() 为内置，无需 pgcrypto 扩展）。
-- 执行方式：Supabase SQL Editor / psql / 腾讯云 PG 控制台均可直接运行。
-- =============================================================

-- -------------------------------------------------------------
-- 1. profiles —— 用户账号与画像（自建邮箱/密码，不依赖 auth.users）
-- -------------------------------------------------------------
create table public.profiles (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  display_name  text not null default '',
  level         int  not null default 1,
  role          text not null default '探索者',
  streak        int  not null default 0,
  xp_balance    int  not null default 0,
  coin_balance  int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 邮箱大小写不敏感的唯一约束（标准做法：lower() 索引，不依赖 citext）
create unique index idx_profiles_email_lower on public.profiles (lower(email));

-- -------------------------------------------------------------
-- 2. goals —— 4-12 周目标
-- -------------------------------------------------------------
create table public.goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  description text not null default '',
  progress    int  not null default 0 check (progress between 0 and 100),
  horizon     text not null default '',
  status      text not null default '进行中' check (status in ('进行中', '待复盘', '已归档')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 3. tasks —— 今日任务/日程/待办
-- -------------------------------------------------------------
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  goal_id     uuid references public.goals(id) on delete set null,
  title       text not null,
  subtitle    text not null default '',
  scheduled_time text not null default '',
  duration_minutes int,
  xp          int  not null default 0,
  coin        int  not null default 0,
  status      text not null default 'upcoming' check (status in ('done', 'current', 'upcoming')),
  kind        text not null default 'focus' check (kind in ('focus', 'learn', 'exercise', 'life', 'rest')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 4. records —— 统一行动/学习记录（前端 LogEntry + seed LearningLog）
-- -------------------------------------------------------------
create table public.records (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  topic       text not null default '',
  text        text not null,
  kind        text check (kind in ('focus', 'learn', 'exercise', 'life', 'rest')),
  minutes     int,
  output      text,
  intent      text not null default 'quick_log' check (intent in ('quick_log', 'plan_today', 'review')),
  evidence    text check (evidence in ('输入', '输入 + 输出', '应用')),
  xp          int  not null default 0,
  coin        int  not null default 0,
  mode        text not null default 'demo' check (mode in ('llm', 'demo', 'pending')),
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 5. ledger_entries —— XP/COIN 双账本（幂等，可冲正）
-- idempotency_key 唯一约束是幂等的根基：重复入账直接冲突跳过
-- -------------------------------------------------------------
create table public.ledger_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  account     text not null check (account in ('XP', 'COIN')),
  amount      int  not null,
  reason      text not null default '',
  source_id   uuid,
  idempotency_key text not null unique,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 6. quiz_sessions —— 理解测验会话与评分
-- -------------------------------------------------------------
create table public.quiz_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  record_id     uuid references public.records(id) on delete set null,
  topic         text not null default '',
  source_summary text not null default '',
  questions     jsonb not null default '[]'::jsonb,
  answers       jsonb,
  score         int,
  level         text,
  graded_by     text check (graded_by in ('llm', 'rules')),
  mode          text not null default 'demo',
  created_at    timestamptz not null default now(),
  graded_at     timestamptz
);

-- =============================================================
-- 索引
-- =============================================================
create index idx_goals_user           on public.goals(user_id);
create index idx_tasks_user           on public.tasks(user_id);
create index idx_tasks_goal           on public.tasks(goal_id);
create index idx_records_user_created on public.records(user_id, created_at desc);
create index idx_ledger_user          on public.ledger_entries(user_id);
create index idx_ledger_idem          on public.ledger_entries(idempotency_key);
create index idx_quiz_user            on public.quiz_sessions(user_id);

-- =============================================================
-- updated_at 触发器（标准 PG）
-- =============================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger goals_set_updated_at before update on public.goals
  for each row execute function public.set_updated_at();
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();
