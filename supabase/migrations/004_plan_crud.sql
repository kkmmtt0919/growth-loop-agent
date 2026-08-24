-- =============================================================
-- 004：计划地图真实化 —— goals/tasks 加列（Phase 1）
-- =============================================================
-- 设计（docs/DESIGN_PHASE1_PLAN_REAL.md v2，用户审核定稿 2026-08-24）：
--   1. 全部为加列，兼容存量 seed 数据，无破坏性变更
--   2. goals.start_date/end_date 必须可空：存量目标可能没有明确周期
--   3. progress 列保留但业务不再写入（legacy cache），事实来源是 tasks.status
--   4. task.goal_id 在 001 已存在（on delete set null），本轮不重复建
-- =============================================================

-- goals 增加业务起止日期（可空，YYYY-MM-DD，用户业务日期不做时区换算）
alter table public.goals
  add column start_date date,
  add column end_date   date;

-- tasks 增加截止日期与重复频率（频率先存文本，供展示与后续调度解析）
alter table public.tasks
  add column deadline  date,
  add column frequency text;

-- 派生进度查询索引（goal_id + status）
create index idx_tasks_goal_status on public.tasks(goal_id, status);
