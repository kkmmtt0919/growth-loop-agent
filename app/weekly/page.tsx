"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight, Home as HomeIcon, Loader2, Sparkles, Check } from "lucide-react";

const AUTH_TOKEN_KEY = "growth-loop.auth-token";

type GoalSuggestion = {
  goalId: string;
  action: "update_title";
  newTitle: string;
  reason: string;
};

type WeeklyContent = {
  schemaVersion: number;
  stats: {
    periodStart: string;
    periodEnd: string;
    activeDays: number;
    recordCount: number;
    minutes: number;
    doneTasks: number;
    windowTotal: number;
    completionRate: number;
    streak: number;
    goalProgress: Array<{ goalId: string; title: string; status: string; progress: number; doneThisWeek: number }>;
    vsPrevWeek: { recordCount: number; minutes: number; doneTasks: number; completionRate: number };
    // Step 5c 平行字段（optional：历史周报 content 无此字段时页面不解析失败、不显示执行卡）
    planMinutes?: number;
    actualMinutes?: number;
    executionRate?: number | null;
  };
  summary: string;
  achievement: string[];
  problem: string[];
  suggestion: string[];
  goalSuggestions: GoalSuggestion[];
  replySource: "llm" | "rules";
};

type WeeklyReport = {
  id: string;
  periodStart: string;
  periodEnd: string;
  summary: string;
  sourceCount: number;
  content: WeeklyContent | null;
  generatedAt: string;
};

type View = "checking" | "generating" | "ready" | "error";

export default function WeeklyPage() {
  const [token, setToken] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState<View>("checking");
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [error, setError] = useState("");
  const [adopted, setAdopted] = useState<Record<string, boolean>>({});
  const [adopting, setAdopting] = useState<string | null>(null);

  const authHeaders = useCallback(
    (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const generate = useCallback(async () => {
    if (!token) return;
    setError("");
    try {
      const r = await fetch("/api/weekly/report", { method: "POST", headers: authHeaders() });
      if (!r.ok) throw new Error("生成失败");
      const d = (await r.json()) as { report: WeeklyReport };
      setReport(d.report);
      setView("ready");
    } catch (e) {
      setError((e as Error).message);
      setView("error");
    }
  }, [token, authHeaders]);

  const load = useCallback(async () => {
    if (!token) return;
    setView("checking");
    setError("");
    try {
      const r = await fetch("/api/weekly/report", { headers: authHeaders() });
      if (!r.ok) throw new Error("查询失败");
      const d = (await r.json()) as { report: WeeklyReport | null };
      if (d.report) {
        setReport(d.report);
        setView("ready");
      } else {
        // 自动生成本周报告
        setView("generating");
        await generate();
      }
    } catch (e) {
      setError((e as Error).message);
      setView("error");
    }
  }, [token, authHeaders, generate]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setToken(window.localStorage.getItem(AUTH_TOKEN_KEY));
    setBooted(true);
  }, []);

  useEffect(() => {
    if (token) load();
  }, [token, load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const adoptSuggestion = useCallback(
    async (s: GoalSuggestion) => {
      if (!token || adopted[s.goalId]) return;
      setAdopting(s.goalId);
      try {
        const r = await fetch(`/api/goals/${s.goalId}`, {
          method: "PUT",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ title: s.newTitle }),
        });
        if (!r.ok) throw new Error("采纳失败");
        setAdopted((prev) => ({ ...prev, [s.goalId]: true }));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setAdopting(null);
      }
    },
    [token, authHeaders, adopted],
  );

  if (!booted) return null;

  if (!token) {
    return (
      <div className="workspace-page weekly-page">
        <div className="panel weekly-login">
          <h2>请先登录</h2>
          <p>周成长报告需要登录后查看。</p>
          <Link className="primary-button" href="/">
            回到首页登录 <ArrowUpRight size={15} />
          </Link>
        </div>
      </div>
    );
  }

  const c = report?.content;

  return (
    <div className="workspace-page weekly-page">
      <header className="weekly-header">
        <Link className="weekly-back" href="/">
          <HomeIcon size={16} /> 首页
        </Link>
        <h1>周成长报告</h1>
        <Link className="weekly-link" href="/records">
          记录 <ChevronRight size={14} />
        </Link>
      </header>

      {error && <p className="weekly-error" role="alert">{error}</p>}

      {(view === "checking" || view === "generating") && (
        <p className="weekly-loading">
          <Loader2 size={16} className="spin" /> {view === "generating" ? "正在生成本周报告…" : "检查本周报告…"}
        </p>
      )}

      {view === "error" && (
        <div className="weekly-error-box">
          <p>周报生成失败了。</p>
          <button className="primary-button" onClick={() => generate()}>
            重试 <ArrowUpRight size={15} />
          </button>
        </div>
      )}

      {view === "ready" && report && c && (
        <div className="weekly-body">
          <div className="weekly-period">
            本周周期 {c.stats.periodStart} ~ {c.stats.periodEnd}
            {c.replySource === "rules" && <span className="weekly-autostat">自动统计</span>}
          </div>

          {/* 周统计卡 */}
          <section className="panel weekly-stats">
            <div className="panel-heading">
              <div><span className="eyebrow">WEEKLY SNAPSHOT</span><h2>本周概览</h2></div>
            </div>
            <div className="weekly-stat-grid">
              <div className="weekly-stat">
                <span className="weekly-stat-label">活跃天数</span>
                <strong>{c.stats.activeDays}<small> 天</small></strong>
                <Delta cur={c.stats.activeDays} prev={c.stats.vsPrevWeek.recordCount} suffix="天" />
              </div>
              <div className="weekly-stat">
                <span className="weekly-stat-label">记录数</span>
                <strong>{c.stats.recordCount}<small> 条</small></strong>
                <Delta cur={c.stats.recordCount} prev={c.stats.vsPrevWeek.recordCount} suffix="条" />
              </div>
              <div className="weekly-stat">
                <span className="weekly-stat-label">投入</span>
                <strong>{c.stats.minutes}<small> 分钟</small></strong>
                <Delta cur={c.stats.minutes} prev={c.stats.vsPrevWeek.minutes} suffix="分" />
              </div>
              <div className="weekly-stat">
                <span className="weekly-stat-label">计划执行率</span>
                <strong>{c.stats.completionRate}<small>%</small></strong>
                <Delta cur={c.stats.completionRate} prev={c.stats.vsPrevWeek.completionRate} suffix="%" />
              </div>
              <div className="weekly-stat">
                <span className="weekly-stat-label">连续记录</span>
                <strong>{c.stats.streak}<small> 天</small></strong>
                <span className="weekly-stat-faint">截至今天</span>
              </div>
            </div>
          </section>

          {/* 排程执行卡（Step 5c；仅新 schema 数据出现：planMinutes 字段存在才渲染）
              分支：plan=0 → 「本周暂无 AI 排程」；否则计划/实际/执行率三项。
              历史周报无 planMinutes → 整卡隐藏（历史兼容）。 */}
          {c.stats.planMinutes !== undefined && (
            <section className="panel weekly-exec">
              <div className="panel-heading">
                <div><span className="eyebrow">EXECUTION TRACK</span><h2>排程执行</h2></div>
              </div>
              {c.stats.planMinutes === 0 ? (
                <p className="weekly-exec-empty">本周暂无 AI 排程：给行动路线点「安排计划」后，这里会显示本周计划与实际投入。</p>
              ) : (
                <div className="weekly-exec-grid">
                  <div className="weekly-exec-item"><span>计划投入</span><strong>{c.stats.planMinutes}<small> 分钟</small></strong></div>
                  <div className="weekly-exec-item"><span>实际投入</span><strong>{c.stats.actualMinutes ?? 0}<small> 分钟</small></strong></div>
                  <div className="weekly-exec-item"><span>执行率</span><strong>{c.stats.executionRate == null ? "—" : `${c.stats.executionRate}%`}</strong></div>
                </div>
              )}
            </section>
          )}

          {/* AI 周总结卡 */}
          <section className="panel weekly-summary">
            <div className="panel-heading">
              <div><span className="eyebrow">AI COACH</span><h2>本周总结</h2></div>
              <Sparkles size={18} className="panel-icon" />
            </div>
            <p className="weekly-summary-text">{c.summary}</p>
            {c.achievement.length > 0 && (
              <div className="weekly-block">
                <h3 className="weekly-block-title ok">本周亮点</h3>
                <ul>{c.achievement.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}
            {c.problem.length > 0 && (
              <div className="weekly-block">
                <h3 className="weekly-block-title warn">值得注意</h3>
                <ul>{c.problem.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            )}
            {c.suggestion.length > 0 && (
              <div className="weekly-block">
                <h3 className="weekly-block-title next">下周建议</h3>
                <ul>{c.suggestion.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
          </section>

          {/* 目标推进表 */}
          {c.stats.goalProgress.length > 0 && (
            <section className="panel weekly-goals">
              <div className="panel-heading">
                <div><span className="eyebrow">GOAL PROGRESS</span><h2>目标推进</h2></div>
              </div>
              <div className="weekly-goal-list">
                {c.stats.goalProgress.map((g) => (
                  <div className="weekly-goal-row" key={g.goalId}>
                    <div className="weekly-goal-head">
                      <span className="weekly-goal-title">{g.title}</span>
                      <span className="weekly-goal-done">本周完成 {g.doneThisWeek}</span>
                    </div>
                    <div className="weekly-progress"><span style={{ width: `${g.progress}%` }} /></div>
                    <span className="weekly-goal-progress-label">{g.progress}%</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 目标建议卡 */}
          {c.goalSuggestions.length > 0 && (
            <section className="panel weekly-suggest">
              <div className="panel-heading">
                <div><span className="eyebrow">SUGGESTIONS</span><h2>目标调整建议</h2></div>
              </div>
              <p className="weekly-suggest-hint">建议仅供参考，点「采纳」才会修改目标（逐个确认）。</p>
              <div className="weekly-suggest-list">
                {c.goalSuggestions.map((s, i) => (
                  <div className="weekly-suggest-item" key={`${s.goalId}-${i}`}>
                    <div className="weekly-suggest-body">
                      <span className="weekly-suggest-title">{s.newTitle}</span>
                      <span className="weekly-suggest-reason">{s.reason}</span>
                    </div>
                    <button
                      className={`weekly-adopt ${adopted[s.goalId] ? "done" : ""}`}
                      disabled={adopted[s.goalId] || adopting === s.goalId}
                      onClick={() => adoptSuggestion(s)}
                    >
                      {adopted[s.goalId] ? <><Check size={14} /> 已采纳</> : adopting === s.goalId ? "采纳中…" : "采纳"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <button className="weekly-refresh" onClick={() => generate()}>
            重新生成本周报告 <ArrowUpRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** 环比：升=红（涨），降=绿（跌），中文股市约定；持平显示 — */
function Delta({ cur, prev, suffix }: { cur: number; prev: number; suffix: string }) {
  if (prev === 0 && cur === 0) return <span className="weekly-stat-faint">—</span>;
  const diff = cur - prev;
  if (diff === 0) return <span className="weekly-stat-faint">持平</span>;
  const isUp = diff > 0;
  return (
    <span className={isUp ? "weekly-delta up" : "weekly-delta down"}>
      {isUp ? "▲" : "▼"} {Math.abs(diff)} {suffix}
    </span>
  );
}
