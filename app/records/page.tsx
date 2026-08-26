"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight, Home as HomeIcon, Loader2 } from "lucide-react";
import { MOOD_OPTIONS, moodEmoji, moodLabel } from "@/lib/mood-mapper";
import type { Mood } from "@/lib/repo/types";
import type { RecordItem, RecentRecordsResult, HistoryRecordsResult } from "@/lib/service/records";

const AUTH_TOKEN_KEY = "growth-loop.auth-token";
const HISTORY_PAGE = 50;

const KIND_LABEL: Record<string, string> = {
  focus: "专注",
  learn: "学习",
  exercise: "运动",
  life: "生活",
  rest: "休息",
};

export default function RecordsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState<"recent" | "history">("recent");
  const [recent, setRecent] = useState<RecentRecordsResult | null>(null);
  const [history, setHistory] = useState<HistoryRecordsResult>({ items: [], total: 0, hasMore: false, offset: 0 });
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  // mount 时从 localStorage 读取 token（SSR 安全：window 仅客户端可用，必须 effect 初始化）
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setToken(window.localStorage.getItem(AUTH_TOKEN_KEY));
    setBooted(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const authHeaders = useCallback(
    (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const loadRecent = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/records/recent?days=7", { headers: authHeaders() });
      if (!r.ok) throw new Error("加载失败");
      const d: RecentRecordsResult = await r.json();
      setRecent(d);
      setExpandedDay(d.days[0]?.date ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  // 加载 recent：token 异步读取后需自动拉取，effect 触发 fetch+setState 是数据加载惯用模式
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (token) loadRecent();
  }, [token, loadRecent]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadHistory = useCallback(
    async (offset: number, append: boolean) => {
      if (!token) return;
      setLoading(true);
      setError("");
      try {
        const r = await fetch(`/api/records/history?limit=${HISTORY_PAGE}&offset=${offset}`, { headers: authHeaders() });
        if (!r.ok) throw new Error("加载失败");
        const d: HistoryRecordsResult = await r.json();
        setHistory((prev) => ({
          items: append ? [...prev.items, ...d.items] : d.items,
          total: d.total,
          hasMore: d.hasMore,
          offset,
        }));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [token, authHeaders],
  );

  // PATCH mood（乐观更新 recent + history）
  const patchMood = useCallback(
    async (id: string, mood: Mood | null) => {
      const upd = (rec: RecordItem): RecordItem => (rec.id === id ? { ...rec, mood } : rec);
      setRecent((prev) =>
        prev ? { ...prev, days: prev.days.map((d) => ({ ...d, records: d.records.map(upd) })) } : prev,
      );
      setHistory((prev) => ({ ...prev, items: prev.items.map(upd) }));
      try {
        const r = await fetch(`/api/records/${id}`, {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ mood }),
        });
        if (!r.ok) throw new Error("标记失败");
        setToast(mood ? `已标记 ${moodLabel(mood)}` : "已清除心情");
      } catch (e) {
        setError((e as Error).message);
        setToast("标记失败，请重试");
      } finally {
        setTimeout(() => setToast(""), 1500);
      }
    },
    [authHeaders],
  );

  const patchRemark = useCallback(
    async (id: string, remark: string) => {
      const upd = (rec: RecordItem): RecordItem => (rec.id === id ? { ...rec, remark } : rec);
      setRecent((prev) =>
        prev ? { ...prev, days: prev.days.map((d) => ({ ...d, records: d.records.map(upd) })) } : prev,
      );
      setHistory((prev) => ({ ...prev, items: prev.items.map(upd) }));
      try {
        const r = await fetch(`/api/records/${id}`, {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ remark }),
        });
        if (!r.ok) throw new Error("备注失败");
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [authHeaders],
  );

  if (!booted) return null;

  if (!token) {
    return (
      <div className="workspace-page records-page">
        <div className="panel records-login">
          <h2>请先登录</h2>
          <p>记录查询需要登录后查看。</p>
          <Link className="primary-button" href="/">
            回到首页登录 <ArrowUpRight size={15} />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-page records-page">
      <header className="records-header">
        <Link className="records-back" href="/">
          <HomeIcon size={16} /> 首页
        </Link>
        <h1>记录</h1>
        <div className="records-tabs">
          <button className={view === "recent" ? "active" : ""} onClick={() => setView("recent")}>
            近 7 天
          </button>
          <button
            className={view === "history" ? "active" : ""}
            onClick={() => {
              setView("history");
              if (history.items.length === 0) loadHistory(0, false);
            }}
          >
            历史
          </button>
        </div>
      </header>

      {error && <p className="records-error" role="alert">{error}</p>}
      {loading && (
        <p className="records-loading">
          <Loader2 size={16} className="spin" /> 加载中…
        </p>
      )}

      {view === "recent" && recent && (
        <div className="records-recent">
          <div className="records-summary">
            <span>近 7 天完成任务 <strong>{recent.doneTasks7d}</strong></span>
            <span>任务完成率 <strong>{recent.weeklyCompletionRate}%</strong></span>
            <span>有记录 <strong>{recent.activeDays}</strong> 天</span>
            <span>投入 <strong>{recent.totalMinutes7d}</strong> 分钟</span>
          </div>
          <div className="recent-day-list">
            {recent.days.map((d) => (
              <div className={`recent-day ${expandedDay === d.date ? "expanded" : ""}`} key={d.date}>
                <button
                  className="recent-day-head"
                  onClick={() => setExpandedDay(expandedDay === d.date ? null : d.date)}
                >
                  <span className="recent-day-label">{d.label}</span>
                  <span className="recent-day-date">{d.date.slice(5)}</span>
                  <span className="recent-day-meta">
                    {d.records.length} 条 · {d.tasksDone} 完成 · {d.minutes}m
                  </span>
                  <ChevronRight size={16} className="recent-day-chev" />
                </button>
                {expandedDay === d.date && (
                  <div className="record-list">
                    {d.records.length === 0 ? (
                      <p className="records-empty">这天没有记录</p>
                    ) : (
                      d.records.map((r) => (
                        <RecordCard key={r.id} r={r} onMood={patchMood} onRemark={patchRemark} />
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "history" && (
        <div className="records-history">
          <div className="record-list">
            {history.items.map((r) => (
              <RecordCard key={r.id} r={r} onMood={patchMood} onRemark={patchRemark} />
            ))}
            {history.items.length === 0 && !loading && <p className="records-empty">还没有记录</p>}
          </div>
          {history.hasMore && (
            <button
              className="load-more"
              onClick={() => loadHistory(history.offset + HISTORY_PAGE, true)}
              disabled={loading}
            >
              加载更多 <ChevronRight size={14} />
            </button>
          )}
          <p className="records-count">共 {history.total} 条</p>
        </div>
      )}

      {toast && <div className="records-toast">{toast}</div>}
    </div>
  );
}

function RecordCard({
  r,
  onMood,
  onRemark,
}: {
  r: RecordItem;
  onMood: (id: string, mood: Mood | null) => void;
  onRemark: (id: string, remark: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.remark ?? "");

  return (
    <article className="record-item record-item-query">
      <div className="record-body">
        <div className="record-topline">
          <h3>
            {r.mood && <span className="record-mood-emoji">{moodEmoji(r.mood)}</span>}{" "}
            {r.topic || r.text.slice(0, 20)}
          </h3>
          <span className="record-reward">+{r.xp} XP · +{r.coin} coin</span>
        </div>
        <p>{r.text}</p>
        {r.output && <p className="record-output">{r.output}</p>}
        <div className="record-tags">
          {r.kind && <span className={`record-kind-tag kind-${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>}
          {r.minutes ? <span>{r.minutes}m</span> : null}
          <span>
            {r.intent === "plan_today" ? "计划" : r.intent === "review" ? "复盘" : "速记"}
          </span>
        </div>

        {r.remark && !editing && <p className="record-remark">{r.remark}</p>}

        <div className="record-mood-row">
          {MOOD_OPTIONS.map((m) => (
            <button
              key={m.value}
              className={`mood-chip ${r.mood === m.value ? "active" : ""}`}
              title={m.label}
              onClick={() => onMood(r.id, r.mood === m.value ? null : m.value)}
            >
              {m.emoji}
            </button>
          ))}
          {editing ? (
            <span className="remark-inline">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="备注…"
                maxLength={500}
                autoFocus
              />
              <button onClick={() => { onRemark(r.id, draft); setEditing(false); }}>保存</button>
              <button
                onClick={() => {
                  setDraft(r.remark ?? "");
                  setEditing(false);
                }}
              >
                取消
              </button>
            </span>
          ) : (
            <button
              className="remark-toggle"
              onClick={() => {
                setDraft(r.remark ?? "");
                setEditing(true);
              }}
            >
              {r.remark ? "编辑备注" : "添加备注"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
