// Step 5c-4 HTTP 冒烟：/weekly 报告 API 排程执行字段（新数据 → UI 卡数据源）。
// 运行：node scripts/weekly-http-e2e.mjs（需本地 dev server）
// 覆盖：无排程周 → content.stats 含 planMinutes=0 / actualMinutes=0 / executionRate=null（「本周暂无 AI 排程」分支数据）；
//       GET 读路径与 POST 一致；manual schedule 完成不计 planMinutes（只计 action）。
const BASE = "http://localhost:3000";
const email = `wk_e2e_${Date.now()}@test.local`;
let token = "";

const ok = (label, cond) => console.log((cond ? "PASS" : "FAIL") + " " + label);
const headers = (extra = {}) => ({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  const reg = await call("POST", "/api/auth/register", { email, password: "TestPass123!" });
  token = reg.data.token;
  ok("注册拿 token", !!token);
  if (!token) process.exit(1);

  // 无排程周 → 新字段存在、null 分支
  const gen = await call("POST", "/api/weekly/report", {});
  const stats = gen.data.report?.content?.stats ?? {};
  ok("新 schema：stats 含 planMinutes/actualMinutes/executionRate", "planMinutes" in stats && "actualMinutes" in stats && "executionRate" in stats);
  ok("无排程周 → planMinutes=0 / actualMinutes=0 / executionRate=null", stats.planMinutes === 0 && stats.actualMinutes === 0 && stats.executionRate === null);

  // 添加并完成一条 manual 排程 → 不计 planMinutes（只计 action schedule）
  const m = await call("POST", "/api/schedules", { title: "跑步", startTime: "18:00", endTime: "18:30" });
  const mId = m.data.schedule?.id;
  await call("PATCH", `/api/schedules/${mId}`, { status: "completed" });
  const gen2 = await call("POST", "/api/weekly/report", {});
  const s2 = gen2.data.report?.content?.stats ?? {};
  ok("manual 完成不进 planMinutes（仍 0）但 actualMinutes 计入 30", s2.planMinutes === 0 && s2.actualMinutes === 30 && s2.executionRate === null);

  // GET 读路径与 POST 一致
  const get = await call("GET", "/api/weekly/report");
  ok("GET 报告与 POST 一致（stats 含新字段）", get.data.report?.content?.stats?.actualMinutes === 30);

  console.log("HTTP_E2E_DONE");
} catch (e) {
  console.error("HTTP_E2E_ERR:", e.message);
  process.exitCode = 1;
} finally {
  if (token) {
    await fetch(`${BASE}/api/availability`, { method: "PUT", headers: headers(), body: JSON.stringify({ items: [] }) }).catch(() => {});
  }
}
