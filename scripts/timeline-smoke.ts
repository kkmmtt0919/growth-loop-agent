// Step 4a 后端冒烟：今日时间轴（timeline service，service 层确定性）。
// 运行：npx tsx scripts/timeline-smoke.ts
// 覆盖审核验收：A 昨天任务不出现 / B action schedule 显示 / C manual 显示 + reset 不动 manual + 删除 /
//   D fixed 规则（title≠'' 显示、title='' 不显示）/ E 完成隔离（schedule completed ≠ action completed）/
//   F 完成-撤销往返 + completed_at 首完成保留 / G action 排程单条删除 409
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
const P = "__smoke_timeline_";
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
  const manualIds: string[] = [];
  try {
    const r = await pool.query(
      "select u.id as uid from profiles u join goals g on g.user_id = u.id order by u.created_at limit 1",
    );
    const { uid: userId } = r.rows[0] as { uid: string };

    const schedSvc = await import("../lib/service/planner-scheduler");
    const timelineSvc = await import("../lib/service/timeline");
    const planRepo = await import("../lib/repo/planner");
    const avSvc = await import("../lib/service/availability");

    const weekdayToday = schedSvc.dateToDbWeekday(today);
    const otherWeekday = (weekdayToday + 1) % 7;

    // 目标（manual 的 goal_id 保持 null，验证 reset 不误删）
    const goalRes = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
       values ($1, $2, 'timeline 冒烟', 0, '1 个月', '进行中', $3, $4) returning id`,
      [userId, `${P}goal_${Date.now()}`, today, daysFromNow(30)],
    );
    const goalId = goalRes.rows[0].id;
    createdGoals.push(goalId);

    // 行动（两条，仅供 action schedule 落库引用）
    const acts = await planRepo.createActions(userId, [
      { goalId, title: `${P}阶段甲`, estimatedMinutes: 90 },
    ]);
    const actA = acts[0];

    // A 前提：昨天的 planned action schedule（今天必须不出现）
    await planRepo.createSchedules(userId, [
      { actionId: actA.id, goalId, source: "action", date: daysFromNow(-1), startTime: "20:00", endTime: "21:30", title: `${P}昨天排程` },
    ]);
    // B/E/F/G 前提：今天的 planned action schedule
    const todayRows = await planRepo.createSchedules(userId, [
      { actionId: actA.id, goalId, source: "action", date: today, startTime: "09:00", endTime: "10:30", title: `${P}今日排程甲` },
    ]);
    const todayActionSched = todayRows[0];

    // D 前提：availability —— 今天 weekday 一条 fixed（title='健身'）+ 另一天 fixed + 今天空档（title=''，不显示）
    await avSvc.saveAvailability(userId, [
      { weekday: weekdayToday, startTime: "19:00", endTime: "20:00", type: "exercise", title: "健身" },
      { weekday: weekdayToday, startTime: "21:00", endTime: "22:00", type: "learn", title: "" },
      { weekday: otherWeekday, startTime: "08:00", endTime: "09:00", type: "work", title: "上课" },
    ]);

    // 1. 聚合断言
    const tl1 = await timelineSvc.buildTodayTimeline(userId);
    const actionItem = tl1.items.find((i) => i.key === `s:${todayActionSched.id}`);
    const fixedToday = tl1.items.find((i) => i.type === "fixed" && i.title === "健身");
    ok("A 昨天 planned 不在今日时间轴", tl1.items.every((i) => i.key !== `s:${actA.id}`) && !tl1.items.some((i) => i.title.includes("昨天")));
    ok("B action schedule 显示（今天）", actionItem?.type === "action" && actionItem.status === "planned" && actionItem.startTime === "09:00");
    ok("D1 fixed（title='健身' 且 weekday=今天）显示", !!fixedToday && fixedToday.startTime === "19:00");
    ok("D2 今天空档 title='' 不显示", !tl1.items.some((i) => i.type === "fixed" && i.title === ""));
    ok("D3 非今天 weekday 的 fixed 不显示", !tl1.items.some((i) => i.title === "上课"));
    const times = tl1.items.map((i) => i.startTime);
    ok("排序按 start_time asc（09:00 在 19:00 前）", times.indexOf("09:00") < times.indexOf("19:00"));

    // 2. E：完成隔离 + F：往返
    const done = await timelineSvc.setTimelineStatus(userId, todayActionSched.id, "completed");
    ok("E1 PATCH completed 成功", done.status === "completed" && !!done.completed_at);
    const actionAfter = await planRepo.getAction(userId, actA.id);
    ok("E2 schedule completed → action 仍 pending（状态隔离）", actionAfter?.status === "pending");
    const t1 = done.completed_at;
    await timelineSvc.setTimelineStatus(userId, todayActionSched.id, "completed");
    const again = await planRepo.getSchedule(userId, todayActionSched.id);
    ok(
      "F1 重复置 completed 保留首完成时间（coalesce）",
      again?.completed_at != null && new Date(again.completed_at).getTime() === new Date(t1!).getTime(),
    );
    await timelineSvc.setTimelineStatus(userId, todayActionSched.id, "planned");
    const undone = await planRepo.getSchedule(userId, todayActionSched.id);
    ok("F2 撤销 → planned 且清空 completed_at", undone?.status === "planned" && undone.completed_at === null);

    // 3. G：action 排程单条删除 → 409
    let actionDeleteBlocked = false;
    try {
      await timelineSvc.deleteManualSchedule(userId, todayActionSched.id);
    } catch (e) {
      actionDeleteBlocked = (e as { status?: number }).status === 409;
    }
    ok("G action 排程单条删除被拒（409）", actionDeleteBlocked);

    // 4. C：manual 添加 / reset 保护 / 删除
    const manual = await timelineSvc.createManualSchedule(userId, { title: `${P}买咖啡`, startTime: "15:00", endTime: "15:30" });
    manualIds.push(manual.id);
    const tl2 = await timelineSvc.buildTodayTimeline(userId);
    ok("C1 manual 显示在今日时间轴", tl2.items.some((i) => i.key === `s:${manual.id}` && i.type === "manual"));
    let manualBadTitle = false;
    try {
      await timelineSvc.createManualSchedule(userId, { title: "", startTime: "15:00", endTime: "15:30" });
    } catch {
      manualBadTitle = true;
    }
    let manualBadTime = false;
    try {
      await timelineSvc.createManualSchedule(userId, { title: `${P}x`, startTime: "16:00", endTime: "15:00" });
    } catch {
      manualBadTime = true;
    }
    ok("C2 manual 校验（空标题 / end<=start 拒绝）", manualBadTitle && manualBadTime);

    // reset：清 goal 下 action 排程（今天 + 昨天 planned 都被清），manual（goal_id null）不受影响
    const reset = await planRepo.resetGoalPlanTx(userId, goalId);
    const tl3 = await timelineSvc.buildTodayTimeline(userId);
    const manualStill = tl3.items.find((i) => i.key === `s:${manual.id}`);
    const anyActionToday = tl3.items.some((i) => i.type === "action");
    const dbActionScheds = await pool.query(
      `select count(*)::int as n from public.schedules where user_id=$1 and goal_id=$2 and source='action'`,
      [userId, goalId],
    );
    ok("C3 reset 清 action 排程、manual 仍在（不误删）", reset.removedSchedules >= 1 && !!manualStill && !anyActionToday && dbActionScheds.rows[0].n === 0);

    await timelineSvc.deleteManualSchedule(userId, manual.id);
    manualIds.splice(manualIds.indexOf(manual.id), 1);
    const tl4 = await timelineSvc.buildTodayTimeline(userId);
    ok("C4 manual 删除后不在今日时间轴", !tl4.items.some((i) => i.key === `s:${manual.id}`));

    // 5. 越权（其他用户读不到）
    const stranger = "00000000-0000-4000-8000-000000000000";
    const tl5 = await timelineSvc.buildTodayTimeline(stranger);
    ok("H 越权用户时间轴为空", tl5.items.length === 0);

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
