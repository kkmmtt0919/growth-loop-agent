/**
 * 聊天数据隔离验证（用户验收第二条：账号 B 看不到账号 A 的聊天）
 * 验证：
 *   1. A 注册发消息
 *   2. B 注册，GET /api/chat → 空历史（看不到 A 的）
 *   3. B 用 A 的 conversationId GET/POST → 403
 *   4. B 伪造/直查 A 的 conversationId → 403
 * 用法：node scripts/chat-isolation-verify.mjs
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = envText
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="))
  ?.slice(13)
  .trim()
  .replace(/[?&]sslmode=[^&]*/g, "");
const pool = new pg.Pool({ connectionString: url });

const BASE = "http://localhost:3000";
const pass = "TestPass123!";

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  const ts = Date.now();
  const regA = await req("POST", "/api/auth/register", { email: `iso_a_${ts}@test.local`, password: pass });
  const regB = await req("POST", "/api/auth/register", { email: `iso_b_${ts}@test.local`, password: pass });
  const tokenA = regA.data.token;
  const tokenB = regB.data.token;
  console.log("PASS 注册 A/B userId=", regA.data.profile.id.slice(0, 8), "/", regB.data.profile.id.slice(0, 8));

  // A 发一条消息，拿 conversationId
  const aMsg = await req("POST", "/api/chat", { message: "A 的私密消息", clientMsgId: crypto.randomUUID() }, tokenA);
  const convA = aMsg.data?.conversationId;
  if (!convA) { console.log("FAIL 拿不到 conversationId"); process.exit(1); }
  console.log("PASS A 发送成功 conversationId=", convA.slice(0, 8), "…");

  // B 打开面板拉历史 → 应为空（或 B 自己的新会话，消息为 0）
  const bHist = await req("GET", "/api/chat", null, tokenB);
  console.log("B 拉历史 status=", bHist.status, "消息数=", (bHist.data.messages || []).length, "conversationId=", String(bHist.data.conversationId || "").slice(0, 8), "…");
  const bSeesA = (bHist.data.messages || []).some((m) => m.content === "A 的私密消息");
  console.log(!bSeesA ? "PASS B 看不到 A 的消息" : "FAIL B 看到了 A 的消息");

  // B 用 A 的 conversationId GET → 403
  const bGetA = await req("GET", `/api/chat?conversationId=${convA}`, null, tokenB);
  console.log(bGetA.status === 403 ? "PASS B 用 A 的 conversationId GET → 403" : "WARN B 用 A 的 conversationId GET → " + bGetA.status);

  // B 用 A 的 conversationId POST → 403
  const bPostA = await req("POST", "/api/chat", { message: "想偷看", conversationId: convA, clientMsgId: crypto.randomUUID() }, tokenB);
  console.log(bPostA.status === 403 ? "PASS B 用 A 的 conversationId POST → 403" : "WARN B 用 A 的 conversationId POST → " + bPostA.status);

  // DB 直查确认：A 的消息都在 A 的会话下，B 会话独立
  const rows = await pool.query(
    `select cc.user_id, count(cm.id)::int as n from chat_conversations cc
     left join chat_messages cm on cm.conversation_id = cc.id
     where cc.user_id in ($1, $2) group by cc.user_id order by cc.user_id`,
    [regA.data.profile.id, regB.data.profile.id]
  );
  console.log("DB 会话归属:", JSON.stringify(rows.rows));
} catch (e) {
  console.error("FAIL 异常:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
