// Step 7c e2e：GET /api/agent-runs（HTTP 层，专属临时用户）。
// 运行：node scripts/agent-runs-http-e2e.mjs
// 覆盖（DESIGN_SMART_PLANNER_STEP7 验收 25）：
//   A 未登录 401
//   B 登录后可查最近记录（字段裁剪：仅 agentType/promptVersion/success/latencyMs/createdAt/id）
//   C 不暴露 input_context / output_json / error_message 明文
//   D 用户隔离：他人数据不出现
//   E 有真实数据时 runs 非空且倒序
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const envText = readFileSync(join(root, ".env.local"), "utf8");
const dbUrl = envText
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="))
  .slice(13)
  .trim()
  .replace(/[?&]sslmode=[^&]*/g, "");
process.env.DATABASE_URL = dbUrl;

const BASE = "http://localhost:3000";
let passed = 0;
let failed = 0;
const ok = (label, cond) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (cond) {
    passed++;
  } else {
    failed++;
  }
};

async function main() {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: dbUrl });
  const emails = [];
  const userIds = [];
  try {
    // A：未登录 401
    const anon = await fetch(`${BASE}/api/agent-runs`);
    ok("A 未登录 401", anon.status === 401);

    // 注册临时用户（register 直连 HTTP，走欢迎奖励也无妨）
    const mkUser = async () => {
      const email = `ar_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.local`;
      emails.push(email);
      const reg = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "TestPass123!" }),
      });
      if (reg.status !== 200) throw new Error("register failed " + reg.status);
      const rd = await reg.json();
      const { rows } = await pool.query("select id from public.profiles where email = $1", [email]);
      userIds.push(rows[0].id);
      return { token: rd.token, email };
    };
    const u1 = await mkUser();
    const u2 = await mkUser();
    const auth1 = { Authorization: `Bearer ${u1.token}` };

    // B：新用户空列表（shape 正确）
    const emptyResp = await fetch(`${BASE}/api/agent-runs?limit=20`, { headers: auth1 });
    const empty = await emptyResp.json();
    ok("B1 登录后可查（200 + runs 数组）", emptyResp.status === 200 && Array.isArray(empty.runs));

    // 直插两条含"明文"的 run（u1），一条失败、一条成功、u2 一条
    const insertRun = async (uid, agentType, promptVersion, success, latencyMs, extra) => {
      await pool.query(
        `insert into public.agent_runs (user_id, agent_type, prompt_version, input_context, output_json, latency_ms, success, error_message)
         values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
        [
          uid, agentType, promptVersion,
          JSON.stringify({ systemLength: 1200, userPreview: extra ?? "SECRET_USER_PREVIEW_XYZ" }),
          success ? JSON.stringify({ text: "SECRET_OUTPUT_XYZ" }) : null,
          latencyMs, success,
          success ? null : "SECRET_ERROR_MSG",
        ],
      );
    };
    await insertRun(userIds[0], "planner", "planner-v1", true, 1234);
    await insertRun(userIds[0], "action-plan", "action-plan-v1", false, 500);
    await insertRun(userIds[1], "evening", "evening-v1", true, 900);

    // C + E：u1 列表倒序、字段裁剪、无明文
    const listResp = await fetch(`${BASE}/api/agent-runs?limit=20`, { headers: auth1 });
    const list = await listResp.json();
    ok("E1 有数据时 runs 非空", Array.isArray(list.runs) && list.runs.length >= 2);
    ok("E2 按时间倒序", list.runs.length >= 2 && new Date(list.runs[0].createdAt) >= new Date(list.runs[list.runs.length - 1].createdAt));
    const first = list.runs[0];
    const allowedKeys = new Set(["id", "agentType", "promptVersion", "success", "latencyMs", "createdAt"]);
    const keysOk = Object.keys(first).every((k) => allowedKeys.has(k));
    ok("C1 仅暴露白名单字段", keysOk);
    const raw = JSON.stringify(list.runs);
    ok("C2 不暴露 input_context", !raw.includes("SECRET_USER_PREVIEW_XYZ") && !raw.includes("input_context"));
    ok("C3 不暴露 output_json", !raw.includes("SECRET_OUTPUT_XYZ") && !raw.includes("output_json"));
    ok("C4 不暴露 error_message", !raw.includes("SECRET_ERROR_MSG") && !raw.includes("error_message"));
    ok("C5 字段 camelCase 且值正确", list.runs.some((r) => r.promptVersion === "planner-v1" && typeof r.latencyMs === "number" && typeof r.success === "boolean"));

    // D：用户隔离——u2 只能看到自己的 evening 一条
    const u2reg = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: u2.email, password: "TestPass123!" }),
    });
    const u2d = await u2reg.json();
    const u2Resp = await fetch(`${BASE}/api/agent-runs?limit=20`, { headers: { Authorization: `Bearer ${u2d.token}` } });
    const u2list = await u2Resp.json();
    ok("D 用户隔离（u2 仅见 own run）", u2list.runs.length === 1 && u2list.runs[0].agentType === "evening");

    console.log(`\n=== agent-runs HTTP e2e: ${passed} passed, ${failed} failed ===`);
  } finally {
    // 级联清理：删 profiles → agent_runs on delete cascade
    if (userIds.length > 0) {
      await pool.query("delete from public.profiles where id = any($1::uuid[])", [userIds]);
    }
    await pool.end();
    console.log("cleanup done");
  }
}

main().catch((e) => {
  console.error("e2e error:", e.message);
  process.exit(1);
});
