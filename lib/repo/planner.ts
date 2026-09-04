import { getPool } from "./pool";

/**
 * Smart Planner 仓储层（docs/DESIGN_SMART_PLANNER_V1.md，migration 011_smart_planner.sql）。
 * 4 张新表：actions（长期行动池）/ action_dependencies（依赖）/ schedules（真正日程）/
 * user_availability（用户固定时间模板）。
 *
 * 红线（延续项目惯例）：所有函数签名强制 userId；每个查询显式带 user_id=$1——
 * 按 id 操作一律 `id=$? and user_id=$?` 双条件（多用户隔离靠 Repo 层白纸黑字）。
 *
 * 行为约定（开发规范，2026-09-04 用户确认）：
 * ① schedules.source NOT NULL（'action'|'manual'），不允许无来源数据；
 * ② Schedule 完成 ≠ Action 完成——repo 不联动推进 action.status；
 * ③ 重叠校验 / 状态机白名单 / 依赖环检测都在 Service 层，repo 只做参数化读写。
 */

// ---------------------------------------------------------------------------
// 行类型（snake_case，与 migration 011 字段对应）
// ---------------------------------------------------------------------------

export type DbAction = {
  id: string;
  user_id: string;
  goal_id: string;
  title: string;
  description: string | null;
  estimated_minutes: number;
  priority: number;
  status: "pending" | "planned" | "completed";
  sort_order: number;
  /** 首次置 completed 的时间（012 迁移；撤销完成清空，见 updateAction） */
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbActionDependency = {
  id: string;
  user_id: string;
  action_id: string;
  depends_on: string;
  created_at: string;
};

export type DbSchedule = {
  id: string;
  user_id: string;
  action_id: string | null;
  goal_id: string | null;
  source: "action" | "manual";
  date: string; // YYYY-MM-DD（select 时 ::text）
  start_time: string; // HH:MM:SS
  end_time: string; // HH:MM:SS
  title: string;
  status: "planned" | "doing" | "completed" | "overdue";
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbAvailability = {
  id: string;
  user_id: string;
  weekday: number; // 0=周一 … 6=周日
  start_time: string;
  end_time: string;
  type: "learn" | "work" | "exercise" | "life" | "rest";
  title: string;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// actions：长期行动池
// ---------------------------------------------------------------------------

const ACTION_COLUMNS = `id, user_id, goal_id, title, description, estimated_minutes,
  priority, status, sort_order, completed_at, created_at, updated_at`;

/** 事务内判重 key（轻量归一化：去首尾空白 + 去内部空白，大小写不敏感）。不跨层依赖 agent 的 normalizeTitle。 */
function normKeyTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[\s\u3000]+/g, "");
}

export type CreateActionInput = {
  goalId: string;
  title: string;
  description?: string | null;
  estimatedMinutes: number;
  priority?: number;
  sortOrder?: number;
};

/** 批量创建行动（Agent Decompose 输出改道落点 / 用户手动添加）。返回全部新行。 */
export async function createActions(userId: string, items: CreateActionInput[]): Promise<DbAction[]> {
  if (items.length === 0) return [];
  // 单条 INSERT … VALUES 原子插入：$1 = userId，之后每行 6 列（goal_id,title,description,estimated_minutes,priority,sort_order）
  const placeholders = items.map((_, i) => {
    const b = i * 6;
    return `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
  });
  const { rows } = await getPool().query<DbAction>(
    `insert into public.actions (user_id, goal_id, title, description, estimated_minutes, priority, sort_order)
     values ${placeholders.join(", ")}
     returning ${ACTION_COLUMNS}`,
    [userId, ...items.flatMap((it) => [it.goalId, it.title, it.description ?? null, it.estimatedMinutes, it.priority ?? 5, it.sortOrder ?? 0])],
  );
  return rows;
}

/** 某目标下的行动列表（按 sort_order + created_at 稳定排序） */
export async function listActionsByGoal(userId: string, goalId: string): Promise<DbAction[]> {
  const { rows } = await getPool().query<DbAction>(
    `select ${ACTION_COLUMNS}
     from public.actions
     where user_id = $1 and goal_id = $2
     order by sort_order asc, created_at asc`,
    [userId, goalId],
  );
  return rows;
}

/** 单个行动（非本人返回 null） */
export async function getAction(userId: string, actionId: string): Promise<DbAction | null> {
  const { rows } = await getPool().query<DbAction>(
    `select ${ACTION_COLUMNS}
     from public.actions
     where id = $1 and user_id = $2
     limit 1`,
    [actionId, userId],
  );
  return rows[0] ?? null;
}

export type UpdateActionInput = {
  title?: string;
  description?: string | null;
  estimatedMinutes?: number;
  priority?: number;
  status?: DbAction["status"];
  sortOrder?: number;
};

/**
 * 更新行动元数据 / 状态（状态白名单、pending→planned→completed 流转由 Service 校验）。
 * completed_at 语义（012 迁移）：status 置 'completed' 时记录首次完成时间
 * （coalesce 不覆盖），从 completed 回退（planned/pending）时清空——与 updateScheduleStatus 同款。
 */
export async function updateAction(
  userId: string,
  actionId: string,
  input: UpdateActionInput,
): Promise<DbAction | null> {
  const { rows } = await getPool().query<DbAction>(
    `update public.actions set
       title = coalesce($3, title),
       description = coalesce($4, description),
       estimated_minutes = coalesce($5, estimated_minutes),
       priority = coalesce($6, priority),
       status = coalesce($7, status),
       completed_at = case
         when $7 = 'completed' then coalesce(completed_at, now())
         when $7 is not null then null
         else completed_at
       end,
       sort_order = coalesce($8, sort_order),
       updated_at = now()
     where id = $1 and user_id = $2
     returning ${ACTION_COLUMNS}`,
    [
      actionId,
      userId,
      input.title ?? null,
      input.description === undefined ? null : input.description,
      input.estimatedMinutes ?? null,
      input.priority ?? null,
      input.status ?? null,
      input.sortOrder ?? null,
    ],
  );
  return rows[0] ?? null;
}

export type CreateActionWithDepsInput = {
  title: string;
  description?: string | null;
  estimatedMinutes: number;
  priority?: number;
  /** 前置阶段标题引用（须与同批其它项的 title 精确一致；解析不到则丢弃该依赖） */
  dependsOnTitles?: string[];
};

export type ResolvedDependency = { actionId: string; dependsOnActionId: string };

/**
 * 批量创建行动 + 解析依赖 + 插入依赖关系（单事务，全有全无）——「制定行动路线」落库点。
 * 事务内兜底判重（service/validate 已与既有标题判重，这里防并发窗口与同批内重复标题）；
 * 环检测在事务内做（图 ≤6 节点，DFS）：若新增依赖会使图成环，丢弃该条依赖（去边保 DAG）。
 */
export async function createActionsWithDepsTx(
  userId: string,
  goalId: string,
  items: CreateActionWithDepsInput[],
): Promise<{ actions: DbAction[]; dependencies: ResolvedDependency[]; skipped: number }> {
  if (items.length === 0) return { actions: [], dependencies: [], skipped: 0 };
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const { rows: existing } = await client.query<{ title: string }>(
      `select title from public.actions where user_id = $1 and goal_id = $2`,
      [userId, goalId],
    );
    const seen = new Set(existing.map((r) => normKeyTitle(r.title)));

    const created: Array<{ action: DbAction; item: CreateActionWithDepsInput }> = [];
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const key = normKeyTitle(it.title);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const { rows } = await client.query<DbAction>(
        `insert into public.actions
           (user_id, goal_id, title, description, estimated_minutes, priority, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning ${ACTION_COLUMNS}`,
        [userId, goalId, it.title, it.description ?? null, it.estimatedMinutes, it.priority ?? 5, created.length],
      );
      created.push({ action: rows[0], item: it });
    }

    // 标题 → action 映射（created 内 title 唯一）
    const byTitle = new Map<string, DbAction>();
    for (const { action } of created) byTitle.set(action.title.trim(), action);

    // 依赖解析 + 环检测（图：actionId → 它依赖的 id 集合）
    const edges = new Map<string, Set<string>>();
    const wouldCycle = (from: string, target: string): boolean => {
      const stack = [from];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur === target) return true;
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const next of edges.get(cur) ?? []) stack.push(next);
      }
      return false;
    };

    const dependencies: ResolvedDependency[] = [];
    for (const { action, item } of created) {
      const depIds: string[] = [];
      for (const depTitle of item.dependsOnTitles ?? []) {
        const dep = byTitle.get(depTitle.trim());
        if (!dep || dep.id === action.id) continue; // 引用不存在的标题 → 丢弃
        if (depIds.includes(dep.id)) continue;
        if (wouldCycle(dep.id, action.id)) continue; // dep→…→action 已存在 → 加 action→dep 会成环 → 去边
        depIds.push(dep.id);
      }
      if (depIds.length === 0) continue;
      const edgeSet = edges.get(action.id) ?? new Set<string>();
      for (const depId of depIds) {
        await client.query(
          `insert into public.action_dependencies (user_id, action_id, depends_on)
           values ($1, $2, $3)
           on conflict (action_id, depends_on) do nothing`,
          [userId, action.id, depId],
        );
        edgeSet.add(depId);
        dependencies.push({ actionId: action.id, dependsOnActionId: depId });
      }
      edges.set(action.id, edgeSet);
    }

    await client.query("commit");
    return {
      actions: created.map((c) => c.action),
      dependencies,
      skipped,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** 删除行动（连带其依赖关系；schedule 若已排由级联删除清理） */
export async function deleteAction(userId: string, actionId: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from public.action_dependencies where user_id = $1 and (action_id = $2 or depends_on = $2)`,
      [userId, actionId],
    );
    const { rowCount } = await client.query(
      `delete from public.actions where id = $1 and user_id = $2`,
      [actionId, userId],
    );
    await client.query("commit");
    return (rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// action_dependencies：依赖关系（多对多）
// ---------------------------------------------------------------------------

const DEP_COLUMNS = `id, user_id, action_id, depends_on, created_at`;

/**
 * 整组替换某 action 的依赖（事务：先删后插）。decompose/planner 生成依赖时调用，
 * 天然幂等——同组覆盖，不需要先读再算差异。
 */
export async function setActionDependencies(
  userId: string,
  actionId: string,
  dependsOnIds: string[],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from public.action_dependencies where user_id = $1 and action_id = $2`,
      [userId, actionId],
    );
    for (const depId of dependsOnIds) {
      if (depId === actionId) continue; // DB 有 no-self check，这里防御跳过
      await client.query(
        `insert into public.action_dependencies (user_id, action_id, depends_on)
         values ($1, $2, $3)
         on conflict (action_id, depends_on) do nothing`,
        [userId, actionId, depId],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** 某目标下全部依赖关系（join actions 过滤目标，双 user_id 条件防越权） */
export async function listDependenciesByGoal(userId: string, goalId: string): Promise<DbActionDependency[]> {
  const { rows } = await getPool().query<DbActionDependency>(
    `select d.id, d.user_id, d.action_id, d.depends_on, d.created_at
     from public.action_dependencies d
     join public.actions a on a.id = d.action_id and a.user_id = $1
     where d.user_id = $1 and a.goal_id = $2
     order by d.created_at asc`,
    [userId, goalId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// schedules：真正日程（今日时间轴唯一数据源）
// ---------------------------------------------------------------------------

const SCHEDULE_COLUMNS = `id, user_id, action_id, goal_id, source,
  date::text as date, start_time::text as start_time, end_time::text as end_time,
  title, status, completed_at, created_at, updated_at`;

export type CreateScheduleInput = {
  actionId?: string | null;
  goalId?: string | null;
  source: "action" | "manual"; // 开发规范①：source 必有，不允许无来源数据
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM[:SS]
  endTime: string;
  title: string;
};

/** 批量创建日程（「接受计划」落库点）。单条 INSERT … VALUES 保证同批原子。 */
export async function createSchedules(userId: string, items: CreateScheduleInput[]): Promise<DbSchedule[]> {
  if (items.length === 0) return [];
  const params: unknown[] = [userId];
  const placeholders = items.map((it, i) => {
    const b = i * 7; // 每行 7 列从 $2 开始（$1 = userId）
    params.push(it.actionId ?? null, it.goalId ?? null, it.source, it.date, it.startTime, it.endTime, it.title);
    return `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
  });
  const { rows } = await getPool().query<DbSchedule>(
    `insert into public.schedules (user_id, action_id, goal_id, source, date, start_time, end_time, title)
     values ${placeholders.join(", ")}
     returning ${SCHEDULE_COLUMNS}`,
    params,
  );
  return rows;
}

/** 单个日程（非本人返回 null） */
export async function getSchedule(userId: string, scheduleId: string): Promise<DbSchedule | null> {
  const { rows } = await getPool().query<DbSchedule>(
    `select ${SCHEDULE_COLUMNS}
     from public.schedules
     where id = $1 and user_id = $2
     limit 1`,
    [scheduleId, userId],
  );
  return rows[0] ?? null;
}

/** 某天的日程（今日时间轴数据源；按开始时间排序） */
export async function listSchedulesByDate(userId: string, date: string): Promise<DbSchedule[]> {
  const { rows } = await getPool().query<DbSchedule>(
    `select ${SCHEDULE_COLUMNS}
     from public.schedules
     where user_id = $1 and date = $2::date
     order by start_time asc, created_at asc`,
    [userId, date],
  );
  return rows;
}

/** 日期区间日程（周视图 / planner 续排检查；overdue 懒计算在查询侧做） */
export async function listSchedulesByRange(
  userId: string,
  fromDate: string,
  toDate: string,
): Promise<DbSchedule[]> {
  const { rows } = await getPool().query<DbSchedule>(
    `select ${SCHEDULE_COLUMNS}
     from public.schedules
     where user_id = $1 and date between $2::date and $3::date
     order by date asc, start_time asc`,
    [userId, fromDate, toDate],
  );
  return rows;
}

/** 某目标下的日程（目标详情页进度 / 聊天上下文聚合） */
export async function listSchedulesByGoal(userId: string, goalId: string): Promise<DbSchedule[]> {
  const { rows } = await getPool().query<DbSchedule>(
    `select ${SCHEDULE_COLUMNS}
     from public.schedules
     where user_id = $1 and goal_id = $2
     order by date asc, start_time asc`,
    [userId, goalId],
  );
  return rows;
}

/**
 * 更新日程状态（用户点开始/完成）。状态白名单由 Service 校验；
 * completed_at 语义：置 completed 时记录（已存在则保留首次完成时间），
 * 回退到非 completed 清空。
 */
export async function updateScheduleStatus(
  userId: string,
  scheduleId: string,
  status: DbSchedule["status"],
): Promise<DbSchedule | null> {
  const { rows } = await getPool().query<DbSchedule>(
    `update public.schedules set
       status = $3,
       completed_at = case when $3 = 'completed' then coalesce(completed_at, now()) else null end,
       updated_at = now()
     where id = $1 and user_id = $2
     returning ${SCHEDULE_COLUMNS}`,
    [scheduleId, userId, status],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// user_availability：用户固定时间模板
// ---------------------------------------------------------------------------

const AVAILABILITY_COLUMNS = `id, user_id, weekday,
  start_time::text as start_time, end_time::text as end_time,
  type, title, created_at, updated_at`;

export type CreateAvailabilityInput = {
  weekday: number; // 0=周一 … 6=周日
  startTime: string;
  endTime: string;
  type?: DbAvailability["type"];
  title?: string;
};

/** 用户全部固定时间模板（按 weekday + start_time 排序） */
export async function listAvailability(userId: string): Promise<DbAvailability[]> {
  const { rows } = await getPool().query<DbAvailability>(
    `select ${AVAILABILITY_COLUMNS}
     from public.user_availability
     where user_id = $1
     order by weekday asc, start_time asc`,
    [userId],
  );
  return rows;
}

/** 整组替换用户固定时间模板（事务：先删后插）。设置页保存即整体覆盖，天然幂等。 */
export async function replaceAvailability(userId: string, items: CreateAvailabilityInput[]): Promise<DbAvailability[]> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`delete from public.user_availability where user_id = $1`, [userId]);
    const rows: DbAvailability[] = [];
    for (const it of items) {
      const { rows: inserted } = await client.query<DbAvailability>(
        `insert into public.user_availability (user_id, weekday, start_time, end_time, type, title)
         values ($1, $2, $3::time, $4::time, $5, $6)
         returning ${AVAILABILITY_COLUMNS}`,
        [userId, it.weekday, it.startTime, it.endTime, it.type ?? "learn", it.title ?? ""],
      );
      rows.push(inserted[0]);
    }
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Action 读/删扩展（Step 2c：Goal 页行动路线回显 + undo 整批撤销）
// ---------------------------------------------------------------------------

/** 当前用户全部行动（供按目标内嵌 / 全量回显；按 created_at 稳定序） */
export async function listActionsByUser(userId: string): Promise<DbAction[]> {
  const { rows } = await getPool().query<DbAction>(
    `select ${ACTION_COLUMNS}
     from public.actions
     where user_id = $1
     order by sort_order asc, created_at asc`,
    [userId],
  );
  return rows;
}

/** 当前用户全部依赖（组装 ActionView.dependsOnTitles 用） */
export async function listDependenciesByUser(userId: string): Promise<DbActionDependency[]> {
  const { rows } = await getPool().query<DbActionDependency>(
    `select ${DEP_COLUMNS}
     from public.action_dependencies
     where user_id = $1
     order by created_at asc`,
    [userId],
  );
  return rows;
}

/**
 * 整批删除行动（「制定行动路线」undo / 清理用）。
 * 011 两个 FK（action_id / depends_on）都是 on delete cascade → 删 action 自动清理两侧依赖行。
 * 返回实际删除数；越权 id（非本人）不计数。
 */
export async function batchDeleteActions(userId: string, actionIds: string[]): Promise<number> {
  if (actionIds.length === 0) return 0;
  const { rowCount } = await getPool().query(
    `delete from public.actions where user_id = $1 and id = any($2::uuid[])`,
    [userId, actionIds],
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Plan accept / reset（Smart Planner Step 3）
// ---------------------------------------------------------------------------

/**
 * 接受计划（单事务）：插入 schedules（source='action'）+ 对应 action pending→planned。
 * 审核边界（DESIGN_SMART_PLANNER_STEP3 §0.3/4）：
 *   - Preview 阶段零落库，只有这里才写；事务保证「schedule 写了但 action 没改」不会发生；
 *   - actions 仅当 status='pending' 才被推进（重复 accept 的已 planned action 自然跳过 = 幂等）。
 * items 的归属/来源校验在 Service 层完成（action 属于该 goal/用户），本函数只做参数化写入。
 */
export async function acceptPlanTx(
  userId: string,
  goalId: string,
  items: CreateScheduleInput[],
  pendingActionIds: string[],
): Promise<{ schedules: DbSchedule[]; updatedActions: number }> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const schedules: DbSchedule[] = [];
    for (const it of items) {
      const { rows } = await client.query<DbSchedule>(
        `insert into public.schedules (user_id, action_id, goal_id, source, date, start_time, end_time, title)
         values ($1, $2, $3, 'action', $4::date, $5::time, $6::time, $7)
         returning ${SCHEDULE_COLUMNS}`,
        [userId, it.actionId ?? null, it.goalId ?? null, it.date, it.startTime, it.endTime, it.title],
      );
      schedules.push(rows[0]);
    }
    const { rowCount } = await client.query(
      `update public.actions set status = 'planned', updated_at = now()
       where user_id = $1 and goal_id = $2 and id = any($3::uuid[]) and status = 'pending'`,
      [userId, goalId, pendingActionIds],
    );
    await client.query("commit");
    return { schedules, updatedActions: rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 撤销安排（单事务）：清空该目标「计划中」的 action 排程并回退阶段状态。
 * 审核边界（§0.2）：只删 `source='action' and status='planned'` 的 schedules，
 * **绝不碰 source='manual'**（手动日程与 Planner 无关）；已完成 schedule / completed action 不动。
 */
export async function resetGoalPlanTx(
  userId: string,
  goalId: string,
): Promise<{ removedSchedules: number; resetActions: number }> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const del = await client.query(
      `delete from public.schedules
       where user_id = $1 and goal_id = $2 and source = 'action' and status = 'planned'`,
      [userId, goalId],
    );
    const upd = await client.query(
      `update public.actions set status = 'pending', updated_at = now()
       where user_id = $1 and goal_id = $2 and status = 'planned'`,
      [userId, goalId],
    );
    await client.query("commit");
    return { removedSchedules: del.rowCount ?? 0, resetActions: upd.rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
