-- =============================================================
-- 006：Agent Decompose V1 —— 任务验收标准
-- =============================================================
-- 设计（docs/DESIGN_DECOMPOSE_V1.md，用户审核通过 2026-08-25）：
--   1. tasks.acceptance：拆解生成任务的「完成标准」，展示字段（点击展开），
--      老任务为 null 时不显示
--   2. 不新增索引：acceptance 无查询/排序/join 场景
--      （goal_id 检索已有 idx_tasks_goal_status 覆盖）
-- =============================================================

alter table public.tasks
  add column acceptance text;
