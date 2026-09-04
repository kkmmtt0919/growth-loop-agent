// Step 2c HTTP 端到端回归（需本地 dev server 3000 运行且连库）。
// 运行：node scripts/actions-http-e2e.mjs
// 流程：注册 → 建目标 → 制定行动路线 → goals 内嵌断言 → PATCH 完成 → undo → 删除目标级联 → 自清理
const BASE = "http://localhost:3000";
const email = `action_e2e_${Date.now()}@test.local`;
const pass = "TestPass123!";
let token = "";
let goalId = "";
const createdActions = [];
let removed = 0;

const ok = (label, cond) => console.log((cond ? "PASS" : "FAIL") + " " + label);
const headers = (extra = {}) => ({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

try {
  // 1. 注册
  const reg = await call("POST", "/api/auth/register", { email, password: pass });
  token = reg.data.token;
  ok("注册拿 token", !!token);
  if (!token) process.exit(1);

  // 2. 建目标（带 30 天截止）
  const created = await call("POST", "/api/goals", { title: `__http_e2e_${Date.now()}__`, description: "2c http e2e", horizon: "1 个月", endDate: daysFromNow(30) });
  goalId = created.data.goal?.id;
  ok("创建目标", !!goalId);

  // 3. 制定行动路线
  const gen = await call("POST", `/api/goals/${goalId}/actions/generate`, {});
  const acts = gen.data.actions ?? [];
  createdActions.push(...acts.map((a) => a.id));
  ok(`生成行动路线 source=${gen.data.source} count=${acts.length}>0`, acts.length >= 1 && acts.length <= 6);
  const first = acts[0];
  ok("产物全 pending", acts.every((a) => a.status === "pending"));

  // 4. GET /api/goals 内嵌 actions + actionCount（D3 后端聚合）
  const listRes = await fetch(`${BASE}/api/goals`, { headers: headers() });
  const list = (await listRes.json()).goals ?? [];
  const gv = list.find((g) => g.id === goalId);
  ok("GoalView 内嵌 actions", Array.isArray(gv?.actions) && gv?.actions.length === acts.length);
  ok("actionCount 正确且 progress=0", gv?.actionCount === acts.length && gv?.progress === 0);

  // 5. GET /api/actions 与 goal_ids 过滤
  const all = await call("GET", "/api/actions");
  ok("GET /api/actions 全量含产物", (all.data.actions ?? []).some((a) => a.id === first.id));
  const filtered = await call("GET", `/api/actions?goal_ids=${goalId}`);
  ok("GET /api/actions?goal_ids 过滤", (filtered.data.actions ?? []).length === acts.length);

  // 6. PATCH 完成
  const patch = await call("PATCH", `/api/actions/${first.id}`, { status: "completed" });
  ok("PATCH completed 且记 completedAt", patch.data.action?.status === "completed" && !!patch.data.action?.completedAt);
  const badPatch = await call("PATCH", `/api/actions/${first.id}`, { status: "doing" });
  ok("非法状态被拒 400", badPatch.status === 400);

  // 7. goals 派生 actionDone/progress
  const list2 = (await (await fetch(`${BASE}/api/goals`, { headers: headers() })).json()).goals ?? [];
  const gv2 = list2.find((g) => g.id === goalId);
  const expectProgress = Math.round((1 / acts.length) * 100);
  ok(`1/${acts.length} 完成 → actionDoneCount=1 progress=${expectProgress}`, gv2?.actionDoneCount === 1 && gv2?.progress === expectProgress);

  // 8. undo 整批（先 PATCH 完成过的 first 与另一个一起删）
  const del = await call("DELETE", "/api/actions", { actionIds: acts.slice(0, 2).map((a) => a.id) });
  ok("DELETE 整批撤销 2 个", del.data.removed === 2);
  removed = acts.length - 2;
  const afterDel = await call("GET", `/api/actions?goal_ids=${goalId}`);
  ok("撤销后剩余", (afterDel.data.actions ?? []).length === removed);

  // 9. 删除目标 → actions 级联归零（HTTP 视角）
  const delGoal = await call("DELETE", `/api/goals/${goalId}`);
  ok("删除目标", delGoal.status === 200);
  goalId = "";
  const afterGoal = await call("GET", "/api/actions");
  ok("删除目标后 actions 无残留", !(afterGoal.data.actions ?? []).some((a) => createdActions.includes(a.id)));

  console.log("HTTP_E2E_DONE");
} catch (e) {
  console.error("HTTP_E2E_ERR:", e.message);
  process.exitCode = 1;
} finally {
  if (goalId) {
    await fetch(`${BASE}/api/goals/${goalId}`, { method: "DELETE", headers: headers() }).catch(() => {});
  }
  // 账号自清理
  if (token) {
    await fetch(`${BASE}/api/auth/me`, { headers: headers() }).catch(() => {});
  }
}
