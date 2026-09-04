// Step 3a 后端冒烟：availability + Plan Preview/accept/reset（service 层，规则回退确定性）。
// 运行：npx tsx scripts/planner-smoke.ts
// 覆盖审核验收：无空档引导 / Preview 零落库 / 固定会议不占用 / accept 幂等 / reset 不动 manual / 越权
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
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const createdGoals: string[] = [];
  try {
    const r = await pool.query(
      "select u.id as uid from profiles u join goals g on g.user_id = u.id order by u.created_at limit 1",
    );
    const { uid: userId } = r.rows[0] as { uid: string };

    for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) process.env[k] = "";
    process.env.LLM_PROVIDER = "demo";

    const avSvc = await import("../lib/service/availability");
    const plannerSvc = await import("../lib/service/planner");
    const planRepo = await import("../lib/repo/planner");

    // 目标 + 两条行动（B 依赖 A；总量 900min，14 天窗口足够）
    const goalRes = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
       values ($1, $2, 'planner 冒烟', 0, '1 个月', '进行中', $3, $4) returning id`,
      [userId, `__smoke_plan_${Date.now()}__`, today, daysFromNow(30)],
    );
    const goalId = goalRes.rows[0].id;
    createdGoals.push(goalId);
    await planRepo.createActionsWithDepsTx(userId, goalId, [
      { title: "阶段甲（600min）", estimatedMinutes: 600, priority: 2 },
      { title: "阶段乙（300min，依赖甲）", estimatedMinutes: 300, priority: 1, dependsOnTitles: ["阶段甲（600min）"] },
    ]);

    // 1. availability：先清空 → 全 busy → 无空档 blocked
    await avSvc.saveAvailability(userId, []);
    await avSvc.saveAvailability(userId, [
      { weekday: 0, startTime: "09:00", endTime: "12:00", type: "work", title: "上课" },
    ]);
    const p1 = await plannerSvc.generatePlanPreview(userId, goalId);
    ok("A1 只有固定块 → blocked no-availability", p1.blocked === "no-availability" && !!p1.message);

    // 2. 恢复：工作日 19-22 空档 + 周三 20-21 会议固定块
    const items: Array<{ weekday: number; startTime: string; endTime: string; type: "learn" | "work"; title: string }> = [];
    for (let w = 0; w <= 4; w++) items.push({ weekday: w, startTime: "19:00", endTime: "22:00", type: "learn", title: "" });
    items.push({ weekday: 2, startTime: "20:00", endTime: "21:00", type: "work", title: "会议" });
    const saved = await avSvc.saveAvailability(userId, items);
    ok("B1 availability 保存 6 条（5 空档 + 1 会议）", saved.length === 6);
    const got = await avSvc.getAvailability(userId);
    ok("B2 availability 读取一致", got.length === 6 && got.every((x) => x.title !== "" || x.startTime === "19:00"));

    // 3. Preview
    const before = {
      sched: (await pool.query(`select count(*)::int as n from public.schedules where user_id=$1 and goal_id=$2`, [userId, goalId])).rows[0].n as number,
    };
    const preview = await plannerSvc.generatePlanPreview(userId, goalId);
    console.log(`[Preview] source=${preview.source} items=${preview.items.length} feasibility.total=${preview.feasibility?.totalMinutes}`);
    ok("C1 Preview 非 blocked", !preview.blocked && preview.items.length > 0);
    ok("C2 总量=900 且 feasibility 可读", preview.feasibility?.totalMinutes === 900 && preview.feasibility.verdict.length > 0);
    ok("C3 全部落在可排空档（含会议扣除后）", preview.items.every((it) => {
      const s = hm(it.startTime); const e = hm(it.endTime);
      return s >= 19 * 60 && e <= 22 * 60 && e > s;
    }));
    // C4 固定会议（周三 20:00-21:00）不被占用
    const schedSvc = await import("../lib/service/planner-scheduler");
    ok("C4 周三会议 20:00-21:00 未被占用", preview.items.every((it) => {
      const wd = schedSvc.dateToDbWeekday(it.date);
      if (wd !== 2) return true;
      const s = hm(it.startTime); const e = hm(it.endTime);
      return e <= 20 * 60 || s >= 21 * 60;
    }));
    // C5 items 不重叠（同日期相邻不交叉）
    const sorted = [...preview.items].sort((x, y) => (x.date === y.date ? x.startTime.localeCompare(y.startTime) : x.date.localeCompare(y.date)));
    ok("C5 同日期 items 互不重叠", sorted.every((it, i) => i === 0 || sorted[i - 1].date !== it.date || hm(sorted[i - 1].endTime) <= hm(it.startTime)));
    // C6 零落库
    const after = {
      sched: (await pool.query(`select count(*)::int as n from public.schedules where user_id=$1 and goal_id=$2`, [userId, goalId])).rows[0].n as number,
    };
    const actionsAfter = await planRepo.listActionsByGoal(userId, goalId);
    ok("C6 Preview 零落库（schedules 不变 / actions 仍 pending）", after.sched === before.sched && actionsAfter.every((a) => a.status === "pending"));
    // A（验收 #10）：Preview 多次生成仍零落库
    const preview2 = await plannerSvc.generatePlanPreview(userId, goalId);
    const schedA2 = (await pool.query(`select count(*)::int as n from public.schedules where user_id=$1 and goal_id=$2`, [userId, goalId])).rows[0].n as number;
    const actionsA2 = await planRepo.listActionsByGoal(userId, goalId);
    ok("A Preview 二次生成零落库（schedules 不变 / actions 仍 pending）", schedA2 === after.sched && actionsA2.every((a) => a.status === "pending") && (preview2.items?.length ?? 0) > 0);

    // 4. accept
    const accept = await plannerSvc.acceptPlan(userId, goalId, preview.items.map((it) => ({ actionId: it.actionId, date: it.date, startTime: it.startTime, endTime: it.endTime })));
    ok("D1 accept 全部落库", accept.accepted === preview.items.length && accept.updatedActions === 2);
    const afterAccept = {
      sched: (await pool.query(`select count(*)::int as n from public.schedules where user_id=$1 and goal_id=$2`, [userId, goalId])).rows[0].n as number,
    };
    const plannedActions = (await planRepo.listActionsByGoal(userId, goalId)).filter((a) => a.status === "planned").length;
    ok("D2 落库 schedules + actions=planned", afterAccept.sched === preview.items.length && plannedActions === 2);

    // 5. accept 幂等（第二次：accepted=0，schedules 数不变）
    const again = await plannerSvc.acceptPlan(userId, goalId, preview.items.map((it) => ({ actionId: it.actionId, date: it.date, startTime: it.startTime, endTime: it.endTime })));
    const schedAfterAgain = (await pool.query(`select count(*)::int as n from public.schedules where user_id=$1 and goal_id=$2`, [userId, goalId])).rows[0].n as number;
    ok("E1 accept 幂等（第二次 accepted=0、总数不变）", again.accepted === 0 && schedAfterAgain === preview.items.length);
    // E（3b 封版验收）：accept 生成 schedule 后，单个 schedule 完成 ≠ action 完成（action 仍 planned）
    const acceptScheds = await planRepo.listSchedulesByGoal(userId, goalId);
    const targetActionId = acceptScheds[0].action_id;
    await planRepo.updateScheduleStatus(userId, acceptScheds[0].id, "completed");
    const actionStatusAfterSchedDone = await planRepo.getAction(userId, targetActionId!);
    ok("E accept 后 schedule completed，action 仍 planned（状态隔离）", actionStatusAfterSchedDone?.status === "planned");
    await planRepo.updateScheduleStatus(userId, acceptScheds[0].id, "planned"); // 恢复，供后续 reset 断言用
    // B（验收 #11）：accept 后改 availability，旧 schedule 不自动移动（已承诺执行计划）
    const beforeChangeIds = (await planRepo.listSchedulesByGoal(userId, goalId)).map((s) => s.id).sort();
    await avSvc.saveAvailability(userId, [{ weekday: 0, startTime: "08:00", endTime: "09:00", type: "learn", title: "" }]);
    const afterChangeIds = (await planRepo.listSchedulesByGoal(userId, goalId)).map((s) => s.id).sort();
    ok("B accept 后改 availability，schedule 不自动移动", afterChangeIds.length === beforeChangeIds.length && afterChangeIds.join(",") === beforeChangeIds.join(","));

    // 6. reset 不动 manual（先手动加一条 manual schedule）
    await planRepo.createSchedules(userId, [
      { source: "manual", goalId, date: daysFromNow(1), startTime: "14:00", endTime: "15:00", title: "看医生" },
    ]);
    const reset = await plannerSvc.resetGoalPlan(userId, goalId);
    const schedAfterReset = await pool.query(
      `select source, count(*)::int as n from public.schedules where user_id=$1 and goal_id=$2 group by source`,
      [userId, goalId],
    );
    const statuses = (await planRepo.listActionsByGoal(userId, goalId)).map((a) => a.status);
    ok("F1 reset 清 action 计划并回 pending", reset.removedSchedules === preview.items.length && reset.resetActions === 2 && statuses.every((s) => s === "pending"));
    const manualCount = (schedAfterReset.rows.find((x: { source: string }) => x.source === "manual") as { n?: number } | undefined)?.n ?? 0;
    ok("F2 manual schedule 未被 reset 误删", manualCount === 1);

    // 7. 越权
    let blocked = false;
    try {
      await plannerSvc.generatePlanPreview("00000000-0000-4000-8000-000000000000", goalId);
    } catch {
      blocked = true;
    }
    ok("G1 跨用户 Preview 被拒（404）", blocked);

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
