// Step 6a-1 冒烟：Reflection（service 层，专属临时用户）。
// 运行：npx tsx scripts/reflection-smoke.ts
// 覆盖（DESIGN_SMART_PLANNER_STEP6 §9 验收 1-4）：
//   1 只能写自己的 reflection  2 goal/action 越权拒绝  3 删除级联  4 不影响 XP/COIN
//   + 校验（content/source/rating）、goal 一致性、list 倒序/limit
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
const P = "__smoke_reflection_";
const today = new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const cleanupUserIds: string[] = [];
  try {
    const mkUser = async (email: string) => {
      const nu = await pool.query<{ id: string }>(
        `insert into public.profiles (id, email, password_hash)
         values (gen_random_uuid(), $1, 'reflection-smoke') returning id`,
        [email],
      );
      cleanupUserIds.push(nu.rows[0].id);
      return nu.rows[0].id;
    };
    const userId = await mkUser(`rf_${Date.now()}@test.local`);

    const reflectionSvc = await import("../lib/service/reflection");
    const planRepo = await import("../lib/repo/planner");
    const { ServiceError } = await import("../lib/service/errors");

    const expectError = async (fn: () => Promise<unknown>, status: number) => {
      try {
        await fn();
        return false;
      } catch (e) {
        return e instanceof ServiceError && e.status === status;
      }
    };

    // 目标 + 行动
    const goalRes = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
       values ($1, $2, 'reflection 冒烟', 0, '1 个月', '进行中', $3, $3) returning id`,
      [userId, `${P}goal_${Date.now()}`, today],
    );
    const goalId = goalRes.rows[0].id;
    const acts = await planRepo.createActions(userId, [{ goalId, title: `${P}阶段甲`, estimatedMinutes: 120 }]);
    const actionId = acts[0].id;

    // 1. 创建成功（goal+action 关联）
    const r1 = await reflectionSvc.addReflection(userId, {
      goalId, actionId, source: "planner", content: `${P}工作日晚间太累，希望少排一点`, rating: "bad",
    });
    ok("1 创建成功（goal+action+rating 落库）", r1.goal_id === goalId && r1.action_id === actionId && r1.rating === "bad");

    // 2. 校验
    ok("2a content 空/超长 → 400",
      (await expectError(() => reflectionSvc.addReflection(userId, { goalId, source: "manual", content: "" }), 400)) &&
      (await expectError(() => reflectionSvc.addReflection(userId, { goalId, source: "manual", content: "x".repeat(501) }), 400)));
    ok("2b source 非法 → 400", await expectError(() => reflectionSvc.addReflection(userId, { goalId, source: "other", content: "x" }), 400));
    ok("2c rating 非法 → 400", await expectError(() => reflectionSvc.addReflection(userId, { goalId, source: "manual", content: "x", rating: "mid" }), 400));
    ok("2d goal/action 都不传 → 400", await expectError(() => reflectionSvc.addReflection(userId, { source: "manual", content: "x" }), 400));

    // 3. 越权（别的用户的 goal/action → 404）
    const strangerGoal = "00000000-0000-4000-8000-000000000001";
    const strangerAction = "00000000-0000-4000-8000-000000000002";
    ok("3a 越权 goal → 404", await expectError(() => reflectionSvc.addReflection(userId, { goalId: strangerGoal, source: "manual", content: "x" }), 404));
    ok("3b 越权 action → 404", await expectError(() => reflectionSvc.addReflection(userId, { actionId: strangerAction, source: "manual", content: "x" }), 404));

    // 4. goal 一致性（action 属于另一 goal → 400）
    const goal2 = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, progress, horizon, status, start_date, end_date)
       values ($1, $2, 0, '1 个月', '进行中', $3, $3) returning id`,
      [userId, `${P}goal2`, today],
    );
    ok("4 goal 与 action 不一致 → 400", await expectError(() => reflectionSvc.addReflection(userId, { goalId: goal2.rows[0].id, actionId, source: "manual", content: "x" }), 400));

    // 5. list 倒序 + limit + 按 goal 过滤
    await reflectionSvc.addReflection(userId, { goalId, source: "weekly", content: `${P}第二条反馈`, rating: "good" });
    const list = await reflectionSvc.listReflectionsForUser(userId, { limit: 20 });
    ok("5a list 倒序（最新在前）", list.length === 2 && list[0].content === `${P}第二条反馈`);
    const limited = await reflectionSvc.listReflectionsForUser(userId, { limit: 1 });
    ok("5b limit=1 只取最新", limited.length === 1 && limited[0].content === `${P}第二条反馈`);
    const byGoal = await reflectionSvc.listReflectionsForUser(userId, { goalId });
    ok("5c 按 goal 过滤", byGoal.length === 2);

    // 6. XP/COIN 不变
    const b = (await pool.query(`select xp_balance, coin_balance from public.profiles where id=$1`, [userId])).rows[0];
    ok("6 反馈不影响 XP/COIN", b.xp_balance === 0 && b.coin_balance === 0);

    // 7. 级联：删 goal → 该 goal 反馈消失（action cascade → action 反馈消失）
    await pool.query(`delete from public.goals where id = $1`, [goalId]);
    const afterCascade = await reflectionSvc.listReflectionsForUser(userId, { limit: 20 });
    ok("7 删除 goal 后关联反馈级联消失", afterCascade.length === 0);

    // 8. 用户隔离（另一用户 list 为空）
    const other = await mkUser(`rf2_${Date.now()}@test.local`);
    const otherList = await reflectionSvc.listReflectionsForUser(other, { limit: 20 });
    ok("8 用户隔离（他人 list 为空）", otherList.length === 0);

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
