// Step 5c-2 weekly service 冒烟：WeeklyStats 排程执行平行字段。
// 运行：npx tsx scripts/weekly-smoke.ts
// 覆盖（T43/T44 + 验收 W1/W2）：
//   W1 无排程周：stats{plan:0,actual:0,rate:null} + 文本「本周暂无 AI 排程」（不显示 0%）
//   W2 计划 90 / 实际 45：content.stats{90,45,50(非1)} + summary 含「执行率 50%」
//   execution 不影响 XP/coin（回归保持）
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
const P = "__smoke_weekly_";
const today = new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const cleanupUserIds: string[] = [];
  try {
    const newUser = await pool.query<{ id: string }>(
      `insert into public.profiles (id, email, password_hash)
       values (gen_random_uuid(), $1, 'weekly-smoke') returning id`,
      [`wk_${Date.now()}@test.local`],
    );
    const userId = newUser.rows[0].id;
    cleanupUserIds.push(userId);

    for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) process.env[k] = "";
    process.env.LLM_PROVIDER = "demo";
    const weeklySvc = await import("../lib/service/weekly");
    const planRepo = await import("../lib/repo/planner");

    // W1：无排程周（无 goals/tasks/records/schedules → meaningful=false → rules fallback 直出）
    const r1 = await weeklySvc.generateWeeklyReport(userId);
    const s1 = (r1.report.content as { stats?: Record<string, unknown> })?.stats ?? {};
    ok("W1 stats{plan:0,actual:0,rate:null}", s1.planMinutes === 0 && s1.actualMinutes === 0 && s1.executionRate === null);
    ok("W1 文本含「暂无 AI 排程」且不出现「执行率 0」", r1.report.summary.includes("暂无 AI 排程") && !r1.report.summary.includes("执行率 0%"));

    // W2：计划 90 / 实际 45（schedule date=today source=action；complete 传 actual 45）
    const balanceBefore = (await pool.query(`select xp_balance, coin_balance from public.profiles where id=$1`, [userId])).rows[0];
    const scheds = await planRepo.createSchedules(userId, [
      { source: "action", date: today, startTime: "10:00", endTime: "11:30", title: `${P}执行` },
    ]);
    await planRepo.completeScheduleTx(userId, scheds[0].id, 45);
    const balanceAfter = (await pool.query(`select xp_balance, coin_balance from public.profiles where id=$1`, [userId])).rows[0];
    ok("execution 不影响 XP/COIN", balanceAfter.xp_balance === balanceBefore.xp_balance && balanceAfter.coin_balance === balanceBefore.coin_balance);

    const r2 = await weeklySvc.generateWeeklyReport(userId);
    const s2 = (r2.report.content as { stats?: Record<string, unknown> })?.stats ?? {};
    ok("W2 stats{plan:90,actual:45,rate:50}", s2.planMinutes === 90 && s2.actualMinutes === 45 && s2.executionRate === 50);
    ok("W2 执行率非 1（45/90 → 50%，不是 100）", s2.executionRate === 50);
    ok("W2 summary 含「实际投入 45 分钟，执行率 50%」", r2.report.summary.includes("实际投入 45 分钟") && r2.report.summary.includes("执行率 50%"));

    console.log("SMOKE_DONE");
  } catch (e) {
    console.error("SMOKE_ERR:", e);
    process.exitCode = 1;
  } finally {
    for (const uid of cleanupUserIds) {
      await pool.query(`delete from public.profiles where id = $1`, [uid]).catch(() => {});
    }
    await pool.end();
  }
}

void main();
