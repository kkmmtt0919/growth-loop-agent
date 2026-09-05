// Step 5c-3 冒烟：AgentContext.todayExecutions + planner/context 双轨 V2。
// 运行：npx tsx scripts/context-smoke.ts
// 覆盖（T48）：①today execution join（90/75）②manual 不进入 todayExecutions
//   ③无 execution → 空数组且 contextToText 不产生「今日执行」段
//   ④双轨：records60+execution90 → V1(today)=60、V2(today)=150、context.minutes7d=150（planner 同源 V2）
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
const P = "__smoke_ctx_";
const today = new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const cleanupUserIds: string[] = [];
  try {
    const newUser = await pool.query<{ id: string }>(
      `insert into public.profiles (id, email, password_hash)
       values (gen_random_uuid(), $1, 'context-smoke') returning id`,
      [`ctx_${Date.now()}@test.local`],
    );
    const userId = newUser.rows[0].id;
    cleanupUserIds.push(userId);

    const ctxSvc = await import("../lib/service/context");
    const planRepo = await import("../lib/repo/planner");
    const statsRepo = await import("../lib/repo/stats");

    // ①③ 无执行基线
    const c0 = await ctxSvc.buildAgentContext(userId);
    ok("③ 无 execution → todayExecutions=[]", c0.todayExecutions.length === 0);
    ok("③ contextToText 不产生「今日执行」空段", !ctxSvc.contextToText(c0).includes("今日执行"));

    // action schedule 90 + complete actual75；manual 30 + complete
    const scheds = await planRepo.createSchedules(userId, [
      { source: "action", date: today, startTime: "10:00", endTime: "11:30", title: `${P}学习 React` },
      { source: "manual", date: today, startTime: "14:00", endTime: "14:30", title: `${P}取快递` },
    ]);
    await planRepo.completeScheduleTx(userId, scheds[0].id, 75);
    await planRepo.completeScheduleTx(userId, scheds[1].id);

    // ② 只取 action：manual 不进入
    const c1 = await ctxSvc.buildAgentContext(userId);
    ok("① today execution join：{title,90,75}", c1.todayExecutions.length === 1 && c1.todayExecutions[0].title === `${P}学习 React` && c1.todayExecutions[0].plannedMinutes === 90 && c1.todayExecutions[0].actualMinutes === 75);
    ok("② manual schedule 不进入 todayExecutions", !c1.todayExecutions.some((e) => e.title.includes("取快递")));
    const text1 = ctxSvc.contextToText(c1);
    ok("今日执行段注入（计划 90 / 实际 75）", text1.includes("今日执行（1 条）") && text1.includes("计划 90 分钟，实际 75 分钟") && !text1.includes("取快递"));

    // ④ 双轨：records 60（今天）→ V1 today=60、V2 today=150、context.minutes7d=150
    await pool.query(
      `insert into public.records (user_id, topic, text, minutes, intent, mode)
       values ($1, $2, 'context 冒烟手工', 60, 'quick_log', 'demo')`,
      [userId, `${P}手工`],
    );
    const minOn = (rows: Array<{ day: string; minutes: number }>, day: string) => rows.find((x) => x.day === day)?.minutes ?? 0;
    const [v1, v2] = await Promise.all([
      statsRepo.dailyMinutesSince(userId, today),
      statsRepo.dailySpentMinutesSince(userId, today),
    ]);
    ok("④ V1(today)=60（仅 records）", minOn(v1, today) === 60);
    ok("④ V2(today)=165（60 records + 75 action exec + 30 manual exec；manual 计投入但不进 todayExecutions）", minOn(v2, today) === 165);
    const c2 = await ctxSvc.buildAgentContext(userId);
    ok("④ context.minutes7d = 165（V2 口径；planner 同源）", c2.weeklyStats.minutes7d === 165);

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
