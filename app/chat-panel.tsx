"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, RefreshCw, Send, Sparkles, X } from "lucide-react";

/**
 * AI 实时聊天面板（docs/DESIGN_CHAT_PANEL_V1.md §6）。
 * 桌面：右侧抽屉 380px，position: fixed 浮在 right-rail 之上；
 * 移动：底部 sheet 全屏（沿用 app-mobile-v3-sheet 视觉，独立实现不依赖其他组件）。
 * 行为：仅登录用户可用；LLM 失败显示错误气泡 + 重试（重发同 clientMsgId）；
 *       clientMsgId 幂等，重试不会产生重复 user 消息。
 */

export type ChatPanelProps = {
  open: boolean;
  onClose: () => void;
  /** 登录后 JWT；null / 空 = 未登录 */
  authToken: string | null;
  /** 未登录提示回调（复用主页 toast） */
  onNotify?: (message: string) => void;
};

type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  /** LLM 失败占位：error=true 时 assistant 无真实内容，显示重试 */
  error?: boolean;
};

const MAX_LENGTH = 2000;

export default function ChatPanel({ open, onClose, authToken, onNotify }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 正在发送/重试的那条 user 消息的 clientMsgId（重试重发同 id）
  const pendingClientMsgId = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    if (open) scrollToBottom();
  }, [open, messages, scrollToBottom]);

  // 打开面板时拉历史
  useEffect(() => {
    if (!open) return;
    if (!authToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat", { headers: { Authorization: `Bearer ${authToken}` } });
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            onNotify?.("登录已过期，请重新登录");
          }
          setLoaded(true);
          return;
        }
        const data = (await res.json()) as {
          conversationId: string;
          messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }>;
        };
        setConversationId(data.conversationId);
        setMessages(data.messages);
      } catch {
        // 网络失败：静默，保留现有消息
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, authToken, onNotify]);

  function send(text: string, clientMsgId: string | null, mode: "new" | "retry") {
    if (!authToken) {
      onNotify?.("请先登录后再与 AI 聊天");
      return;
    }
    setSending(true);
    setRateLimited(false);

    const body: Record<string, unknown> = { message: text };
    if (conversationId) body.conversationId = conversationId;
    if (clientMsgId) body.clientMsgId = clientMsgId;

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = (await res.json()) as {
          conversationId?: string;
          userMessage?: { id: string; role: "user" | "assistant"; content: string; createdAt: string };
          assistantMessage?: { id: string; role: "user" | "assistant"; content: string; createdAt: string } | null;
          error?: boolean;
          retryable?: boolean;
          rateLimited?: boolean;
        };
        if (!res.ok || data.rateLimited) {
          setRateLimited(true);
          onNotify?.("发送太频繁，请稍后再试");
          return;
        }
        if (data.conversationId) setConversationId(data.conversationId);

        // 服务端会返回最新 user 消息（重试时是库里已存在的那条）
        if (mode === "new" && data.userMessage) {
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === data.userMessage!.id);
            return exists ? prev : [...prev, { id: data.userMessage!.id, role: "user", content: data.userMessage!.content, createdAt: data.userMessage!.createdAt }];
          });
        }

        if (data.error) {
          // LLM 失败：assistant 不落库 → 本地追加错误气泡（含重试）
          setMessages((prev) => [...prev, { role: "assistant", content: "", error: true }]);
          return;
        }
        if (data.assistantMessage) {
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === data.assistantMessage!.id);
            return exists ? prev : [...prev, { id: data.assistantMessage!.id, role: "assistant", content: data.assistantMessage!.content, createdAt: data.assistantMessage!.createdAt }];
          });
        }
      })
      .catch(() => {
        // 网络层失败（如断网）：本地追加错误气泡 + 可重试
        setMessages((prev) => [...prev, { role: "assistant", content: "", error: true }]);
      })
      .finally(() => setSending(false));
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    if (text.length > MAX_LENGTH) {
      onNotify?.(`消息不能超过 ${MAX_LENGTH} 字`);
      return;
    }
    const clientMsgId = crypto.randomUUID();
    pendingClientMsgId.current = clientMsgId;
    // 先本地回显 user 消息（乐观），服务端幂等保证不重复
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    send(text, clientMsgId, "new");
  }

  function handleRetry() {
    // 找到最后一个 error 气泡对应的 user 消息
    const lastErrorIndex = [...messages].reverse().findIndex((m) => m.error);
    if (lastErrorIndex === -1) return;
    const userIdx = messages.length - 1 - lastErrorIndex - 1;
    const userMsg = messages[userIdx];
    if (!userMsg || userMsg.role !== "user") return;
    // 移除错误气泡，重发同 clientMsgId
    const cleaned = messages.filter((m) => !m.error);
    setMessages(cleaned);
    const clientMsgId = pendingClientMsgId.current ?? crypto.randomUUID();
    pendingClientMsgId.current = clientMsgId;
    send(userMsg.content, clientMsgId, "retry");
  }

  if (!open) return null;

  const hasToken = Boolean(authToken);

  return (
    <div className="chat-panel" role="dialog" aria-modal="true" aria-label="AI 聊天">
      <div className="chat-panel-backdrop" onClick={onClose} />
      <div className="chat-panel-card">
        <header className="chat-panel-header">
          <div className="chat-panel-title">
            <span className="chat-panel-orb"><Sparkles size={16} /></span>
            <div>
              <strong>和你的成长助手聊聊</strong>
              <span>它记得你的目标、计划和每一次进步</span>
            </div>
          </div>
          <button className="chat-panel-close" onClick={onClose} aria-label="关闭聊天"><X size={16} /></button>
        </header>

        {!hasToken ? (
          <div className="chat-panel-guest">
            <div className="chat-panel-guest-icon"><Bot size={22} /></div>
            <p>请先登录，才能和 AI 聊天。</p>
            <p className="chat-panel-guest-hint">登录后，AI 会记住你说过的话和做过的事，跨设备都能继续。</p>
          </div>
        ) : (
          <>
            <div className="chat-panel-messages" ref={scrollRef}>
              {!loaded ? (
                <div className="chat-panel-loading">正在加载对话…</div>
              ) : messages.length === 0 ? (
                <div className="chat-panel-empty">
                  <div className="chat-panel-empty-orb"><Sparkles size={18} /></div>
                  <p>我是你的 AI 伙伴，记得你做过的事。</p>
                  <p>试试问：<em>我今天做了什么？</em></p>
                </div>
              ) : (
                messages.map((m, i) => (
                  <div key={m.id ?? i} className={`chat-msg ${m.role}`}>
                    {m.error ? (
                      <div className="chat-msg-error">
                        <span>这次回复没成功，请重试</span>
                        <button onClick={handleRetry} disabled={sending}><RefreshCw size={13} /> 重试</button>
                      </div>
                    ) : (
                      <div className="chat-bubble">{m.content}</div>
                    )}
                  </div>
                ))
              )}
              {sending && (
                <div className="chat-msg assistant">
                  <div className="chat-bubble chat-bubble-typing"><span /><span /><span /></div>
                </div>
              )}
            </div>

            <div className="chat-panel-composer">
              {rateLimited && <div className="chat-panel-rate">发送太频繁，1 分钟后再试试</div>}
              <div className="chat-panel-input-row">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (!sending) handleSend();
                    }
                  }}
                  placeholder="和 AI 说点什么…"
                  maxLength={MAX_LENGTH}
                  rows={1}
                  disabled={sending}
                  aria-label="聊天输入框"
                />
                <button className="chat-panel-send" onClick={handleSend} disabled={sending || !input.trim()} aria-label="发送"><Send size={16} /></button>
              </div>
              <div className="chat-panel-meta">
                <span>{input.length}/{MAX_LENGTH}</span>
                <span>Enter 发送 · Shift+Enter 换行</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
