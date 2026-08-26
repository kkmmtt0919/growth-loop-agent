-- =============================================================
-- 008：记录查询完善 —— records 加心情(枚举)/备注
-- =============================================================
-- 设计（docs/DESIGN_PHASE4_RECORDS.md v2，用户审核定稿 2026-08-26）：
--   1. mood 用枚举值（非 emoji/自由文本），与 tasks.status、records.kind 的
--      CHECK 约束风格一致；Phase 5 周报可直接按枚举统计
--   2. 枚举值英文，前端映射 emoji（MOOD_OPTIONS 常量），与 status/kind 英文风格一致
--   3. 无新索引：查询走 user_id + 上海时区日期表达式，个人量级（百条级），
--      既有 idx_records_user_created（user_id, created_at desc）已覆盖前缀。
--      上海时区日期表达式为函数表达式，普通索引本就不生效（与既有 listRecordsByDate 一致）。
-- =============================================================
alter table public.records
  add column mood   varchar(20)
    check (mood in ('great', 'good', 'normal', 'bad', 'terrible')),
  add column remark text;   -- 备注：自由文本，可空；长度上限在应用层限 500
