import { getPool } from "./pool";

/**
 * 聊天仓储层（docs/DESIGN_CHAT_PANEL_V1.md §6）。
 * 4 个函数签名全部强制 userId，所有查询显式带 `where user_id = $1`——
 * 任何函数不允许只按 conversation_id 查询（多用户隔离靠 Repo 层白纸黑字）。
 */

export type DbChatMessage = {
  id: string;
  conversation_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  client_msg_id: string | null;
  created_at: string;
};

export type DbChatConversation = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

/** 归属校验 + 会话定位：`where id=$1 and user_id=$2`，非本人查不到 */
export async function resolveConversation(
  userId: string,
  conversationId: string,
): Promise<DbChatConversation | null> {
  const { rows } = await getPool().query<DbChatConversation>(
    `select id, user_id, title, created_at, updated_at
     from public.chat_conversations
     where id = $1 and user_id = $2
     limit 1`,
    [conversationId, userId],
  );
  return rows[0] ?? null;
}

/**
 * 单会话：取该用户唯一会话；不存在则创建。
 * `insert ... on conflict (user_id) do nothing` —— 双端并发也只产生一条会话，
 * 创建成功与否都用回查兜底（幂等）。
 */
export async function getOrCreateConversation(userId: string): Promise<DbChatConversation> {
  await getPool().query(
    `insert into public.chat_conversations (user_id)
     values ($1)
     on conflict (user_id) do nothing`,
    [userId],
  );
  const { rows } = await getPool().query<DbChatConversation>(
    `select id, user_id, title, created_at, updated_at
     from public.chat_conversations
     where user_id = $1
     order by updated_at desc
     limit 1`,
    [userId],
  );
  return rows[0];
}

/**
 * 追加一条消息（幂等）。
 * client_msg_id 唯一索引（conversation_id, client_msg_id）兜底：
 * 双击 / 网络重试 / LLM 失败重试只落一条 user；重试时同 (conversation_id, client_msg_id)
 * 被 ON CONFLICT DO NOTHING 挡住，返回 inserted=false，调用方跳过重复。
 * 返回 { message, inserted }：inserted 由 SQL 侧 (xmax = 0) 计算，避免客户端二次解析。
 */
export async function appendMessage(input: {
  userId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  clientMsgId?: string | null;
}): Promise<{ message: DbChatMessage; inserted: boolean }> {
  const { rows } = await getPool().query<DbChatMessage & { inserted: boolean }>(
    `insert into public.chat_messages (conversation_id, user_id, role, content, client_msg_id)
     values ($1, $2, $3, $4, $5)
     on conflict (conversation_id, client_msg_id) where client_msg_id is not null
     do nothing
     returning id, conversation_id, user_id, role, content, client_msg_id, created_at, (xmax = 0) as inserted`,
    [input.conversationId, input.userId, input.role, input.content, input.clientMsgId ?? null],
  );
  const row = rows[0];
  if (!row) {
    // 幂等冲突（重试/双击）：插入被唯一索引挡住，回查库里已存在的那条
    // （重试定位锚点 = 同一 client_msg_id；assistant 不带 clientMsgId 时不会走到这里）
    const { rows: existing } = await getPool().query<DbChatMessage>(
      `select id, conversation_id, user_id, role, content, client_msg_id, created_at
       from public.chat_messages
       where conversation_id = $1 and user_id = $2 and client_msg_id = $3
       limit 1`,
      [input.conversationId, input.userId, input.clientMsgId ?? null],
    );
    if (!existing[0]) {
      throw new Error("appendMessage: 幂等冲突但未找到已存在消息");
    }
    return { message: existing[0], inserted: false };
  }
  const { inserted, ...message } = row;
  return { message, inserted };
}

/** 拉最近 N 条消息（L1 对话历史），显式带 user_id 防跨用户读取 */
export async function listRecentMessages(
  userId: string,
  conversationId: string,
  limit: number,
): Promise<DbChatMessage[]> {
  const { rows } = await getPool().query<DbChatMessage>(
    `select id, conversation_id, user_id, role, content, client_msg_id, created_at
     from public.chat_messages
     where conversation_id = $1 and user_id = $2
     order by created_at asc, id asc
     limit $3`,
    [conversationId, userId, limit],
  );
  return rows;
}
