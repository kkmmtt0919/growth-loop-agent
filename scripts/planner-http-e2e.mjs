// Step 3a HTTP 端到端（需本地 dev server 3000 + 连库；验证真实 LLM ordering + accept 幂等 + reset）。
// 运行：node scripts/planner-http-e2e.mjs
const BASE = "http://localhost:3000";
const email = `plan_e2e_${Date.now()}@test.local`;
let token = "";
let goalId = "";
let acceptedFirst = 0;

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
const findByGoal = async (id) => {
  const res = await fetch(`${BASE}/api/goals`, { headers: headers() });
  return ((await res.json()).goals ?? []).find((g) => g.id === id);
};

try {
  const reg = await call("POST", "/api/auth/register", { email, password: "TestPass123!" });
  token = reg.data.token;
  ok("注册拿 token", !!token);
  if (!token) process.exit(1);

  // availability：工作日 19-22 空档 + 周三 20-21 会议
  const avItems = [];
  for (let w = 0; w <= 4; w++) avItems.push({ weekday: w, startTime: "19:00", endTime: "22:00", type: "learn", title: "" });
  avItems.push({ weekday: 2, startTime: "20:00", endTime: "21:00", type: "work", title: "会议" });
  const av = await call("PUT", "/api/availability", { items: avItems });
  ok("PUT availability 保存", av.data.success === true && av.data.items.length === 6);
  const avGet = await call("GET", "/api/availability");
  ok("GET availability 回显", (avGet.data.items ?? []).length === 6);

  // goal + actions
  const g = await call("POST", "/api/goals", { title: `__http_plan_${Date.now()}__`, description: "3a http e2e", horizon: "1 个月", endDate: daysFromNow(30) });
  goalId = g.data.goal?.id;
  ok("创建目标", !!goalId);
  const gen = await call("POST", `/api/goals/${goalId}/actions/generate`, {});
  const acts = gen.data.actions ?? [];
  ok(`生成行动路线 source=${gen.data.source} count=${acts.length}`, acts.length >= 1);

  // Preview（不落库）
  const plan = await call("POST", `/api/goals/${goalId}/plan`, {});
  console.log(`[Preview] source=${plan.data.source} items=${(plan.data.items ?? []).length} blocked=${plan.data.blocked ?? "-"}`);
  ok("Preview 非 blocked 且有 items", !plan.data.blocked && (plan.data.items ?? []).length > 0);
  ok("feasibility 可读", typeof plan.data.feasibility?.totalMinutes === "number" && !!plan.data.feasibility?.message);
  const gvBefore = await findByGoal(goalId);
  ok("Preview 后 actions 仍全 pending（零落库）", (gvBefore?.actions ?? []).every((a) => a.status === "pending"));

  // accept
  const items = plan.data.items.map((it) => ({ actionId: it.actionId, date: it.date, startTime: it.startTime, endTime: it.endTime }));
  const acc = await call("POST", `/api/goals/${goalId}/plan/accept`, { items });
  acceptedFirst = acc.data.accepted ?? 0;
  ok(`accept 落库 accepted=${acceptedFirst}`, acceptedFirst === items.length);
  const gvAfter = await findByGoal(goalId);
  ok("accept 后 actions 出现 planned", (gvAfter?.actions ?? []).some((a) => a.status === "planned"));

  // accept 幂等
  const acc2 = await call("POST", `/api/goals/${goalId}/plan/accept`, { items });
  ok(`accept 幂等（第二次 accepted=0）`, acc2.data.accepted === 0);
  const gvStill = await findByGoal(goalId);
  const plannedCount = (gvStill?.actions ?? []).filter((a) => a.status === "planned").length;
  ok("planned 数未因重复 accept 增加", plannedCount === acts.length);

  // reset
  const reset = await call("POST", `/api/goals/${goalId}/plan/reset`, {});
  ok(`reset 清空 removed=${reset.data.removedSchedules}`, reset.data.removedSchedules === acceptedFirst);
  const gvReset = await findByGoal(goalId);
  ok("reset 后 actions 回 pending", (gvReset?.actions ?? []).every((a) => a.status === "pending"));

  console.log("HTTP_E2E_DONE");
} catch (e) {
  console.error("HTTP_E2E_ERR:", e.message);
  process.exitCode = 1;
} finally {
  if (token) {
    if (goalId) await fetch(`${BASE}/api/goals/${goalId}`, { method: "DELETE", headers: headers() }).catch(() => {});
    await fetch(`${BASE}/api/availability`, { method: "PUT", headers: headers(), body: JSON.stringify({ items: [] }) }).catch(() => {});
  }
}
