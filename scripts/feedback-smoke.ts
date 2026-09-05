// Step 5c-1 后端冒烟：双轨统计（dailySpentMinutesSince V2 + weekly 聚合基础）。
// 运行：npx tsx scripts/feedback-smoke.ts
// 覆盖（DESIGN_SMART_PLANNER_STEP5C §7 + 用户补充 A/B）：
//   1 无 execution → V2==V1（全量数组相等）
//   2 有 execution → V2 = V1 + execution（同一天，增量断言）
//   B 重叠加总不去重：records 60 + execution 90 同天 → V2 today = V1 + 90
//   3 时区边界：completed_at UTC 23:30 → 计入上海次日（09-03）而非 UTC 当日（09-02）
//   A sumScheduleMinutesBetween 按 schedule 时长（非 action.estimated）
//   4 execution 不影响 XP/coin
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
const P = "__smoke_fb_";
const today = new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const cleanupUserIds: string[] = [];
  const cleanupSched: string[] = [];
  const createdGoals: string[] = [];
  try {
    // 专属临时用户（V2==V1 需要绝对干净环境；共享用户可能被中断的 e2e 残留污染）
    const newUser = await pool.query<{ id: string }>(
      `insert into public.profiles (id, email, password_hash)
       values (gen_random_uuid(), $1, 'feedback-smoke')
       returning id`,
      [`fb_${Date.now()}@test.local`],
    );
    const userId = newUser.rows[0].id;
    cleanupUserIds.push(userId);

    const statsRepo = await import("../lib/repo/stats");
    const planRepo = await import("../lib/repo/planner");
    const execRepo = await import("../lib/repo/execution");

    const minOn = (rows: Array<{ day: string; minutes: number }>, day: string) =>
      rows.find((x) => x.day === day)?.minutes ?? 0;
    const since30 = daysFromNow(-29);
    const sinceTz = daysFromNow(-4); // 覆盖 tz 用例（固定过去日期）

    // 0. 无 execution → V2 === V1（全量数组比较）
    const [v1b, v2b] = await Promise.all([
      statsRepo.dailyMinutesSince(userId, since30),
      statsRepo.dailySpentMinutesSince(userId, since30),
    ]);
    ok("1 无 execution → V2 == V1（全量一致）", JSON.stringify(v2b) === JSON.stringify(v1b));

    // 造 goal + action + 今天 90min action 排程
    const goalRes = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
       values ($1, $2, 'fb 冒烟', 0, '1 个月', '进行中', $3, $3) returning id`,
      [userId, `${P}goal_${Date.now()}`, today],
    );
    const goalId = goalRes.rows[0].id;
    createdGoals.push(goalId);
    const acts = await planRepo.createActions(userId, [{ goalId, title: `${P}阶段甲`, estimatedMinutes: 300 }]);
    const scheds = await planRepo.createSchedules(userId, [
      { actionId: acts[0].id, goalId, source: "action", date: today, startTime: "10:00", endTime: "11:30", title: `${P}执行` },
    ]);
    const schedId = scheds[0].id;
    cleanupSched.push(schedId);

    // A：sumScheduleMinutesBetween = 90（schedule 时长，非 action.estimated 300）
    const planMin = await planRepo.sumScheduleMinutesBetween(userId, today, today);
    ok("A sumScheduleMinutesBetween=90（schedule 时长而非 action 估算）", planMin === 90);

    // 插入一条手工 records 60min（今天）→ V1 增 60；仍无 execution → V2==V1
    await pool.query(
      `insert into public.records (user_id, topic, text, minutes, intent, mode)
       values ($1, $2, 'feedback 冒烟手工记录', 60, 'quick_log', 'demo')`,
      [userId, `${P}手工`],
    );
    const [v1a1, v2a1] = await Promise.all([
      statsRepo.dailyMinutesSince(userId, since30),
      statsRepo.dailySpentMinutesSince(userId, since30),
    ]);
    const dV1a1 = minOn(v1a1, today) - minOn(v1b, today);
    ok("2a 手工 records 60 → V1 today +60", dV1a1 === 60);
    ok("2b 仍无 execution → V2 == V1", minOn(v2a1, today) === minOn(v1a1, today));

    // 完成 schedule（execution 90）→ V2 today = V1 + 90（重叠加总不去重：60+90=150 增量）
    await planRepo.completeScheduleTx(userId, schedId);
    const balanceBefore = (await pool.query(`select xp_balance, coin_balance from public.profiles where id=$1`, [userId])).rows[0];
    const [v1a2, v2a2, sumExec] = await Promise.all([
      statsRepo.dailyMinutesSince(userId, since30),
      statsRepo.dailySpentMinutesSince(userId, since30),
      execRepo.sumExecutionMinutesBetween(userId, today, today),
    ]);
    ok("2c execution 90 入账 → V2 today = V1 today + 90（重叠加总 60+90=150）", minOn(v2a2, today) === minOn(v1a2, today) + 90);
    ok("2d sumExecutionMinutesBetween=90", sumExec === 90);
    ok("2e records 未受影响（V1 today 不变）", minOn(v1a2, today) === minOn(v1a1, today));
    const balanceAfter = (await pool.query(`select xp_balance, coin_balance from public.profiles where id=$1`, [userId])).rows[0];
    ok("4 execution 不影响 XP/COIN", balanceAfter.xp_balance === balanceBefore.xp_balance && balanceAfter.coin_balance === balanceBefore.coin_balance);

    // 3. 时区边界：schedule date=09-02(UTC day)，execution completed_at=09-02T23:30:00Z(=上海 09-03 07:30)
    const utcDay = daysFromNow(-3); // 若 today=09-05 → 09-02
    const shNextDay = daysFromNow(-2); // 09-03
    const tzSched = await planRepo.createSchedules(userId, [
      { source: "manual", date: utcDay, startTime: "23:00", endTime: "23:30", title: `${P}时区用例` },
    ]);
    const tzSchedId = tzSched[0].id;
    cleanupSched.push(tzSchedId);
    const v2tzBefore = await statsRepo.dailySpentMinutesSince(userId, sinceTz);
    await pool.query(
      `insert into public.execution_records (user_id, schedule_id, actual_minutes, completed_at)
       values ($1, $2, 45, $3::timestamptz)`,
      [userId, tzSchedId, `${utcDay}T23:30:00Z`],
    );
    const v2tzAfter = await statsRepo.dailySpentMinutesSince(userId, sinceTz);
    ok("3a UTC 23:30 计入上海次日（09-03 +45）", minOn(v2tzAfter, shNextDay) === minOn(v2tzBefore, shNextDay) + 45);
    ok("3b 不计入 UTC 当日（09-02 无增量）", minOn(v2tzAfter, utcDay) === minOn(v2tzBefore, utcDay));
    const sumExecTz = await execRepo.sumExecutionMinutesBetween(userId, shNextDay, shNextDay);
    ok("3c sumExecutionBetween 上海日口径 = 45（09-02 窗口为 0）", sumExecTz === 45 && (await execRepo.sumExecutionMinutesBetween(userId, utcDay, utcDay)) === 0);

    console.log("SMOKE_DONE");
  } catch (e) {
    console.error("SMOKE_ERR:", e);
    process.exitCode = 1;
  } finally {
    for (const uid of cleanupUserIds) {
      await pool.query(`delete from public.profiles where id = $1`, [uid]).catch(() => {});
    }
    for (const gid of createdGoals) {
      await pool.query(`delete from public.goals where id = $1`, [gid]).catch(() => {});
    }
    for (const sid of cleanupSched) {
      await pool.query(`delete from public.schedules where id = $1`, [sid]).catch(() => {});
    }
    await pool.end();
  }
}

void main();
