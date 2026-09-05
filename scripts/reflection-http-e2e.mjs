// Step 6c HTTP 冒烟：Reflection 用户入口 + 历史只读（Goal 卡数据源链路）。
// 运行：node scripts/reflection-http-e2e.mjs（需本地 dev server，真实 LLM 不必要）
// 覆盖（DESIGN_SMART_PLANNER_STEP6 §9 + 6c 验收 16-20 的接口层）：
//   16 用户可以创建 reflection（POST manual，goal 级）
//   17 content/rating 落库 + GET 倒序回读（goal_id 过滤）
//   18 历史正确加载（list limit + 排序）
//   19 删除 Goal → UI 数据源无残留（接口层：级联后 GET 为空）
//   20 创建 reflection 不影响 XP/coin
const BASE = "http://localhost:3000";
const email = `rf_e2e_${Date.now()}@test.local`;
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

  // 建一个真实 goal（feedback 需要归属校验）
  const g = await call("POST", "/api/goals", { title: `反馈 e2e 目标 ${Date.now()}`, description: "验证 feedback 链路", horizon: "1 个月" });
  const goalId = g.data.goal?.id;
  ok("创建 goal", !!goalId);

  // 16：创建手动反馈（goal 级，rating bad）
  const c1 = await call("POST", "/api/reflections", { goalId, source: "manual", content: "晚上排得太满，希望少一点", rating: "bad" });
  ok("16 创建成功（manual）", c1.status === 201 && c1.data.reflection?.goal_id === goalId && c1.data.reflection?.rating === "bad");

  // 17：rating/content 落库 + 按 goal 过滤回读倒序
  await call("POST", "/api/reflections", { goalId, source: "manual", content: "节奏不错，继续保持", rating: "good" });
  const list = await call("GET", `/api/reflections?goal_id=${goalId}&limit=10`);
  ok("17 goal 过滤 + 倒序（最新在前）", list.data.reflections?.length === 2 && list.data.reflections[0].content === "节奏不错，继续保持");

  // 18：历史加载（limit 生效 + content 原文回读）
  const lim = await call("GET", `/api/reflections?goal_id=${goalId}&limit=1`);
  ok("18 limit=1 只取最新", lim.data.reflections?.length === 1 && lim.data.reflections[0].rating === "good");

  // 20：XP/coin 不变（注册含欢迎奖励 → 断言创建反馈前后余额不变；toPublicProfile 返回 snake_case 原样行）
  const before = await call("GET", "/api/auth/me");
  await call("POST", "/api/reflections", { goalId, source: "manual", content: "为了校验 XP 再来一条", rating: "good" });
  const afterMe = await call("GET", "/api/auth/me");
  ok("20 创建反馈不影响 XP/coin", afterMe.data.profile?.xp_balance === before.data.profile?.xp_balance && afterMe.data.profile?.coin_balance === before.data.profile?.coin_balance);

  // 19：删除 Goal → 关联反馈级联消失（前端「删 Goal 无残留」的数据源保证）
  await call("DELETE", `/api/goals/${goalId}`);
  const after = await call("GET", "/api/reflections?limit=20");
  ok("19 删除 goal 后反馈为空（无残留）", (after.data.reflections ?? []).length === 0);

  console.log("HTTP_E2E_DONE");
} catch (e) {
  console.error("HTTP_E2E_ERR:", e.message);
  process.exitCode = 1;
}
