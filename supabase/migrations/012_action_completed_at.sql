-- =============================================================
-- 012：actions.completed_at（Action 完成时间戳）
-- =============================================================
-- 背景（docs/DESIGN_SMART_PLANNER_STEP2.md §6 审核补充项 1，2026-09-04 用户定稿）：
--   011 冻结时 actions 无 completed_at（当时只考虑 status 流转）；Step 2 决策 D5 要求
--   Action 手动「标完成」时记录完成时间（不入 records/账本，避免双计）——未来聊天要能答
--   「你什么时候完成这个阶段」「完成速度」「是否长期拖延」，时间戳是核心成长数据。
--
--   语义（与 schedules.completed_at 对齐，见 011 注释）：
--   - 置 completed 时记录首次完成时间（coalesce，重标不覆盖）
--   - 撤销完成（completed → pending）清空
--   - nullable：pending/planned 的 action 为 null
--
--   注意：012 编号原预留给 chat P2（chat_summaries / metadata jsonb）→ 被本迁移占用，
--   chat P2 实施时顺延 013/014。
-- =============================================================

alter table public.actions
  add column completed_at timestamptz;
