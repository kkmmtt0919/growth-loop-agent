-- =============================================================
-- 003：evening_reports —— 服务端每日晚间晚报
-- =============================================================
-- 设计（用户审核定稿 2026-08-22）：
--   1. report_date 为 DATE，由服务端按 Asia/Shanghai 时区计算，不接收前端传入
--   2. UNIQUE(user_id, report_date)：数据库层保证一天一份（幂等根基）
--   3. generated_at 与 created_at 分离：区分写入时间与生成时间（支持未来重生成）
--   4. id/user_id 与全库一致使用 uuid（user_id 外键引用 profiles.id）
-- =============================================================

create table public.evening_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  report_date  date not null,
  summary      text not null,
  questions    jsonb not null default '[]'::jsonb,
  source_count int  not null default 0,
  created_at   timestamptz not null default now(),
  generated_at timestamptz not null default now(),
  unique (user_id, report_date)
);

create index idx_evening_user_date on public.evening_reports(user_id, report_date);
