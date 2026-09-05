// Step 4 HTTP 端到端（需本地 dev server 3000 + 连库；真实 LLM 全链路验证今日时间轴）。
// 运行：node scripts/timeline-http-e2e.mjs
// 覆盖：B action 显示 / D fixed 规则 / E PATCH 完成隔离 / manual 增删 / reset 不动 manual / 改 availability 不移动
const BASE = "http://localhost:3000";
const email = `tl_e2e_${Date.now()}@test.local`;
let token = "";
let goalId = "";

const ok = (label, cond) => console.log((cond ? "PASS" : "FAIL") + " " + label);
const headers = (extra = {}) => ({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const weekdayToday = () => {
  // 0=周一 … 6=周日
  const d = new Date();
  return (d.getDay() + 6) % 7;
};
const getToday = async () => (await call("GET", "/api/schedules/today")).data.items ?? [];

try {
  const reg = await call("POST", "/api/auth/register", { email, password: "TestPass123!" });
  token = reg.data.token;
  ok("注册拿 token", !!token);
  if (!token) process.exit(1);

  // 每天 19-22 可排空档（保证今天必出 action 排程）
  const avItems = [];
  for (let w = 0; w <= 6; w++) avItems.push({ weekday: w, startTime: "19:00", endTime: "22:00", type: "learn", title: "" });
  await call("PUT", "/api/availability", { items: avItems });

  // goal + 行动路线 + accept
  const g = await call("POST", "/api/goals", { title: `__http_tl_${Date.now()}__`, description: "4 http e2e", horizon: "1 个月" });
  goalId = g.data.goal?.id;
  ok("创建目标", !!goalId);
  const gen = await call("POST", `/api/goals/${goalId}/actions/generate`, {});
  const acts = gen.data.actions ?? [];
  ok(`生成行动路线 source=${gen.data.source} count=${acts.length}`, acts.length >= 1);
  const plan = await call("POST", `/api/goals/${goalId}/plan`, {});
  ok("Preview 有排程", !plan.data.blocked && (plan.data.items ?? []).length > 0);
  const items = plan.data.items.map((it) => ({ actionId: it.actionId, date: it.date, startTime: it.startTime, endTime: it.endTime }));
  const acc = await call("POST", `/api/goals/${goalId}/plan/accept`, { items });
  ok(`accept accepted=${acc.data.accepted}`, acc.data.accepted === items.length);

  // B：今天时间轴出现 action 排程
  const tl1 = await getToday();
  const actionItems = tl1.filter((i) => i.type === "action");
  ok(`B action schedule 出现在今日时间轴（${actionItems.length} 条）`, actionItems.length >= 1);
  ok("B 无 fixed（此时无固定块）", !tl1.some((i) => i.type === "fixed"));

  // E：完成一个 action schedule → 对应 action 仍 planned（状态隔离）
  const target = actionItems[0];
  const patched = await call("PATCH", `/api/schedules/${target.scheduleId}`, { status: "completed" });
  ok("E1 PATCH completed 成功", patched.data.success === true && patched.data.schedule?.status === "completed");
  const gv = ((await call("GET", "/api/goals")).data.goals ?? []).find((x) => x.id === goalId);
  const actionRow = (gv?.actions ?? []).find((a) => a.id === target.actionId);
  ok("E2 schedule completed → action 仍 planned（隔离）", actionRow?.status === "planned");
  const undo = await call("PATCH", `/api/schedules/${target.scheduleId}`, { status: "planned" });
  ok("F 撤销完成 → planned", undo.data.schedule?.status === "planned");

  // D：改 availability 增加今天固定块（title≠''）→ fixed 显示；旧 schedule 不移动
  const wd = weekdayToday();
  const beforeIds = (await getToday()).filter((i) => i.type === "action").map((i) => i.scheduleId).sort().join(",");
  const av2 = [];
  for (let w = 0; w <= 6; w++) av2.push({ weekday: w, startTime: "19:00", endTime: "22:00", type: "learn", title: "" });
  av2.push({ weekday: wd, startTime: "20:30", endTime: "21:30", type: "exercise", title: "健身" });
  await call("PUT", "/api/availability", { items: av2 });
  const tl2 = await getToday();
  const fixed = tl2.filter((i) => i.type === "fixed");
  ok("D1 fixed（今天 title='健身'）显示", fixed.length === 1 && fixed[0].title === "健身" && fixed[0].startTime === "20:30");
  ok("D2 空档（title=''）不作为 fixed 显示", fixed.every((i) => i.title !== ""));
  const afterIds = (await getToday()).filter((i) => i.type === "action").map((i) => i.scheduleId).sort().join(",");
  ok("D3 改 availability 旧 schedule 不移动", beforeIds === afterIds && beforeIds.length > 0);

  // manual：添加 → 显示 → reset 后仍在 → 删除
  const m = await call("POST", "/api/schedules", { title: "买咖啡", startTime: "16:00", endTime: "16:30" });
  ok("C1 POST manual 创建", m.status === 201 && !!m.data.schedule?.id);
  const tl3 = await getToday();
  const manualItem = tl3.find((i) => i.type === "manual");
  ok("C2 manual 显示在今日时间轴", !!manualItem && manualItem.title === "买咖啡");
  const reset = await call("POST", `/api/goals/${goalId}/plan/reset`, {});
  const tl4 = await getToday();
  ok("C3 reset 清 action 排程、manual 仍在", reset.data.removedSchedules > 0 && tl4.some((i) => i.type === "manual") && !tl4.some((i) => i.type === "action"));
  const del = await call("DELETE", `/api/schedules/${manualItem.scheduleId}`, {});
  ok("C4 DELETE manual 移除", del.data.success === true && !(await getToday()).some((i) => i.type === "manual"));

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
