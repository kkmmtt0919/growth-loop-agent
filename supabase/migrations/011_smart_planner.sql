-- =============================================================
-- 011：Smart Planner V1 数据层（目标 → 行动池 → 计划 → 时间轴）
-- =============================================================
-- 设计（docs/DESIGN_SMART_PLANNER_V1.md，2026-09-04 用户审核冻结 + 3 条开发规范）：
--   1. 新增 4 张表：actions（长期行动池）/ action_dependencies（依赖）/ schedules（真正日程）/
--      user_availability（用户固定时间模板），全 RLS enable + 无 policy（延续 007：应用直连绕过）
--   2. 分层职责：actions 是「目标路线中的行动节点」，不进今日时间轴；
--      schedules 是今日时间轴唯一数据源，仅当用户「接受计划」后由 Planner 写入
--   3. 状态机分离（开发规范②）：
--      - action.status：pending → planned → completed（长期节点，completed 需显式标记）
--      - schedule.status：planned → doing → completed / overdue（当日执行态）
--      - **Schedule 完成 ≠ Action 完成**：schedule 标完成不自动推进 action.status，
--        Action 完成是「目标级」里程碑，需用户在行动池显式标记（防「做完一次阅读
--        schedule 就把整个阅读阶段标完成」的语义错误）
--   4. 固定时间块：user_availability 作模板被 Planner 消费，也按 weekday 在今日时间轴
--      合并展示（fixed 项）；**不落 schedules 表**，避免污染完成率统计
--   5. schedules.source（开发规范①）：NOT NULL，'action'|'manual'，**不允许无来源数据**
--      - 'action'：由 Action 安排而来（action_id 非空）
--      - 'manual'：P2 手动日程（无 Goal/Action 的临时事项，如「下午去医院」，action_id 空）
--   6. 重叠校验放应用层（不用 btree_gist / exclude 约束，遵守"纯标准 PG 无扩展依赖"红线）
--   7. Rule Scheduler（开发规范③）：第一版保持简单贪心排程——按优先级把 action 塞进
--      最近可用 slot，不做全局最优搜索；后续再优化（见 DESIGN §2.3）
-- =============================================================

-- ① actions：长期行动池（目标路线中的行动节点，pending → planned → completed）
create table public.actions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  goal_id            uuid not null references public.goals(id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 200),
  description        text,                          -- 可空，阶段说明
  estimated_minutes  int  not null check (estimated_minutes between 1 and 200000),
  priority           smallint not null default 5,   -- 1 最高 → 10 最低（用户可调）
  status             text not null default 'pending'
                     check (status in ('pending','planned','completed')),
  sort_order         int not null default 0,        -- 目标内展示顺序
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_actions_goal   on public.actions(goal_id);
create index idx_actions_user   on public.actions(user_id);
create index idx_actions_status on public.actions(goal_id, status);

-- ② action_dependencies：依赖关系（多对多，独立表正确建模「实验复现依赖论文阅读」）
create table public.action_dependencies (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  action_id    uuid not null references public.actions(id) on delete cascade,
  depends_on   uuid not null references public.actions(id) on delete cascade,
  created_at   timestamptz not null default now(),
  constraint action_dep_unique unique (action_id, depends_on),
  constraint action_dep_no_self check (action_id <> depends_on)
);

create index idx_action_dep_action  on public.action_dependencies(action_id);
create index idx_action_dep_depends on public.action_dependencies(depends_on);

-- ③ schedules：真正日程（今日时间轴唯一数据源）
-- source 为 NOT NULL 强制约束：任何 schedule 必须有来源，不允许无来源数据（开发规范①）
create table public.schedules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  action_id    uuid references public.actions(id) on delete cascade,  -- 可空：manual 来源无 action
  goal_id      uuid references public.goals(id) on delete cascade,     -- 冗余，便于按目标聚合
  source       text not null default 'action'
               check (source in ('action','manual')),
  date         date not null,                     -- 业务日期（Asia/Shanghai）
  start_time   time not null,
  end_time     time not null check (end_time > start_time),
  title        text not null check (char_length(title) between 1 and 200),
  status       text not null default 'planned'
               check (status in ('planned','doing','completed','overdue')),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint schedule_no_overlap check (true)   -- 占位，重叠校验放 Service/应用层（见 DESIGN §2.3）
);

create index idx_schedules_user_date on public.schedules(user_id, date);
create index idx_schedules_action   on public.schedules(action_id);

-- ④ user_availability：用户固定时间模板
-- type='learn' 且 title 为空 → 纯可安排时间段（Planner 候选池）；
-- title 非空（如「上课」「运动」）→ 固定块，Planner 不可占用，但展示在时间轴
create table public.user_availability (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),  -- 0=周一 … 6=周日
  start_time  time not null,
  end_time    time not null check (end_time > start_time),
  type        text not null default 'learn'
              check (type in ('learn','work','exercise','life','rest')),
  title       text not null default '',          -- 如「上课」「运动」，进时间轴展示
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_availability_user on public.user_availability(user_id, weekday);

-- 沿用 007 口径：开 RLS、不建 policy、不碰 auth.uid()
alter table public.actions             enable row level security;
alter table public.action_dependencies enable row level security;
alter table public.schedules           enable row level security;
alter table public.user_availability   enable row level security;
