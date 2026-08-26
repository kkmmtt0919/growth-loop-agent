const API = "http://127.0.0.1:3000";
const ts = Date.now();
const email = `smoke-${ts}@growthloop.local`;
const pw = "testpass123";

async function j(res) {
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; }
  catch { return { status: res.status, body: t }; }
}

let failures = 0;
function expect(cond, msg) {
  if (!cond) { console.log("  ✗ FAIL:", msg); failures++; }
  else console.log("  ✓", msg);
}

console.log("1. register");
const reg = await j(await fetch(`${API}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: pw, displayName: "冒烟" }),
}));
expect(reg.status === 200, `register 200 (got ${reg.status})`);
const token = reg.body?.token;
expect(!!token, "token returned");

console.log("2. demo (seed)");
const demo = await j(await fetch(`${API}/api/demo`, { headers: { Authorization: `Bearer ${token}` } }));
expect(demo.status === 200, `demo 200 (got ${demo.status})`);
console.log("  records:", demo.body?.data?.learningLogs?.length);

const auth = { Authorization: `Bearer ${token}` };

console.log("3. GET /api/records/today");
const today = await j(await fetch(`${API}/api/records/today`, { headers: auth }));
expect(today.status === 200, `today 200 (got ${today.status})`);
expect(Array.isArray(today.body?.items), "items is array");
expect(typeof today.body?.tasksDone === "number", "tasksDone number");
expect(typeof today.body?.tasksTotal === "number", "tasksTotal number");
expect(typeof today.body?.completionRate === "number" && today.body.completionRate >= 0 && today.body.completionRate <= 100, "completionRate 0-100");
console.log("  items:", today.body?.items?.length, "tasksDone:", today.body?.tasksDone, "rate:", today.body?.completionRate);

console.log("4. GET /api/records/recent?days=7");
const recent = await j(await fetch(`${API}/api/records/recent?days=7`, { headers: auth }));
expect(recent.status === 200, `recent 200 (got ${recent.status})`);
expect(recent.body?.days?.length === 7, `days length 7 (got ${recent.body?.days?.length})`);
expect(recent.body?.days?.[0]?.label === "今天", "first day label=今天");
expect(typeof recent.body?.weeklyCompletionRate === "number" && recent.body.weeklyCompletionRate >= 0 && recent.body.weeklyCompletionRate <= 100, "weeklyCompletionRate 0-100");
console.log("  days:", recent.body?.days?.length, "weeklyRate:", recent.body?.weeklyCompletionRate, "doneTasks7d:", recent.body?.doneTasks7d, "activeDays:", recent.body?.activeDays);

console.log("5. GET /api/records/history?limit=5");
const history = await j(await fetch(`${API}/api/records/history?limit=5`, { headers: auth }));
expect(history.status === 200, `history 200 (got ${history.status})`);
expect(Array.isArray(history.body?.items), "items array");
expect(typeof history.body?.total === "number", "total number");
expect(typeof history.body?.hasMore === "boolean", "hasMore boolean");
const rid = history.body?.items?.[0]?.id;
expect(!!rid, "got a record id");
console.log("  items:", history.body?.items?.length, "total:", history.body?.total, "hasMore:", history.body?.hasMore, "rid:", rid);

console.log("6. PATCH mood=good");
const p1 = await j(await fetch(`${API}/api/records/${rid}`, {
  method: "PATCH",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ mood: "good" }),
}));
expect(p1.status === 200, `PATCH mood 200 (got ${p1.status})`);
expect(p1.body?.mood === "good", "mood=good persisted");

console.log("7. PATCH remark=测试备注");
const p2 = await j(await fetch(`${API}/api/records/${rid}`, {
  method: "PATCH",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ remark: "测试备注" }),
}));
expect(p2.status === 200, `PATCH remark 200 (got ${p2.status})`);
expect(p2.body?.remark === "测试备注", "remark persisted");

console.log("8. PATCH illegal mood=happy → 400");
const p3 = await j(await fetch(`${API}/api/records/${rid}`, {
  method: "PATCH",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ mood: "happy" }),
}));
expect(p3.status === 400, `illegal mood 400 (got ${p3.status})`);

console.log("9. PATCH body含topic字段 → 被忽略，mood仍更新");
const p4 = await j(await fetch(`${API}/api/records/${rid}`, {
  method: "PATCH",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ mood: "great", topic: "HACK" }),
}));
expect(p4.status === 200, `PATCH 200 (got ${p4.status})`);
expect(p4.body?.mood === "great", "mood=great updated");
expect(p4.body?.topic !== "HACK", "topic NOT changed (whitelist)");

console.log("10. PATCH 不存在 id → 404");
const p5 = await j(await fetch(`${API}/api/records/00000000-0000-0000-0000-000000000000`, {
  method: "PATCH",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ mood: "good" }),
}));
expect(p5.status === 404, `not found 404 (got ${p5.status})`);

console.log("11. history mood 筛选=good");
const hf = await j(await fetch(`${API}/api/records/history?mood=good&limit=50`, { headers: auth }));
expect(hf.status === 200, `history mood filter 200 (got ${hf.status})`);
const allGood = (hf.body?.items ?? []).every((r) => r.mood === "good");
expect(allGood, "all returned items have mood=good");

console.log("");
console.log(failures === 0 ? "✅ SMOKE PASSED (0 failures)" : `❌ SMOKE FAILED (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
