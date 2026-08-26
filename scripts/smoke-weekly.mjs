const API = "http://127.0.0.1:3000";
const ts = Date.now();
const email = `smoke-weekly-${ts}@growthloop.local`;
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
  body: JSON.stringify({ email, password: pw, displayName: "周报冒烟" }),
}));
expect(reg.status === 200, `register 200 (got ${reg.status})`);
const token = reg.body?.token;
expect(!!token, "token returned");

const auth = { Authorization: `Bearer ${token}` };

console.log("2. demo (seed)");
const demo = await j(await fetch(`${API}/api/demo`, { headers: auth }));
expect(demo.status === 200, `demo 200 (got ${demo.status})`);

console.log("3. GET /api/weekly/report (未生成 → report null)");
const g1 = await j(await fetch(`${API}/api/weekly/report`, { headers: auth }));
expect(g1.status === 200, `GET 200 (got ${g1.status})`);
expect(g1.body?.report === null, "report=null（未生成）");

console.log("4. POST /api/weekly/report (生成)");
const p1 = await j(await fetch(`${API}/api/weekly/report`, {
  method: "POST",
  headers: auth,
}));
expect(p1.status === 200, `POST 200 (got ${p1.status})`);
expect(!!p1.body?.report?.content, "返回 content");
expect(p1.body?.created === true, "首次 created=true");
expect(typeof p1.body?.periodStart === "string", "periodStart 字符串");
expect(typeof p1.body?.periodEnd === "string", "periodEnd 字符串");
const content = p1.body?.report?.content ?? {};
expect(typeof content?.schemaVersion === "number", "content.schemaVersion number");
expect(content?.replySource === "llm" || content?.replySource === "rules", "replySource ∈ {llm,rules}");
expect(!!content?.stats, "content.stats 存在");
expect(typeof content?.stats?.completionRate === "number", "stats.completionRate number");
expect(Array.isArray(content?.goalSuggestions), "goalSuggestions array");
expect(Array.isArray(content?.achievement), "achievement array");
expect(Array.isArray(content?.problem), "problem array");
expect(Array.isArray(content?.suggestion), "suggestion array");
expect(typeof content?.summary === "string", "summary 字符串");
console.log("  replySource:", content.replySource, "summary:", content.summary?.slice(0, 40));

console.log("5. POST 再次生成 → 幂等（created=false）");
const p2 = await j(await fetch(`${API}/api/weekly/report`, {
  method: "POST",
  headers: auth,
}));
expect(p2.status === 200, `POST 200 (got ${p2.status})`);
expect(p2.body?.created === false, "二次 created=false");
expect(p2.body?.id === p1.body?.id, "同一行 id 不变");

console.log("6. GET /api/weekly/report (生成后 → 返回报告)");
const g2 = await j(await fetch(`${API}/api/weekly/report`, { headers: auth }));
expect(g2.status === 200, `GET 200 (got ${g2.status})`);
expect(!!g2.body?.report, "report 非 null");
expect(g2.body?.report?.id === p1.body?.id, "GET 与 POST 同一报告");

console.log("7. GET /api/weekly/list (历史分页)");
const l1 = await j(await fetch(`${API}/api/weekly/list?limit=10&offset=0`, { headers: auth }));
expect(l1.status === 200, `list 200 (got ${l1.status})`);
expect(Array.isArray(l1.body?.reports), "reports array");
expect(typeof l1.body?.total === "number", "total number");
expect(l1.body?.total >= 1, "至少 1 条");
expect(l1.body?.reports?.some((r) => r.id === p1.body?.id), "list 包含刚生成的报告");

console.log("8. 未鉴权 → 401");
const noauth = await j(await fetch(`${API}/api/weekly/report`));
expect(noauth.status === 401, `未鉴权 GET 401 (got ${noauth.status})`);
const noauth2 = await j(await fetch(`${API}/api/weekly/report`, { method: "POST" }));
expect(noauth2.status === 401, `未鉴权 POST 401 (got ${noauth2.status})`);

console.log("");
console.log(failures === 0 ? "✅ WEEKLY SMOKE PASSED (0 failures)" : `❌ WEEKLY SMOKE FAILED (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
