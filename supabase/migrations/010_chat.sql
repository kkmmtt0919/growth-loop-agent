-- =============================================================
-- 010：AI 实时聊天面板（消息图标入口）
-- =============================================================
-- 设计（docs/DESIGN_CHAT_PANEL_V1.md v3，用户审核定稿 2026-09-04）：
--   1. 只建 2 张表：chat_conversations + chat_messages
--      （P2 才建 chat_summaries（011）；metadata jsonb 列 P2 用 012 alter 加，YAGNI）
--   2. 单会话约束落在 DB 层：chat_conversations.user_id 唯一
--      （双端并发也只一条会话；P3 多会话时 drop constraint 即可，
--       注意 user_id 上有非唯一索引 chat_conversations_user_idx，drop 后查询仍走索引）
--   3. 内容长度双保险：DB check(char_length between 1 and 2000) + 应用层校验
--   4. 幂等根基：chat_messages_idem_idx 唯一索引（conversation_id, client_msg_id）
--      管两件事：防双击重复插入 + LLM 失败重试定位（重发同 clientMsgId 只补 assistant）
--   5. user_id 在 chat_messages 上冗余一份：隔离查询显式带 user_id = $1，防伪造 conversation_id 跨用户读
--   6. 新表必须 ENABLE ROW LEVEL SECURITY（延续 007 修复：public 表一律 deny-all + 应用直连绕过）
-- =============================================================

-- 会话（P1 每用户一条；unique(user_id) 强制单会话）
create table public.chat_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references public.profiles(id) on delete cascade,
  title      text not null default '新的对话',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 非唯一索引（P3 drop unique 后多会话查询仍走索引；单会话期间也用于排序取最近）
create index chat_conversations_user_idx
  on public.chat_conversations (user_id, updated_at desc);

-- 消息
create table public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  -- 内容长度：下限 1 防空消息、上限 2000 防超长撑爆库/打爆 LLM token
  content         text not null check (char_length(content) between 1 and 2000),
  -- 前端生成的幂等键：防双击/重试产生重复消息，也是失败重试的定位锚点
  client_msg_id   text,
  created_at      timestamptz not null default now()
  -- P2 追加 metadata jsonb（source: llm/fallback/tool、latency）：012 迁移 alter add column
);

create index chat_messages_conv_idx
  on public.chat_messages (conversation_id, created_at);

-- 幂等根基：DB 约束，而非应用层判断
create unique index chat_messages_idem_idx
  on public.chat_messages (conversation_id, client_msg_id)
  where client_msg_id is not null;

-- 沿用 007 口径：开 RLS、不建 policy、不碰 auth.uid()
alter table public.chat_conversations enable row level security;
alter table public.chat_messages      enable row level security;
