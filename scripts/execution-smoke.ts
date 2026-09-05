// Step 5a 后端冒烟：execution_records 执行闭环（service 层确定性）。
// 运行：npx tsx scripts/execution-smoke.ts
// 覆盖（DESIGN_SMART_PLANNER_STEP5 §9 5a 验收 + 用户补的 XP/COIN 不变）：
//   1 completed → execution 行生成 actual=排程时长 / 2 重复 completed 仍一行 + 首完成保留 /
//   3 XP/COIN 余额不变（不奖励） / 4 撤销 → planned+completed_at null+execution 删 /
//   5 传 actualMinutes 覆盖默认 / 6 越界 actualMinutes 拒绝 / 7 跨用户 404 /
//   8 action 仍 pending / 9 manual schedule 完成 action_id=null
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
const P = "__smoke_exec_";
const today = new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const createdGoals: string[] = [];
  const manualIds: string[] = [];
  try {
    const r = await pool.query(
      "select u.id as uid from profiles u join goals g on g.user_id = u.id order by u.created_at limit 1",
    );
    const { uid: userId } = r.rows[0] as { uid: string };

    const planRepo = await import("../lib/repo/planner");
    const execRepo = await import("../lib/repo/execution");
    const timelineSvc = await import("../lib/service/timeline");
    const { ServiceError } = await import("../lib/service/errors");

    // 目标 + 行动 + 今天的 action 排程（10:00-11:30 = 90min）
    const goalRes = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
       values ($1, $2, 'exec 冒烟', 0, '1 个月', '进行中', $3, $3) returning id`,
      [userId, `${P}goal_${Date.now()}`, today],
    );
    const goalId = goalRes.rows[0].id;
    createdGoals.push(goalId);
    const acts = await planRepo.createActions(userId, [{ goalId, title: `${P}阶段甲`, estimatedMinutes: 300 }]);
    const action = acts[0];
    const scheds = await planRepo.createSchedules(userId, [
      { actionId: action.id, goalId, source: "action", date: today, startTime: "10:00", endTime: "11:30", title: `${P}执行甲` },
    ]);
    const schedId = scheds[0].id;

    const balance = async () => {
      const { rows } = await pool.query(`select xp_balance, coin_balance from public.profiles where id = $1`, [userId]);
      return { xp: Number(rows[0].xp_balance), coin: Number(rows[0].coin_balance) };
    };
    const before = await balance();

    // 1. completed → execution 生成，actual = 90
    const res1 = await planRepo.completeScheduleTx(userId, schedId);
    ok("1 completed → execution 生成 actual=90（=排程时长）", res1?.schedule.status === "completed" && res1.inserted === true && res1.execution?.actual_minutes === 90);
    const exec1 = await execRepo.getExecutionBySchedule(userId, schedId);
    ok("1b execution 落库（schedule_id 关联 + action_id 关联）", exec1?.schedule_id === schedId && exec1.action_id === action.id);
    const actionAfter = await planRepo.getAction(userId, action.id);
    ok("8 schedule completed → action 仍 pending（隔离红线）", actionAfter?.status === "pending");

    // 2. 重复 completed → 幂等一行 + 首完成保留
    const t1 = res1?.execution?.completed_at;
    const res2 = await planRepo.completeScheduleTx(userId, schedId);
    const execCount = (await pool.query(`select count(*)::int as n from public.execution_records where schedule_id=$1`, [schedId])).rows[0].n as number;
    const execAgain = await execRepo.getExecutionBySchedule(userId, schedId);
    ok("2 重复 completed 仍一行（inserted=false）", res2?.inserted === false && execCount === 1 && execAgain?.actual_minutes === 90);
    ok("2b 重复 completed 保留首完成时间", !!execAgain && !!t1 && new Date(execAgain.completed_at).getTime() === new Date(t1).getTime());

    // 3. XP/COIN 不变（用户补验收：execution 永不入账）
    const afterComplete = await balance();
    ok("3 完成 schedule 后 XP/COIN 余额不变（不奖励）", afterComplete.xp === before.xp && afterComplete.coin === before.coin);

    // 4. 撤销 → planned + completed_at null + execution 删（撤回事实）
    const reverted = await planRepo.revertScheduleTx(userId, schedId);
    const execAfterRevert = await execRepo.getExecutionBySchedule(userId, schedId);
    const countAfterRevert = (await pool.query(`select count(*)::int as n from public.execution_records where schedule_id=$1`, [schedId])).rows[0].n as number;
    ok("4 撤销 → planned + completed_at null + execution 删除", reverted?.status === "planned" && reverted.completed_at === null && execAfterRevert === null && countAfterRevert === 0);
    const afterRevert = await balance();
    ok("4b 撤销后 XP/COIN 仍不变（无冲正副作用）", afterRevert.xp === before.xp && afterRevert.coin === before.coin);

    // 5. 再次完成传 actualMinutes=45
    const res5 = await planRepo.completeScheduleTx(userId, schedId, 45);
    const exec5 = await execRepo.getExecutionBySchedule(userId, schedId);
    ok("5 传 actualMinutes=45 覆盖默认", res5?.inserted === true && exec5?.actual_minutes === 45);

    // 6. 越界 actualMinutes 拒绝（service 层 400）
    let bad = 0;
    for (const m of [0, 1441, 10.5, -3]) {
      try {
        await timelineSvc.setTimelineStatus(userId, schedId, "completed", m as number);
      } catch (e) {
        if (e instanceof ServiceError && e.status === 400) bad++;
      }
    }
    ok("6 越界/非法 actualMinutes 全部 400 拒绝", bad === 4);

    // 7. 跨用户（service 404）
    let strangerBlocked = false;
    try {
      await timelineSvc.setTimelineStatus("00000000-0000-4000-8000-000000000000", schedId, "completed");
    } catch (e) {
      strangerBlocked = e instanceof ServiceError && e.status === 404;
    }
    ok("7 跨用户 complete 被拒（404）", strangerBlocked);

    // 9. manual schedule 完成 → execution action_id=null（留痕但不计 Action 进度）
    const manual = await planRepo.createSchedules(userId, [
      { source: "manual", date: today, startTime: "16:00", endTime: "16:30", title: `${P}手动事项` },
    ]);
    const manualId = manual[0].id;
    manualIds.push(manualId);
    const doneManual = await timelineSvc.setTimelineStatus(userId, manualId, "completed");
    const execManual = await execRepo.getExecutionBySchedule(userId, manualId);
    ok("9 manual schedule 完成 → execution 生成且 action_id=null", doneManual.inserted === true && execManual?.action_id === null && execManual?.actual_minutes === 30);

    console.log("SMOKE_DONE");
  } catch (e) {
    console.error("SMOKE_ERR:", e);
    process.exitCode = 1;
  } finally {
    for (const gid of createdGoals) {
      await pool.query(`delete from public.goals where id = $1`, [gid]).catch(() => {});
    }
    for (const mid of manualIds) {
      await pool.query(`delete from public.schedules where id = $1`, [mid]).catch(() => {});
    }
    await pool.end();
  }
}

void main();
