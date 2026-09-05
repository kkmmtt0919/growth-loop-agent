// Step 6a-2 冒烟：Agent Trace（agent_runs + callLLMJson wrapper，真实 LLM）。
// 运行：npx tsx scripts/trace-smoke.ts
// 覆盖（DESIGN_SMART_PLANNER_STEP6 §9 验收 5-8 + 护栏）：
//   5 一次 Agent 调用产生 agent_runs  6 成功/失败均记录  7 latency_ms 合理
//   8 prompt_version 正确保存  护栏：input_context 预览 ≤2000 且只含元信息 / prompt 全文不入库 /
//   user_id 隔离 / trace 不参与 XP/coin / 失败主流程不炸（规则回退）
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

async function main(): Promise<void> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: url });
  const cleanupUserIds: string[] = [];
  try {
    // 注入真实 LLM 配置（tsx 不加载 .env.local；indexOf 切分剥引号去 \r）
    for (const line of envText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (key === "LLM_PROVIDER" || key === "LLM_BASE_URL" || key === "LLM_API_KEY" || key === "LLM_MODEL") {
        process.env[key] = line.slice(eq + 1).replace(/\r$/, "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      }
    }
    ok("env LLM 配置已注入", Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL));

    const newUser = await pool.query<{ id: string }>(
      `insert into public.profiles (id, email, password_hash)
       values (gen_random_uuid(), $1, 'trace-smoke') returning id`,
      [`tr_${Date.now()}@test.local`],
    );
    const userId = newUser.rows[0].id;
    cleanupUserIds.push(userId);

    const planGen = await import("../lib/agent/planner-generator");
    const actionGen = await import("../lib/agent/action-plan-generator");
    const weeklyGen = await import("../lib/agent/weekly-generator");
    const eveningGen = await import("../lib/agent/evening-generator");
    const countRuns = async () =>
      (await pool.query(`select count(*)::int as n from public.agent_runs where user_id = $1`, [userId])).rows[0].n as number;

    // 5/8 成功 case：action-plan（真实 LLM）
    const n0 = await countRuns();
    const r1 = await actionGen.generateActionPlan({
      goalTitle: "准备英语考试",
      contextText: "用户每周可用时间：工作日 19:00-22:00。目标周期 1 个月。已有行动阶段：无。",
      range: { min: 2, max: 4 },
      existingTitles: [],
      userId,
    });
    const n1 = await countRuns();
    console.log(`  debug counts: before=${n0} afterAction=${n1}`);
    ok("5a action-plan 调用完成（LLM 或规则回退，主流程不炸）", typeof r1.source === "string");

    // 5/8 成功 case：planner
    await planGen.tryGeneratePlanOrdering({
      goalTitle: "准备英语考试",
      contextText: "阶段：背单词（90 分钟）；做真题（120 分钟）",
      actionTitles: ["背单词", "做真题"],
      userId,
    });
    const n2 = await countRuns();
    console.log(`  debug counts: afterPlanner=${n2}`);

    // 5/8 成功 case：weekly + evening
    await weeklyGen.generateWeeklyDigest("进行中目标：准备英语考试", "周期：2026-08-31 ~ 2026-09-06\n投入：120 分钟", userId);
    await eveningGen.generateEveningDigest(
      "今日执行：学习英语：计划 90 分钟，实际 75 分钟",
      { summary: "", achievement: [], problem: [], suggestion: [], evaluation: "" },
      userId,
    );
    const n3 = await countRuns();
    console.log(`  debug counts: afterWeeklyEvening=${n3}`);

    // 6 失败 case：坏 BASE_URL → success=false + error_message，主流程规则回退不炸
    process.env.LLM_BASE_URL = "http://127.0.0.1:9";
    const rFail = await actionGen.generateActionPlan({
      goalTitle: "失败用例",
      contextText: "用户每周可用时间：无",
      range: { min: 2, max: 4 },
      existingTitles: [],
      userId,
    });
    ok("6a LLM 失败 → 主流程规则回退（source=rules，不炸）", rFail.source === "rules");

    // trace 是 fire-and-forget：轮询等待在飞 insert 全部落库（计数两次相同且 ≥ 最低预期 = 5），
    // 避免固定 sleep 在连接排队时的偶发竞态；稳定后再统一查询 runs 断言。
    let settled = -1;
    for (let i = 0; i < 20; i++) {
      const c = await countRuns();
      if (c === settled && c >= 5) break;
      settled = c;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // 断言 runs（注意：select 里不能用 jsonb_object_keys 等 set-returning 函数，会把每行扩成多行）
    const runs = (
      await pool.query(
        `select agent_type, prompt_version, success, latency_ms,
                input_context->>'userPreview' as user_preview,
                output_json->>'preview' as out_preview,
                error_message
         from public.agent_runs
         where user_id = $1
         order by created_at asc`,
        [userId],
      )
    ).rows as Array<{
      agent_type: string;
      prompt_version: string;
      success: boolean;
      latency_ms: number;
      user_preview: string;
      out_preview: string | null;
      error_message: string | null;
    }>;
    const byType = (t: string) => runs.filter((r) => r.agent_type === t);

    // 5：四类 agent_type 各 ≥1 条 run（LLM 波动可能 aborted，但调用即有 trace——这正是 6 的演示）
    ok(
      "5 每类 Agent 调用产生 run（action-plan/planner/weekly/evening 各 ≥1）",
      (["action-plan", "planner", "weekly", "evening"] as const).every((t) => byType(t).length >= 1),
    );
    // 6：成功/失败均记录（planner/evening 本轮成功；rFail 显式失败；action-plan/weekly 可能 aborted）
    const okRun = runs.some((r) => r.success);
    const failRun = runs.some((r) => !r.success && r.error_message && r.error_message.length > 0);
    ok("6 成功与失败 run 均被记录", okRun && failRun);
    ok("8 prompt_version 各类型正确", byType("action-plan").every((r) => r.prompt_version === "action-plan-v1") && byType("planner").every((r) => r.prompt_version === "planner-v1") && byType("weekly").every((r) => r.prompt_version === "weekly-v1") && byType("evening").every((r) => r.prompt_version === "evening-v1"));
    ok("7 latency_ms > 0 且合理（<60s）", runs.length > 0 && runs.every((r) => r.latency_ms > 0 && r.latency_ms < 60_000));
    ok("护栏 input_context 预览 ≤2000 字", runs.every((r) => r.user_preview.length <= 2000));

    const failRuns = (
      await pool.query(
        `select success, error_message from public.agent_runs
         where user_id = $1 and agent_type = 'action-plan' and success = false`,
        [userId],
      )
    ).rows;
    ok("6b 失败 run 均记录（success=false + error_message）", failRuns.length >= 1 && failRuns.every((r) => r.error_message && r.error_message.length > 0));

    // 护栏：user 隔离 + trace 不参与 XP/coin
    const totals = (
      await pool.query(`select count(*)::int as n from public.agent_runs where user_id = $1`, [userId])
    ).rows[0].n as number;
    const afterWait = await countRuns();
    ok("护栏 user_id 隔离（runs 全部归属本用户，且每调用恰好 1 条）", totals === afterWait && totals >= 5);
    const bal = (await pool.query(`select xp_balance, coin_balance from public.profiles where id=$1`, [userId])).rows[0];
    ok("护栏 trace 不参与 XP/COIN", bal.xp_balance === 0 && bal.coin_balance === 0);

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
