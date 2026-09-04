/**
 * 聊天重试幂等验证（用户验收第三条：断网重发只补 assistant，不产生 user,user,assistant）
 * 用法：node scripts/chat-retry-verify.mjs
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
const email = "chat_retry_" + Date.now() + "@test.local";
const pass = "TestPass123!";

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  const reg = await post("/api/auth/register", { email, password: pass });
  const token = reg.data.token;
  const userId = reg.data.profile.id;
  console.log("PASS 注册 userId=", userId);

  // 用同一个 clientMsgId 连续发两次
  const clientMsgId = crypto.randomUUID();
  const r1 = await post("/api/chat", { message: "重试幂等测试", clientMsgId }, token);
  console.log("第1次 status=", r1.status, "err=", r1.data.error, "userMessage id=", r1.data.userMessage?.id?.slice(0, 8));

  const r2 = await post("/api/chat", { message: "重试幂等测试", clientMsgId }, token);
  console.log("第2次(同clientMsgId) status=", r2.status, "err=", r2.data.error, "userMessage id=", r2.data.userMessage?.id?.slice(0, 8));

  // 判断：第二次的 userMessage 应为同一条（id 相同，未重复插入），且 assistantMessage 正常返回
  const sameId = r1.data.userMessage?.id === r2.data.userMessage?.id;
  console.log(sameId ? "PASS 重试复用同一条 user 消息（未重复插入）" : "FAIL user 消息 id 不一致（重复插入了）");

  // DB 核对：该 clientMsgId 应只有 1 条 user 消息
  const rows = await pool.query(
    `select role, count(*)::int as n
     from chat_messages cm join chat_conversations cc on cc.id = cm.conversation_id
     where cc.user_id = $1 and cm.client_msg_id = $2
     group by role`,
    [userId, clientMsgId]
  );
  const stat = Object.fromEntries(rows.rows.map((r) => [r.role, r.n]));
  console.log("该 clientMsgId 的消息统计:", JSON.stringify(stat), "-> user 应为 1:", stat.user === 1);

  // 完整消息序列：核心验收 = 不出现 user,user 连续（user 消息唯一）
  const seq = await pool.query(
    `select role from chat_messages cm join chat_conversations cc on cc.id = cm.conversation_id
     where cc.user_id = $1 order by cm.created_at asc, cm.id asc`,
    [userId]
  );
  const roles = seq.rows.map((r) => r.role);
  console.log("完整消息序列:", JSON.stringify(roles));
  const noUserRepeat = !roles.some((r, i) => i > 0 && r === "user" && roles[i - 1] === "user");
  const userCount = roles.filter((r) => r === "user").length;
  console.log(userCount === 1 ? "PASS user 消息仅 1 条" : "FAIL user 消息 " + userCount + " 条");
  console.log(noUserRepeat ? "PASS 无 user,user 连续（核心验收达成）" : "FAIL 出现 user,user 连续");
  // 说明：assistant 可能 >1（第二次请求真实调用了 LLM 并成功，按设计追加新回复），
  // 只有「LLM 失败未落库 → 重试只补一条」时序列才是 [user, assistant]。
} catch (e) {
  console.error("FAIL 异常:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
