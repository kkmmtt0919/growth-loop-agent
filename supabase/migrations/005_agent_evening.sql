-- =============================================================
-- 005：Agent Context Layer + 晚报结构化（Phase 2+3）
-- =============================================================
-- 设计（docs/DESIGN_PHASE2_3_AGENT_EVENING.md v2，用户审核定稿 2026-08-24）：
--   1. evening_reports.content jsonb 存结构化输出 {summary, achievement[], problem[], suggestion[], evaluation}
--      summary 文本列保留兼容（老数据不迁移）
--   2. tasks.completed_at：支撑 7 天完成率口径；toggle 完成写入 now()/撤销置 null
--      边界：MVP 记录「最后完成时间」，不代表历史完成轨迹
--   3. 索引按用户意见：idx_tasks_completed_at on (completed_at)，按时间统计方便
-- =============================================================

-- 晚报结构化内容
alter table public.evening_reports
  add column content jsonb;

-- 任务最后完成时间
alter table public.tasks
  add column completed_at timestamptz;

create index idx_tasks_completed_at on public.tasks(completed_at);
