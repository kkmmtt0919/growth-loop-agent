// Step 5b 后端冒烟：执行入口（实际分钟编辑 + Action 累计投入 spentMinutes）。
// 运行：npx tsx scripts/execution-5b-smoke.ts
// 覆盖验收：修改 actualMinutes 不改 schedule 时长 / 投入累计来自 execution_records（sumExecutionMinutesByActions）/
//   manual execution 不进入 Action 投入 / 达预计投入仍不自动完成（action 状态不变）/ GoalView.actions 带 spentMinutes
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
const P = "__smoke_exec5b_";
const today = new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const createdGoals: string[] = [];
  try {
    const r = await pool.query(
      "select u.id as uid from profiles u join goals g on g.user_id = u.id order by u.created_at limit 1",
    );
    const { uid: userId } = r.rows[0] as { uid: string };

    const planRepo = await import("../lib/repo/planner");
    const execRepo = await import("../lib/repo/execution");
    const goalsSvc = await import("../lib/service/goals");

    const goalRes = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
       values ($1, $2, 'exec5b 冒烟', 0, '1 个月', '进行中', $3, $3) returning id`,
      [userId, `${P}goal_${Date.now()}`, today],
    );
    const goalId = goalRes.rows[0].id;
    createdGoals.push(goalId);
    const acts = await planRepo.createActions(userId, [{ goalId, title: `${P}阶段甲`, estimatedMinutes: 180 }]);
    const action = acts[0];

    // 两条今天 action 排程（90 + 120）累计 210 ≥ 180（预计）→ 达标；一条 manual 30min
    const scheds = await planRepo.createSchedules(userId, [
      { actionId: action.id, goalId, source: "action", date: today, startTime: "09:00", endTime: "10:30", title: `${P}执行1` },
      { actionId: action.id, goalId, source: "action", date: today, startTime: "14:00", endTime: "16:00", title: `${P}执行2` },
      { source: "manual", date: today, startTime: "18:00", endTime: "18:30", title: `${P}手动跑` },
    ]);
    const [s1, s2, sManual] = scheds;

    // 完成 s1(90) + manual + s2(120)
    await planRepo.completeScheduleTx(userId, s1.id);
    await planRepo.completeScheduleTx(userId, sManual.id);
    await planRepo.completeScheduleTx(userId, s2.id, 100); // 实际只花 100 而不是 120

    // 1. spentMinutes：action 累计 = 90+100=190（execution_records 来源，manual 不计）
    const spentRows = await execRepo.sumExecutionMinutesByActions(userId, [action.id]);
    ok("1 累计投入来自 execution_records（90+100=190，manual 不计）", spentRows.length === 1 && spentRows[0].action_id === action.id && spentRows[0].minutes === 190);

    // 2. GoalView.actions 带 spentMinutes（goals 派生）
    const views = await goalsSvc.listGoalsForUser(userId);
    const gv = views.find((g) => g.id === goalId);
    const av = gv?.actions.find((a) => a.id === action.id);
    ok("2 GoalView 内嵌 action 带 spentMinutes=190", av?.spentMinutes === 190 && av?.estimatedMinutes === 180);

    // 3. 达预计投入不自动完成（action 仍 pending）
    ok("3 达标（190≥180）但 action 仍 pending（不自动完成）", av?.status === "pending" && (av?.spentMinutes ?? 0) >= av?.estimatedMinutes);

    // 4. 修改 actualMinutes：PATCH execution → schedule 时长/状态不变
    const exec1 = await execRepo.getExecutionBySchedule(userId, s1.id);
    const s1Before = await planRepo.getSchedule(userId, s1.id);
    const updatedExec = await (await import("../lib/service/execution")).setExecutionActualMinutes(userId, exec1!.id, 45);
    const s1After = await planRepo.getSchedule(userId, s1.id);
    ok("4a 修改 actual 45 落库", updatedExec.actual_minutes === 45);
    ok("4b schedule start/end/状态不变（只动 execution）", s1After?.start_time === s1Before?.start_time && s1After?.end_time === s1Before?.end_time && s1After?.status === "completed");
    const spentAfter = await execRepo.sumExecutionMinutesByActions(userId, [action.id]);
    ok("4c 修改后累计重算 = 45+100=145", spentAfter.length === 1 && spentAfter[0].minutes === 145);

    // 5. 越权 PATCH execution → 404
    let stranger = false;
    try {
      await (await import("../lib/service/execution")).setExecutionActualMinutes("00000000-0000-4000-8000-000000000000", exec1!.id, 30);
    } catch {
      stranger = true;
    }
    ok("5 跨用户修改 execution 被拒", stranger);

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
