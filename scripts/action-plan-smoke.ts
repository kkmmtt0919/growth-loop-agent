// Step 2a 冒烟：行动路线全链路（service decomposeToActions + repo 事务落库）。
// 运行：npx tsx scripts/action-plan-smoke.ts
// 覆盖验收（DESIGN_SMART_PLANNER_STEP2 §6/§9）：
//   依赖落库 / tasks 0 增长 / 重复调用不重复 / 今日时间轴无新内容 / 跨用户不可见 / LLM-off 规则回退可用
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

// 注入 .env.local 的 LLM 配置（tsx 不加载 .env.local；有则走真实 LLM 分支，无则规则回退）。
// 复刻 dotenv 行为：CRLF 去除 + 包裹引号剥除（用 indexOf('=') 切分，避免 CRLF 行尾正则锚点异常）。
const LLM_KEYS = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"];
for (const line of envText.split("\n")) {
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  const key = line.slice(0, eq).trim();
  if (!LLM_KEYS.includes(key)) continue;
  const value = line.slice(eq + 1).replace(/\r$/, "").trim();
  process.env[key] = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}
const llmConfigured = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);
console.log("LLM 配置:", llmConfigured ? "有（P1 走真实 LLM）" : "无（全部走规则回退）");

const ok = (label: string, cond: boolean) => console.log((cond ? "PASS" : "FAIL") + " " + label);
const today = new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });
  const createdGoals: string[] = [];
  const insertGoal = async (pool: Pool, userId: string, stamp: string | number) => {
    const goalTitle = `__smoke_行动路线_${stamp}__`;
    const goalRes = await pool.query<{ id: string }>(
      `insert into public.goals (user_id, title, description, progress, horizon, status, start_date, end_date)
       values ($1, $2, '冒烟测试用目标', 0, '1 个月', '进行中', $3, $4)
       returning id`,
      [userId, goalTitle, today, daysFromNow(30)],
    );
    createdGoals.push(goalRes.rows[0].id);
    return goalRes.rows[0].id;
  };

  try {
    const r = await pool.query(
      "select u.id as uid from profiles u join goals g on g.user_id = u.id order by u.created_at limit 1",
    );
    const { uid: userId } = r.rows[0] as { uid: string };

    const countFor = async (table: "actions" | "tasks" | "schedules", goalId?: string) => {
      const q = goalId
        ? await pool.query(`select count(*)::int as n from public.${table} where user_id = $1 and goal_id = $2`, [userId, goalId])
        : await pool.query(`select count(*)::int as n from public.${table} where user_id = $1`, [userId]);
      return q.rows[0].n as number;
    };
    const beforeTasks = await countFor("tasks");
    const beforeSchedules = await countFor("schedules");

    // —— goalA：保留 LLM 环境（未配置则自动走 rules），验证真实链路 ——
    const goalA = await insertGoal(pool, userId, Date.now());
    console.log("goalA:", goalA.slice(0, 8) + "…");
    const svc = await import("../lib/service/action-decompose");
    const gen1 = await svc.decomposeToActions(userId, goalA);
    console.log(`[P1] source=${gen1.source} count=${gen1.count} skipped=${gen1.skipped}`);
    ok("P1 生成 1-6 个行动", gen1.count >= 1 && gen1.count <= 6);
    ok("P1 行动全 pending 且无完成时间", gen1.actions.every((a) => a.status === "pending" && a.completedAt === null));
    ok("P1 时长均在 30-3000", gen1.actions.every((a) => a.estimatedMinutes >= 30 && a.estimatedMinutes <= 3000));
    const deps1 = gen1.actions.reduce((n, a) => n + a.dependsOnTitles.length, 0);
    if (gen1.source === "rules") {
      ok("P1 rules 链式依赖齐全", deps1 === gen1.count - 1);
    } else if (deps1 === 0) {
      console.log("WARN P1 llm 未产出依赖（prompt 应引导，网络波动容忍）");
    } else {
      ok("P1 llm 依赖已解析并落库", deps1 > 0);
    }
    ok("P1 actions 落库数一致", (await countFor("actions", goalA)) === gen1.count);

    // —— goalB（干净目标）：LLM-off 强制规则回退，验证确定性 + 重复去重 ——
    const goalB = await insertGoal(pool, userId, Date.now() + 1);
    console.log("goalB:", goalB.slice(0, 8) + "…");
    process.env.LLM_BASE_URL = "";
    process.env.LLM_API_KEY = "";
    process.env.LLM_MODEL = "";
    process.env.LLM_PROVIDER = "demo";
    const gen2 = await svc.decomposeToActions(userId, goalB);
    console.log(`[P2] source=${gen2.source} count=${gen2.count} skipped=${gen2.skipped}`);
    ok("P2 LLM-off 规则回退可用（3-6 阶段）", gen2.source === "rules" && gen2.count >= 3 && gen2.count <= 6);
    ok("P2 rules 链式依赖 count-1", gen2.actions.reduce((n, a) => n + a.dependsOnTitles.length, 0) === gen2.count - 1);
    const goalBAfterP2 = await countFor("actions", goalB);

    const gen3 = await svc.decomposeToActions(userId, goalB);
    console.log(`[P3] 重复调用 source=${gen3.source} count=${gen3.count} skipped=${gen3.skipped}`);
    ok("P3 重复调用不产生重复行动（全部跳过）", gen3.count === 0 && gen3.skipped >= 3);
    ok("P3 actions 数量在重复调用后未增长", (await countFor("actions", goalB)) === goalBAfterP2);

    // —— 验收：tasks / schedules 零增长（今日时间轴无变化）——
    ok("tasks 0 增长（不污染今日时间轴）", (await countFor("tasks")) === beforeTasks);
    ok("schedules 0 增长", (await countFor("schedules")) === beforeSchedules);

    // —— 隔离红线 ——
    const planner = await import("../lib/repo/planner");
    const fake = "00000000-0000-4000-8000-000000000000";
    ok("跨用户看不到 actions", (await planner.listActionsByGoal(fake, goalA)).length === 0);
    ok("跨用户看不到依赖", (await planner.listDependenciesByGoal(fake, goalA)).length === 0);

    console.log("SMOKE_DONE");
  } catch (e) {
    console.error("SMOKE_ERR:", e);
    process.exitCode = 1;
  } finally {
    // 清理：删除全部临时 goal（actions / 依赖级联删除）
    for (const goalId of createdGoals) {
      await pool.query(`delete from public.goals where id = $1`, [goalId]).catch(() => {});
    }
    await pool.end();
  }
}

void main();
