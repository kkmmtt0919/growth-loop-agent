// Step 1 数据层冒烟：对 lib/repo/planner.ts 全部函数做一次真实读写，验证占位符 SQL 与行映射。
// 运行：npx tsx scripts/planner-repo-smoke.ts
// 注意：lib/repo/pool.ts 在模块顶层读 process.env.DATABASE_URL，tsx 不加载 .env.local，
// 因此必须先解析 .env.local 注入 env，再动态 import planner（静态 import 会先于 env 注入求值）。
// 数据用完即删（deleteAction 事务内级联清理依赖与 schedule），无残留。
import { readFileSync } from "node:fs";

const envText = readFileSync(".env.local", "utf8");
const url = envText
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="))!
  .slice(13)
  .trim()
  .replace(/[?&]sslmode=[^&]*/g, "");
process.env.DATABASE_URL = url;

const ok = (label: string, cond: boolean) => console.log((cond ? "PASS" : "FAIL") + " " + label);

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const planner = await import("../lib/repo/planner");
    const {
      createActions,
      listActionsByGoal,
      getAction,
      updateAction,
      setActionDependencies,
      listDependenciesByGoal,
      createSchedules,
      listSchedulesByDate,
      updateScheduleStatus,
      replaceAvailability,
      listAvailability,
      deleteAction,
    } = planner;

    const r = await pool.query(
      "select u.id as uid, g.id as gid from profiles u join goals g on g.user_id = u.id order by u.created_at limit 1",
    );
    const { uid: userId, gid: goalId } = r.rows[0] as { uid: string; gid: string };
    console.log("使用 userId=" + userId.slice(0, 8) + "… goalId=" + goalId.slice(0, 8) + "…");

    // 1. createActions 多行插入（验证 6 占位/行）
    const actions = await createActions(userId, [
      { goalId, title: "__smoke_研究阶段__", estimatedMinutes: 300, priority: 3, sortOrder: 1 },
      { goalId, title: "__smoke_实验阶段__", estimatedMinutes: 2400, priority: 1, sortOrder: 2 },
      { goalId, title: "__smoke_撰写阶段__", estimatedMinutes: 3000, sortOrder: 3 },
    ]);
    ok("createActions 返回 3 行", actions.length === 3);
    const [a1, a2, a3] = actions;
    ok("priority 默认 5", a3.priority === 5 && a1.priority === 3);
    ok("status 默认 pending", actions.every((a) => a.status === "pending"));

    // 2. 依赖：整组替换 + 去重 + 查询
    await setActionDependencies(userId, a2.id, [a1.id, a1.id]); // 重复依赖应幂等去重
    await setActionDependencies(userId, a3.id, [a2.id, a2.id]); // a3 依赖 a2
    const deps = await listDependenciesByGoal(userId, goalId);
    const myDeps = deps.filter((d) => actions.some((a) => a.id === d.action_id));
    ok("依赖去重(a2->a1 只 1 条)", myDeps.filter((d) => d.action_id === a2.id).length === 1);
    ok("依赖链路 a3->a2", myDeps.some((d) => d.action_id === a3.id && d.depends_on === a2.id));

    // 3. updateAction 状态推进 + 字段更新
    const upd = await updateAction(userId, a1.id, { status: "planned" });
    ok("updateAction 状态 -> planned", upd?.status === "planned");
    const upd2 = await updateAction(userId, a1.id, { title: "__smoke_研究方向__" });
    ok("updateAction 标题更新", upd2?.title === "__smoke_研究方向__");

    // 4. createSchedules 多行插入（验证 7 占位/行）+ manual source 语义
    const today = new Date().toISOString().slice(0, 10);
    const scheds = await createSchedules(userId, [
      { actionId: a1.id, goalId, source: "action", date: today, startTime: "19:00", endTime: "20:00", title: a1.title },
      { actionId: a2.id, goalId, source: "action", date: today, startTime: "20:00", endTime: "21:30", title: a2.title },
      { source: "manual", date: today, startTime: "15:00", endTime: "16:00", title: "下午去医院" }, // P2 manual：无 action/goal
    ]);
    ok("createSchedules 返回 3 行", scheds.length === 3);
    ok("manual 行 action_id 为空", scheds[2].action_id === null && scheds[2].source === "manual");

    // 5. 按日查询 + 状态更新（Schedule 完成 ≠ Action 完成）
    const byDate = await listSchedulesByDate(userId, today);
    ok("listSchedulesByDate 查到 3 条", byDate.length === 3);
    ok("按开始时间排序", byDate[0].start_time <= byDate[1].start_time);
    const done = await updateScheduleStatus(userId, scheds[0].id, "completed");
    ok("schedule 状态 -> completed 且记录完成时间", done?.status === "completed" && !!done?.completed_at);
    const after = await getAction(userId, a1.id);
    ok("开发规范②：Schedule 完成 ≠ Action 完成 (action 仍 planned)", after?.status === "planned");

    // 6. availability 整组替换 + 清空
    const avails = await replaceAvailability(userId, [
      { weekday: 0, startTime: "19:00", endTime: "22:00", type: "learn", title: "晚间学习" },
      { weekday: 2, startTime: "09:00", endTime: "12:00", type: "work", title: "上班" },
    ]);
    ok("replaceAvailability 返回 2 行", avails.length === 2);
    ok("listAvailability 查到 2 条", (await listAvailability(userId)).length === 2);
    await replaceAvailability(userId, []);
    ok("replaceAvailability 空组 = 清空", (await listAvailability(userId)).length === 0);

    // 7. 越权检查（隔离红线）
    const fake = "00000000-0000-4000-8000-000000000000";
    ok("跨用户查 action 为空", (await listActionsByGoal(fake, goalId)).length === 0);
    ok("跨用户查依赖为空", (await listDependenciesByGoal(fake, goalId)).length === 0);
    ok("跨用户查 schedule 为空", (await listSchedulesByDate(fake, today)).length === 0);

    // 8. 清理：删 3 个 action（依赖 + action 关联 schedule 由级联清理）
    for (const a of actions) await deleteAction(userId, a.id);
    const remainA = await listActionsByGoal(userId, goalId);
    ok("清理后无残留 action", remainA.filter((a) => a.title.startsWith("__smoke_")).length === 0);
    const remainS = await listSchedulesByDate(userId, today);
    ok("schedule 级联清理（action 关联行被删）", !remainS.some((s) => s.title.startsWith("__smoke_")));
    ok(
      "manual 行独立于 action 生命周期（设计语义正确，需单独清理）",
      remainS.some((s) => s.title === "下午去医院"),
    );
    // manual 无 action 关联不会级联删除——冒烟脚本用 SQL 清理自己的残留
    await pool.query(
      `delete from public.schedules where user_id = $1 and date = $2::date and title = '下午去医院'`,
      [userId, today],
    );
    const remainS2 = await listSchedulesByDate(userId, today);
    ok("manual 残留已清理", !remainS2.some((s) => s.title === "下午去医院"));
    console.log("SMOKE_DONE");
  } catch (e) {
    console.error("SMOKE_ERR:", e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
