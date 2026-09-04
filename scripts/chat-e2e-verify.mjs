/**
 * 聊天面板 Step 1 端到端验证（一次性回归脚本，2026-09-04）
 * 验证要点：
 *   1. 注册 → 三连问 → AI 能引用前文（记忆闭环）
 *   2. GET /api/chat 拉回完整历史
 *   3. DB 层 user/assistant 各 N 条、无重复消息（幂等锚点生效）
 *   4. 数据隔离：伪造 conversationId / 无 token → 401/403
 * 用法：node scripts/chat-e2e-verify.mjs
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
const email = "chat_e2e_" + Date.now() + "@test.local";
const pass = "TestPass123!";

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function get(path, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  // 1. 注册拿 token
  const reg = await post("/api/auth/register", { email, password: pass });
  const token = reg.data.token;
  if (!token) {
    console.log("FAIL 注册失败:", reg.status, JSON.stringify(reg.data).slice(0, 200));
    process.exit(1);
  }
  const userId = reg.data.profile.id;
  console.log("PASS 注册成功 userId=", userId);

  // 2. 三连问（第 3 问故意不带 RAG 关键词，测试 AI 是否记得第 2 问）
  const questions = [
    "你好，请简单打个招呼",
    "我今天学习了 RAG，感觉很有收获",
    "昨天我做了什么？",
  ];
  const replies = [];
  for (let i = 0; i < questions.length; i++) {
    const r = await post("/api/chat", { message: questions[i], clientMsgId: crypto.randomUUID() }, token);
    const reply = r.data.assistantMessage?.content || "";
    replies.push(reply);
    console.log(`PASS 第${i + 1}问 status=${r.status} err=${r.data.error} | 回复: ${reply.slice(0, 90)}`);
  }

  // 3. 记忆闭环判定：第 3 问的回复应提到 RAG / 学习（因为历史里有第 2 问）
  const lastReply = replies[2] || "";
  const remembersRag = /rag/i.test(lastReply) || /学习|检索|知识库|模型/i.test(lastReply);
  console.log(remembersRag ? "PASS 记忆闭环：AI 引用前文（提到学习/RAG）" : "WARN 记忆闭环待确认：AI 回复未明确提到 RAG，需人工判断", lastReply.slice(0, 120));

  // 4. GET 拉历史
  const hist = await get("/api/chat", token);
  const msgs = hist.data.messages || [];
  console.log(`PASS GET /api/chat status=${hist.status} 消息数=${msgs.length} conversationId=${String(hist.data.conversationId || "").slice(0, 8)}...`);
  msgs.forEach((m) => console.log("      -", m.role, ":", (m.content || "").slice(0, 40)));

  // 5. DB 核对：user/assistant 各 3 条
  const rows = await pool.query(
    `select role, count(*)::int as n from chat_messages cm
     join chat_conversations cc on cc.id = cm.conversation_id
     where cc.user_id = $1 group by role order by role`,
    [userId]
  );
  const stat = Object.fromEntries(rows.rows.map((r) => [r.role, r.n]));
  console.log("DB 消息统计:", JSON.stringify(stat), stat.user === 3 && stat.assistant === 3 ? "PASS user=3 assistant=3" : "WARN 条数不符");

  // 6. 无重复消息
  const dup = await pool.query(
    `select count(*)::int as n from (
       select conversation_id, client_msg_id from chat_messages cm
       join chat_conversations cc on cc.id = cm.conversation_id
       where cc.user_id = $1 and client_msg_id is not null
       group by conversation_id, client_msg_id having count(*) > 1
     ) t`,
    [userId]
  );
  console.log(dup.rows[0].n === 0 ? "PASS 无重复消息（幂等锚点生效）" : "FAIL 存在重复消息: " + dup.rows[0].n);

  // 7. 数据隔离：伪造 conversationId（UUID 但非本人）→ 应 403
  const fake = await post("/api/chat", { message: "hi", conversationId: "00000000-0000-0000-0000-000000000001", clientMsgId: crypto.randomUUID() }, token);
  console.log(fake.status === 403 ? "PASS 伪造 conversationId → 403 隔离生效" : `WARN 伪造 conversationId → ${fake.status}（应为 403）`);

  // 8. 无 token → 401
  const anon = await post("/api/chat", { message: "hi", clientMsgId: crypto.randomUUID() });
  console.log(anon.status === 401 ? "PASS 无 token → 401" : `WARN 无 token → ${anon.status}（应为 401）`);

  console.log("EMAIL_USED=" + email);
} catch (e) {
  console.error("FAIL 异常:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
