const API = "http://127.0.0.1:3000";
const ts = Date.now();
const emailA = `smoke-del-a-${ts}@growthloop.local`;
const emailB = `smoke-del-b-${ts}@growthloop.local`;
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

async function register(email, displayName) {
  const res = await j(await fetch(`${API}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw, displayName }),
  }));
  return res;
}

console.log("1. 注册用户 A / B");
const regA = await register(emailA, "删除冒烟A");
expect(regA.status === 200, `A 注册 200 (got ${regA.status})`);
const tokenA = regA.body?.token;
expect(!!tokenA, "A token 返回");
const regB = await register(emailB, "删除冒烟B");
expect(regB.status === 200, `B 注册 200 (got ${regB.status})`);
const tokenB = regB.body?.token;
expect(!!tokenB, "B token 返回");
const authA = { Authorization: `Bearer ${tokenA}` };
const authB = { Authorization: `Bearer ${tokenB}` };

console.log("2. A / B 各造一条目标（业务数据）");
const goalA = await j(await fetch(`${API}/api/goals`, {
  method: "POST",
  headers: { ...authA, "Content-Type": "application/json" },
  body: JSON.stringify({ title: "A 的目标" }),
}));
expect(goalA.status === 201, `A 建目标 201 (got ${goalA.status})`);
const goalB = await j(await fetch(`${API}/api/goals`, {
  method: "POST",
  headers: { ...authB, "Content-Type": "application/json" },
  body: JSON.stringify({ title: "B 的目标" }),
}));
expect(goalB.status === 201, `B 建目标 201 (got ${goalB.status})`);

console.log("3. A 的 /api/auth/me 返回权威邮箱");
const meA = await j(await fetch(`${API}/api/auth/me`, { headers: authA }));
expect(meA.status === 200, `me 200 (got ${meA.status})`);
expect(typeof meA.body?.profile?.email === "string", "profile.email 字符串");
expect(meA.body?.profile?.email === emailA, "email 与注册邮箱一致");

console.log("4. B 删除自己账号 → deleted=true");
const delB = await j(await fetch(`${API}/api/auth/delete`, { method: "DELETE", headers: authB }));
expect(delB.status === 200, `DELETE 200 (got ${delB.status})`);
expect(delB.body?.deleted === true, "返回 deleted=true");

console.log("5. B 删除后：me 404（JWT 仍有效但用户已删）、登录 401、邮箱可复用注册");
const meB = await j(await fetch(`${API}/api/auth/me`, { headers: authB }));
expect(meB.status === 404, `B 删后 me 404 (got ${meB.status})`);
const loginB = await j(await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: emailB, password: pw }),
}));
expect(loginB.status === 401, `B 删后登录 401 (got ${loginB.status})`);
const regB2 = await register(emailB, "删除冒烟B2");
expect(regB2.status === 200, `B 邮箱复用注册 200 (got ${regB2.status})`);

console.log("6. 隔离：B 删自己不影响 A（A 数据仍在）");
const meA2 = await j(await fetch(`${API}/api/auth/me`, { headers: authA }));
expect(meA2.status === 200, `A me 仍 200 (got ${meA2.status})`);
const goalsA = await j(await fetch(`${API}/api/goals`, { headers: authA }));
expect(goalsA.status === 200, `A goals 200 (got ${goalsA.status})`);
expect(goalsA.body?.goals?.some((g) => g.title === "A 的目标"), "A 的目标仍存在");

console.log("7. A 删除自己账号 → deleted=true");
const delA = await j(await fetch(`${API}/api/auth/delete`, { method: "DELETE", headers: authA }));
expect(delA.status === 200, `DELETE 200 (got ${delA.status})`);
expect(delA.body?.deleted === true, "返回 deleted=true");
const meA3 = await j(await fetch(`${API}/api/auth/me`, { headers: authA }));
expect(meA3.status === 404, `A 删后 me 404 (got ${meA3.status})`);

console.log("8. 未鉴权 DELETE → 401");
const noauth = await j(await fetch(`${API}/api/auth/delete`, { method: "DELETE" }));
expect(noauth.status === 401, `未鉴权 DELETE 401 (got ${noauth.status})`);

console.log("");
console.log(failures === 0 ? "✅ DELETE SMOKE PASSED (0 failures)" : `❌ DELETE SMOKE FAILED (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
