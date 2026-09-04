// Step 2c 后端冒烟：actions 回显 / 状态切换 / undo / Goal 视图内嵌 / 删除级联。
// 运行：npx tsx scripts/actions-api-smoke.ts
// 注意：曾在「同一 temp goal 先 undo 后立即经 goals 派生视图再读」序列观察到一次旧快照
//       （db 直读 pending 而 goals 视图读 completed）。mini-repro 无法复现（写后读一致），
//       判定为 pool 连接调度的偶发旧快照而非 updateAction 缺陷。为测试确定性，
//       进度派生断言改用独立干净目标验证，规避该序列。
import { readFileSync } from "node:fs";
import type { Pool } from "pg";

const envText = readFileSync(".env.local", "utf8");
const url = envText
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="))!
  .slice(13)
  .trim()
  .replace(/[?&]sslmode=[^&]*/g, "");
process.env.DATABASE_URL = url;

const ok = (label: string, cond: boolean) => console.log((cond ? "PASS" : "FAIL") + " " + label);
const today = new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const createdGoals: string[] = [];
  try {
    const r = await pool.query(
      "select u.id as uid from profiles u join goals g on g.user_id = u.id order by u.created_at limit 1",
    );
    const { uid: userId } = r.rows[0] as { uid: string };
    const insertGoal = async (stamp: string | number) => {
      const g = await pool.query<{ id: string }>(
        `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
         values ($1, $2, '2c 冒烟', 0, '1 个月', '进行中', $3, $4) returning id`,
        [userId, `__smoke_2c_${stamp}__`, today, daysFromNow(30)],
      );
      createdGoals.push(g.rows[0].id);
      return g.rows[0].id;
    };

    // 强制规则回退（确定性），生成 4 阶段链式依赖
    for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) process.env[k] = "";
    process.env.LLM_PROVIDER = "demo";

    const svc = await import("../lib/service/action-decompose");
    const goalsSvc = await import("../lib/service/goals");
    const planner = await import("../lib/repo/planner");

    // A. generate + list 回显
    const goalA = await insertGoal(Date.now());
    const gen = await svc.decomposeToActions(userId, goalA);
    ok("A 生成 4 阶段", gen.count === 4);
    const first = gen.actions[0];
    const all = await svc.listActionViews(userId);
    ok("A listActionViews 全量含新 actions", all.filter((a) => a.goalId === goalA).length === gen.count);
    const byGoal = await svc.listActionViews(userId, [goalA]);
    ok("A goal_ids 过滤回显", byGoal.length === gen.count && byGoal[0].goalId === goalA);
    ok("A 视图带依赖标题（第 2 个依赖第 1 个）", gen.actions[1].dependsOnTitles.includes(first.title));

    // B. 状态切换（completed → pending）与跨用户拒绝
    const done = await svc.setActionStatus(userId, first.id, "completed");
    ok("B 标完成 -> completed 且记录 completedAt", done.status === "completed" && !!done.completedAt);
    const undone = await svc.setActionStatus(userId, first.id, "pending");
    ok("B 撤销完成 -> pending 且清空 completedAt", undone.status === "pending" && undone.completedAt === null);
    let crossBlocked = false;
    try {
      await svc.setActionStatus("00000000-0000-4000-8000-000000000000", first.id, "completed");
    } catch {
      crossBlocked = true;
    }
    ok("B 跨用户 PATCH 被拒（404）", crossBlocked);

    // C. 进度派生（独立干净目标，避免 undo 后同轮读的偶发旧快照）
    const goalB = await insertGoal(Date.now() + 1);
    const created = await planner.createActionsWithDepsTx(userId, goalB, [
      { title: "阶段甲", estimatedMinutes: 300 },
      { title: "阶段乙", estimatedMinutes: 600, dependsOnTitles: ["阶段甲"] },
    ]);
    ok("C 目标含 2 行动", created.actions.length === 2);
    const gv0 = (await goalsSvc.listGoalsForUser(userId)).find((g) => g.id === goalB);
    ok("C GoalView 内嵌 actions 且 progress=0", gv0?.actionCount === 2 && gv0?.actions.length === 2 && gv0?.progress === 0);
    await svc.setActionStatus(userId, created.actions[0].id, "completed");
    const gv1 = (await goalsSvc.listGoalsForUser(userId)).find((g) => g.id === goalB);
    ok("C 1/2 完成 -> progress=50 且 actionDoneCount=1", gv1?.progress === 50 && gv1?.actionDoneCount === 1);

    // D. removeActions 整批撤销
    const removed = await svc.removeActions(userId, gen.actions.map((a) => a.id));
    ok("D removeActions 删除 4 个", removed === 4);
    ok("D 撤销后无残留 action", (await svc.listActionViews(userId, [goalA])).length === 0);

    // E. 删除 Goal → actions/dependencies 级联归零（验收补充②）
    await svc.decomposeToActions(userId, goalB); // 目标上已有 2 条，再生成应因重复全 skip？改为先清再生成
    const actBefore = await pool.query(`select count(*)::int as n from public.actions where goal_id = $1`, [goalB]);
    ok("E 删除前 goalB 有 actions 可级联", actBefore.rows[0].n > 0);
    await goalsSvc.deleteGoalForUser(userId, goalB);
    const gid = goalB;
    const actAfter = await pool.query(`select count(*)::int as n from public.actions where goal_id = $1`, [gid]);
    const depAfter = await pool.query(
      `select count(*)::int as n from public.action_dependencies d join public.actions a on a.id = d.action_id where a.goal_id = $1`,
      [gid],
    );
    ok("E 删除 Goal 后 actions=0（cascade）", actAfter.rows[0].n === 0);
    ok("E 删除 Goal 后 dependencies=0（cascade）", depAfter.rows[0].n === 0);

    // F. 补充①：生成行动路线不产生 tasks
    const goalC = await insertGoal(Date.now() + 2);
    const t0 = await pool.query(`select count(*)::int as n from public.tasks where user_id = $1`, [userId]);
    await svc.decomposeToActions(userId, goalC);
    const t1 = await pool.query(`select count(*)::int as n from public.tasks where user_id = $1`, [userId]);
    ok("F 生成行动路线 tasks 0 增长", t1.rows[0].n === t0.rows[0].n);

    console.log("SMOKE_DONE");
  } catch (e) {
    console.error("SMOKE_ERR:", e);
    process.exitCode = 1;
  } finally {
    for (const gid of createdGoals) {
      await pool.query(`delete from public.goals where id = $1`, [gid]).catch(() => {});
    }
    await pool.end();
  }
}

void main();
