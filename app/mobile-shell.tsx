"use client";

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  ArrowRight,
  BarChart3,
  BedDouble,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  Dumbbell,
  Flame,
  Home as HomeIcon,
  LayoutDashboard,
  Moon,
  MoreHorizontal,
  Plus,
  Send,
  Sparkles,
  Target,
  Trophy,
  X,
} from "lucide-react";
import { demoSeed, todayShanghaiDateLabel, todayShanghaiWeekdayLabel, type Goal, type Task, type TaskKind, weeklyBars } from "@/lib/demo-data";

export type MobileTab = "今日" | "计划" | "记录" | "成长";

type MobileLiveLog = {
  id: string;
  topic: string;
  text: string;
  createdAt: string;
  xp: number;
  coin: number;
  output?: string;
  kind?: TaskKind;
  quizScore?: number;
};

type MobileAppShellProps = {
  activeTab: MobileTab;
  onNavigate: (tab: MobileTab) => void;
  tasks: Task[];
  goals: Goal[];
  logs: MobileLiveLog[];
  doneCount: number;
  earnedCoins: number;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
  onToggleTask: (id: string) => void;
  onAgentGoal: () => void;
  assistantReply: string;
  isAgentBusy: boolean;
  reviewEnabled: boolean;
  onToggleReview: () => void;
  onStartReview: () => void;
  eveningTime?: string;
  isFocusRunning: boolean;
  onToggleFocus: () => void;
  toast: string;
};

const mobileTabs: Array<{ label: MobileTab; icon: typeof LayoutDashboard; short: string }> = [
  { label: "今日", icon: LayoutDashboard, short: "今天" },
  { label: "计划", icon: CalendarDays, short: "路线" },
  { label: "记录", icon: BookOpen, short: "收集" },
  { label: "成长", icon: Trophy, short: "节奏" },
];

export default function MobileAppShell({
  activeTab,
  onNavigate,
  tasks,
  goals,
  logs,
  doneCount,
  earnedCoins,
  input,
  setInput,
  onSubmit,
  onToggleTask,
  onAgentGoal,
  assistantReply,
  isAgentBusy,
  reviewEnabled,
  onToggleReview,
  onStartReview,
  eveningTime,
  isFocusRunning,
  onToggleFocus,
  toast,
}: MobileAppShellProps) {
  const [composerOpen, setComposerOpen] = useState(false);

  function openComposer(seed = "") {
    onNavigate("今日");
    if (seed) setInput(seed);
    setComposerOpen(true);
  }

  function submitFromComposer() {
    if (!input.trim()) return;
    onSubmit();
    setComposerOpen(false);
  }

  const isHome = activeTab === "今日";

  return (
    <main className="app-mobile-v3">
      <div className="app-mobile-v3-safe-top" />
      <header className="app-mobile-v3-topbar">
        <div className="app-mobile-v3-wordmark">
          <span className="app-mobile-v3-spark"><Sparkles size={14} strokeWidth={2.8} /></span>
          <span>成长回路</span>
        </div>
        <div className="app-mobile-v3-top-actions">
          <span className="app-mobile-v3-streak"><Flame size={14} /> {demoSeed.user.streak}</span>
          <button className="app-mobile-v3-avatar" aria-label="打开个人资料">{demoSeed.user.displayName.slice(0, 1)}</button>
        </div>
      </header>

      <div className={`app-mobile-v3-scroll ${isHome ? "is-home" : ""}`}>
        {activeTab === "今日" && (
          <MobileTodayV4
            tasks={tasks}
            doneCount={doneCount}
            input={input}
            setInput={setInput}
            onSubmit={onSubmit}
            onNavigate={onNavigate}
            assistantReply={assistantReply}
            isAgentBusy={isAgentBusy}
            reviewEnabled={reviewEnabled}
            onToggleReview={onToggleReview}
            onStartReview={onStartReview}
            eveningTime={eveningTime}
            isFocusRunning={isFocusRunning}
            onToggleFocus={onToggleFocus}
          />
        )}
        {activeTab === "计划" && (
          <MobilePlanV3
            tasks={tasks}
            goals={goals}
            doneCount={doneCount}
            onToggleTask={onToggleTask}
            onAgentGoal={onAgentGoal}
            onToggleFocus={onToggleFocus}
            isFocusRunning={isFocusRunning}
          />
        )}
        {activeTab === "记录" && <MobileRecordsV3 logs={logs} onOpenComposer={() => openComposer()} />}
        {activeTab === "成长" && <MobileGrowthV3 earnedCoins={earnedCoins} />}
      </div>

      {!isHome && <button className="app-mobile-v3-fab" onClick={() => openComposer()} aria-label="打开随手记录">
        <Plus size={20} strokeWidth={2.8} />
        <span>记录</span>
      </button>}

      <nav className="app-mobile-v3-tabbar" aria-label="移动端主导航">
        {mobileTabs.map(({ label, icon: Icon, short }) => (
          <button key={label} className={activeTab === label ? "is-active" : ""} onClick={() => onNavigate(label)} aria-current={activeTab === label ? "page" : undefined}>
            <Icon size={19} strokeWidth={activeTab === label ? 2.6 : 1.9} />
            <span>{short}</span>
          </button>
        ))}
      </nav>

      {composerOpen && (
        <MobileComposerV3
          input={input}
          setInput={setInput}
          isBusy={isAgentBusy}
          onClose={() => setComposerOpen(false)}
          onSubmit={submitFromComposer}
        />
      )}

      {toast && <div className="app-mobile-v3-toast" role="status" aria-live="polite"><span /><p>{toast}</p></div>}
    </main>
  );
}

function MobileTodayV4({
  tasks,
  doneCount,
  input,
  setInput,
  onSubmit,
  onNavigate,
  assistantReply,
  isAgentBusy,
  reviewEnabled,
  onToggleReview,
  onStartReview,
  eveningTime,
  isFocusRunning,
  onToggleFocus,
}: {
  tasks: Task[];
  doneCount: number;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
  onNavigate: (tab: MobileTab) => void;
  assistantReply: string;
  isAgentBusy: boolean;
  reviewEnabled: boolean;
  onToggleReview: () => void;
  onStartReview: () => void;
  eveningTime?: string;
  isFocusRunning: boolean;
  onToggleFocus: () => void;
}) {
  const primaryTask = tasks.find((task) => task.status === "current") || tasks.find((task) => task.status !== "done") || tasks[0];

  return (
    <div className="app-mobile-v4-home" data-mobile-home="v4">
      <section className="app-mobile-v4-meta" aria-label="今日状态">
        <div className="app-mobile-v4-date"><span className="app-mobile-v4-mini-mark"><Sparkles size={12} /></span><strong>今天</strong><span>{todayShanghaiWeekdayLabel()} · {todayShanghaiDateLabel()}</span></div>
        <span className="app-mobile-v4-streak"><Flame size={13} /> 连续 {demoSeed.user.streak} 天</span>
      </section>

      <section className="app-mobile-v4-stage" aria-label="AI 今日对话">
        <div className="app-mobile-v4-presence">
          <div className={`app-mobile-v4-orb ${isAgentBusy ? "is-busy" : ""}`}><Sparkles size={21} /></div>
          <div><span>AI 今日搭档</span><strong>{isAgentBusy ? "我正在整理这件事" : "我在听，随时告诉我"}</strong></div>
          <i className="app-mobile-v4-online-dot" aria-label="在线" />
        </div>
        <p className="app-mobile-v4-reply">{assistantReply}</p>
        <div className="app-mobile-v4-next">
          <div className="app-mobile-v4-next-label"><span>下一步</span><em>{primaryTask?.duration || "15 min"}</em></div>
          <div className="app-mobile-v4-next-main"><strong>{primaryTask?.title || "写下今天的第一件事"}</strong><button onClick={onToggleFocus}>{isFocusRunning ? <><i />专注中</> : <>开始 <ArrowRight size={14} /></>}</button></div>
          <p>{primaryTask?.subtitle || "AI 会替你把目标拆成现在能完成的一小步。"}</p>
        </div>
      </section>

      <section className="app-mobile-v4-composer" aria-label="写给 AI">
        <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="今天发生了什么？直接说给我。" rows={4} aria-label="今天发生了什么" />
        <div className="app-mobile-v4-composer-foot"><span>{input.length}/480</span><button onClick={onSubmit} disabled={!input.trim() || isAgentBusy}>{isAgentBusy ? <><span className="app-mobile-v4-spinner" />整理中</> : <>发给 AI <Send size={15} /></>}</button></div>
      </section>

      <section className="app-mobile-v4-links" aria-label="AI 自动安排">
        <button className="app-mobile-v4-review-link" onClick={onStartReview}><Moon size={14} /><span>{reviewEnabled ? `今晚 ${eveningTime ?? "21:30"}，AI 会来做晚报` : "晚报未开启，点这里交给 AI"}</span><ArrowRight size={13} /></button>
        <div className="app-mobile-v4-progress-link"><button onClick={() => onNavigate("计划")}><span>{doneCount}/{tasks.length} 个下一步完成</span><ChevronRight size={14} /></button><button className={`app-mobile-v4-review-toggle ${reviewEnabled ? "is-on" : ""}`} onClick={onToggleReview} aria-pressed={reviewEnabled}><i />{reviewEnabled ? "已安排" : "安排"}</button></div>
      </section>
    </div>
  );
}

function MobileTaskV3({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  return (
    <article className={`app-mobile-v3-task ${task.status === "done" ? "is-done" : task.status === "current" ? "is-current" : ""}`}>
      <div className={`app-mobile-v3-task-marker kind-${task.kind}`}>{renderTaskKindIcon(task.kind, 16)}</div>
      <div className="app-mobile-v3-task-copy"><div><strong>{task.title}</strong><span>{task.time}</span></div><p>{task.duration} · {task.subtitle}</p></div>
      <button className={`app-mobile-v3-check ${task.status === "done" ? "is-checked" : ""}`} onClick={() => onToggle(task.id)} aria-label={`${task.status === "done" ? "撤销" : "完成"}：${task.title}`}>{task.status === "done" ? <Check size={14} strokeWidth={3} /> : <span />}</button>
    </article>
  );
}

function MobilePlanV3({ tasks, goals, doneCount, onToggleTask, onAgentGoal, onToggleFocus, isFocusRunning }: { tasks: Task[]; goals: Goal[]; doneCount: number; onToggleTask: (id: string) => void; onAgentGoal: () => void; onToggleFocus: () => void; isFocusRunning: boolean }) {
  const goal = goals[0];
  return (
    <div className="app-mobile-v3-page app-mobile-v3-subpage">
      <section className="app-mobile-v3-page-title"><span className="app-mobile-v3-label">ROADMAP</span><h1>把目标放到今天。</h1><p>路线不是待办清单，它只需要告诉你下一步往哪里走。</p></section>
      {goal ? (
      <section className="app-mobile-v3-goal-card">
        <div className="app-mobile-v3-goal-head"><span>{goal.status} · {goal.horizon || "未设周期"}</span><Target size={17} /></div>
        <h2>{goal.title}</h2><p>{goal.description || "还没有描述"}</p>
        <div className="app-mobile-v3-goal-track"><b style={{ width: `${goal.progress}%` }} /></div>
        <div className="app-mobile-v3-goal-foot"><span>当前进度</span><strong>{goal.progress}%</strong></div>
      </section>
      ) : (
      <section className="app-mobile-v3-goal-card">
        <div className="app-mobile-v3-goal-head"><span>进行中</span><Target size={17} /></div>
        <h2>还没有目标</h2><p>先在电脑上创建一个目标，这里会显示你的真实路线。</p>
        <div className="app-mobile-v3-goal-track"><b style={{ width: "0%" }} /></div>
        <div className="app-mobile-v3-goal-foot"><span>当前进度</span><strong>0%</strong></div>
      </section>
      )}
      <section className="app-mobile-v3-route-card">
        <div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">AI ROUTE</span><h2>Agent 学习路线</h2></div><Sparkles size={17} /></div>
        <div className="app-mobile-v3-route-step is-current"><div className="app-mobile-v3-route-index">01</div><div><strong>定义问题与验收标准</strong><p>把一个真实问题做成可观察的最小闭环。</p></div><button onClick={onAgentGoal} aria-label="添加今天的行动"><Plus size={15} /></button></div>
        <div className="app-mobile-v3-route-step"><div className="app-mobile-v3-route-index">02</div><div><strong>连接工具与状态</strong><p>让 Agent 能够完成一次真实动作。</p></div><CircleCheck size={16} /></div>
        <div className="app-mobile-v3-route-step"><div className="app-mobile-v3-route-index">03</div><div><strong>跑通一次对话闭环</strong><p>从输入、判断到结果，留下可验证证据。</p></div><CircleCheck size={16} /></div>
      </section>
      <section className="app-mobile-v3-plan-section"><div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">TODAY</span><h2>{doneCount}/{tasks.length} 个动作完成</h2></div><button onClick={onToggleFocus}>{isFocusRunning ? "暂停" : "开始专注"}</button></div><div className="app-mobile-v3-task-list">{tasks.map((task) => <MobileTaskV3 key={task.id} task={task} onToggle={onToggleTask} />)}</div></section>
    </div>
  );
}

function MobileRecordsV3({ logs, onOpenComposer }: { logs: MobileLiveLog[]; onOpenComposer: () => void }) {
  const understandingCount = demoSeed.learningLogs.filter((log) => log.evidence !== "输入").length + logs.filter((log) => log.output).length;
  const allRecords = [
    ...logs.map((log) => ({ id: log.id, topic: log.topic, body: log.text, tag: log.output ? "已整理" : "已记录", time: log.createdAt, xp: log.xp, live: true })),
    ...demoSeed.learningLogs.map((log) => ({ id: log.id, topic: log.topic, body: log.summary, tag: log.evidence === "应用" ? "实际应用" : log.evidence === "输入 + 输出" ? "理解回应" : "行动记录", time: log.occurredAt, xp: log.xp, live: false })),
  ];
  return (
    <div className="app-mobile-v3-page app-mobile-v3-subpage">
      <section className="app-mobile-v3-page-title"><span className="app-mobile-v3-label">CAPTURE</span><h1>把今天收进来。</h1><p>想到什么就记什么，晚报会替你把零散片段串成进步。</p></section>
      <button className="app-mobile-v3-capture-cta" onClick={onOpenComposer}><span className="app-mobile-v3-capture-icon"><Plus size={19} /></span><span><strong>刚刚发生了什么？</strong><small>学习、运动、生活、休息，都可以</small></span><ArrowRight size={17} /></button>
      <section className="app-mobile-v3-record-stats"><div><span>本周片段</span><strong>{allRecords.length}</strong></div><div><span>理解记录</span><strong>{understandingCount}</strong></div><div><span>获得 XP</span><strong>{demoSeed.learningLogs.reduce((total, log) => total + log.xp, 0) + logs.reduce((total, log) => total + log.xp, 0)}</strong></div></section>
      <section className="app-mobile-v3-timeline"><div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">RECENT</span><h2>成长时间线</h2></div><MoreHorizontal size={18} /></div>{allRecords.map((record) => <article className={`app-mobile-v3-timeline-item ${record.live ? "is-live" : ""}`} key={record.id}><div className="app-mobile-v3-timeline-dot" /><div className="app-mobile-v3-timeline-body"><div className="app-mobile-v3-timeline-top"><strong>{record.topic}</strong><span>+{record.xp} XP</span></div><p>{record.body}</p><div className="app-mobile-v3-timeline-meta"><span>{record.tag}</span><time>{record.time}</time></div></div></article>)}</section>
    </div>
  );
}

function MobileGrowthV3({ earnedCoins }: { earnedCoins: number }) {
  const totalMinutes = weeklyBars.reduce((total, bar) => total + Number.parseInt(bar.label, 10), 0);
  const understandingCount = demoSeed.learningLogs.filter((log) => log.evidence !== "输入").length;
  const rhythm = 68;
  return (
    <div className="app-mobile-v3-page app-mobile-v3-subpage">
      <section className="app-mobile-v3-page-title"><span className="app-mobile-v3-label">YOUR RHYTHM</span><h1>看见自己的节奏。</h1><p>成长不是把每一天塞满，而是知道什么让你继续往前。</p></section>
      <section className="app-mobile-v3-rhythm-card"><div className="app-mobile-v3-rhythm-orbit" style={{ "--rhythm-progress": `${rhythm * 3.6}deg` } as React.CSSProperties}><div><strong>{rhythm}</strong><span>本周节奏</span></div></div><div className="app-mobile-v3-rhythm-copy"><span>当前等级 · LV {demoSeed.user.level}</span><h2>{demoSeed.user.role}</h2><p>距离下一级还差 84 XP</p><div className="app-mobile-v3-rhythm-track"><b style={{ width: "68%" }} /></div></div></section>
      <div className="app-mobile-v3-stat-grid"><div><Flame size={16} /><span>连续有效行动</span><strong>{demoSeed.user.streak}<small> 天</small></strong></div><div><Clock3 size={16} /><span>本周投入</span><strong>{Math.floor(totalMinutes / 60)}<small>h</small>{totalMinutes % 60}<small>m</small></strong></div><div><BookOpen size={16} /><span>理解记录</span><strong>{understandingCount}<small> 条</small></strong></div><div><Trophy size={16} /><span>成长积分</span><strong>{demoSeed.user.coinBalance + earnedCoins}<small> coin</small></strong></div></div>
      <section className="app-mobile-v3-week-card"><div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">LAST 7 DAYS</span><h2>投入的形状</h2></div><BarChart3 size={17} /></div><div className="app-mobile-v3-week-bars">{weeklyBars.map((bar, index) => <div className="app-mobile-v3-week-bar" key={bar.day}><span>{bar.label}</span><i><b className={index === 3 ? "is-highlight" : ""} style={{ height: `${bar.value}%` }} /></i><small>{bar.day}</small></div>)}</div></section>
      <section className="app-mobile-v3-insight"><span className="app-mobile-v3-insight-icon"><Sparkles size={16} /></span><div><span className="app-mobile-v3-label">AI OBSERVATION</span><p>{demoSeed.insight}</p></div></section>
    </div>
  );
}

function MobileComposerV3({ input, setInput, isBusy, onClose, onSubmit }: { input: string; setInput: Dispatch<SetStateAction<string>>; isBusy: boolean; onClose: () => void; onSubmit: () => void }) {
  return (
    <div className="app-mobile-v3-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="app-mobile-v3-sheet" role="dialog" aria-modal="true" aria-label="随手记录" onClick={(event) => event.stopPropagation()}>
        <div className="app-mobile-v3-sheet-handle" />
        <header><div><span className="app-mobile-v3-label">CAPTURE A MOMENT</span><h2>说给 AI，先不用整理。</h2></div><button onClick={onClose} aria-label="关闭记录"><X size={19} /></button></header>
        <div className="app-mobile-v3-sheet-note"><span className="app-mobile-v3-ai-orb"><Sparkles size={14} /></span><p>写下事实、感受或一个小进展。今晚的晚报会帮你找到它的意义。</p></div>
        <textarea autoFocus value={input} onChange={(event) => setInput(event.target.value)} placeholder="今天发生了什么？" rows={6} aria-label="今天发生了什么" />
        <div className="app-mobile-v3-sheet-foot"><span>{input.length}/480</span><button onClick={onSubmit} disabled={isBusy || !input.trim()}>{isBusy ? <><span className="app-mobile-v3-spinner" />整理中</> : <>保存这一刻 <ArrowRight size={16} /></>}</button></div>
      </section>
    </div>
  );
}

function renderTaskKindIcon(kind: TaskKind, size: number) {
  if (kind === "learn") return <BookOpen size={size} />;
  if (kind === "exercise") return <Dumbbell size={size} />;
  if (kind === "life") return <HomeIcon size={size} />;
  if (kind === "rest") return <BedDouble size={size} />;
  return <Target size={size} />;
}
