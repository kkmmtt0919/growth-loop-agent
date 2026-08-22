"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import {
  ArrowUpRight,
  BarChart3,
  BedDouble,
  Brain,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Coffee,
  Dumbbell,
  Flame,
  Home as HomeIcon,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessageCircle,
  Pause,
  Play,
  Plus,
  ReceiptText,
  RotateCcw,
  Sparkles,
  Target,
  Timer,
  Trophy,
  WalletCards,
  X,
} from "lucide-react";
import { demoSeed, initialTasks, type Goal, type Task, type TaskKind, weeklyBars } from "@/lib/demo-data";
import type { QuizGrade, QuizQuestion } from "@/lib/agent/quiz";
import MobileAppShell, { type MobileTab } from "./mobile-shell";

type Tab = MobileTab;

type LogEntry = {
  id: string;
  text: string;
  topic: string;
  kind?: TaskKind;
  minutes?: number;
  output?: string;
  intent: "quick_log" | "plan_today" | "review";
  xp: number;
  coin: number;
  createdAt: string;
  mode: "llm" | "demo" | "pending";
  quizId?: string;
  quizScore?: number;
  quizRewarded?: boolean;
};

type QuizSession = {
  quizId: string;
  topic: string;
  sourceSummary: string;
  questions: QuizQuestion[];
  mode: "llm" | "demo";
  provider: string;
};

type PomodoroMode = "focus" | "break";

const LOG_STORAGE_KEY = "growth-loop.logs.v2";
const SESSION_STORAGE_KEY = "growth-loop.agent-session.v1";
const REVIEW_STORAGE_KEY = "growth-loop.review-enabled.v1";
const AUTH_TOKEN_KEY = "growth-loop.auth-token";
const LOG_EVENT = "growth-loop:logs";
const EMPTY_LOGS: LogEntry[] = [];
const POMODORO_FOCUS_SECONDS = 25 * 60;
const POMODORO_BREAK_SECONDS = 5 * 60;
const EVENING_REVIEW_HOUR = 21;
const EVENING_REVIEW_MINUTE = 30;
let logSnapshot: { raw: string; value: LogEntry[] } = { raw: "", value: EMPTY_LOGS };

/**
 * 数据库模式：把服务端工作台数据就地写回 demoSeed 对象。
 * demoSeed 是模块级常量对象，所有子组件引用同一引用，自动看到新数据，
 * 无需给每个子组件传 props。切回原型模式时刷新页面即可恢复 seed。
 */
function applyWorkspaceData(data: typeof demoSeed) {
  demoSeed.seedVersion = data.seedVersion ?? demoSeed.seedVersion;
  demoSeed.user = data.user;
  demoSeed.goals = data.goals;
  demoSeed.tasks = data.tasks;
  demoSeed.learningLogs = data.learningLogs;
  demoSeed.ledger = data.ledger;
  demoSeed.weeklyBars = data.weeklyBars;
  demoSeed.insight = data.insight;
  demoSeed.quote = data.quote;
}

type AuthMode = "loading" | "demo" | "login" | "ready";

/** 晚报卡片单状态驱动（杜绝 loading+error 等非法组合） */
type EveningState = "loading" | "no-report" | "generating" | "ready" | "error";

type EveningCardState = {
  state: EveningState;
  summary?: string;
};

/** 数据库记录 -> 前端 LogEntry（保存后即时回显用） */
function recordToLogEntry(record: {
  id: string;
  text: string;
  topic: string;
  kind?: LogEntry["kind"];
  minutes?: number;
  output?: string;
  intent: LogEntry["intent"];
  xp: number;
  coin: number;
  mode: LogEntry["mode"];
}): LogEntry {
  return {
    id: record.id,
    text: record.text,
    topic: record.topic || "学习记录",
    kind: record.kind,
    minutes: record.minutes,
    output: record.output,
    intent: record.intent,
    xp: record.xp,
    coin: record.coin,
    createdAt: "刚刚",
    mode: record.mode,
  };
}

function readStoredLogs() {
  if (typeof window === "undefined") return EMPTY_LOGS;
  const raw = window.localStorage.getItem(LOG_STORAGE_KEY) || "[]";
  if (raw === logSnapshot.raw) return logSnapshot.value;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const value = Array.isArray(parsed) ? parsed.filter((log): log is LogEntry => Boolean(log && typeof log === "object" && "text" in log)) : EMPTY_LOGS;
    logSnapshot = { raw, value };
    return value;
  } catch {
    logSnapshot = { raw, value: EMPTY_LOGS };
    return EMPTY_LOGS;
  }
}

function subscribeToLogs(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(LOG_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(LOG_EVENT, onStoreChange);
  };
}

function writeStoredLogs(logs: LogEntry[]) {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(logs);
  logSnapshot = { raw, value: logs };
  window.localStorage.setItem(LOG_STORAGE_KEY, raw);
  window.dispatchEvent(new Event(LOG_EVENT));
}

const tabs: Array<{ label: Tab; icon: typeof LayoutDashboard }> = [
  { label: "今日", icon: LayoutDashboard },
  { label: "计划", icon: CalendarDays },
  { label: "记录", icon: BookOpen },
  { label: "成长", icon: Trophy },
];

const tabCopy: Record<Tab, { eyebrow: string; suffix: string; description: string }> = {
  今日: { eyebrow: "今日回路", suffix: "只推进一件重要的事", description: "把注意力放在下一步，完成之后，进步自然会留下痕迹。" },
  计划: { eyebrow: "计划地图", suffix: "让长期目标落到今天", description: "目标不是另一张待办清单，它要能告诉你下一步为什么值得做。" },
  记录: { eyebrow: "成长档案", suffix: "把事实留下来", description: "每一条记录都是以后判断进步时可以回看的证据。" },
  成长: { eyebrow: "成长仪表盘", suffix: "看见节奏，而不是给自己打分", description: "用近 7 天的行动和证据，找到下一轮最值得尝试的调整。" },
};

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("今日");
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [input, setInput] = useState("");
  const logs = useSyncExternalStore(subscribeToLogs, readStoredLogs, () => EMPTY_LOGS);
  const [isFocusRunning, setIsFocusRunning] = useState(false);
  const [pomodoroMode, setPomodoroMode] = useState<PomodoroMode>("focus");
  const [pomodoroSeconds, setPomodoroSeconds] = useState(POMODORO_FOCUS_SECONDS);
  const [isPomodoroRunning, setIsPomodoroRunning] = useState(false);
  const [showPomodoro, setShowPomodoro] = useState(false);
  const [isRemindersPaused, setIsRemindersPaused] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [toast, setToast] = useState("");
  const [assistantReply, setAssistantReply] = useState("把今天发生的事直接写给我就好。白天我先帮你收好记录，晚上 21:30 再把今天几条记录合在一起，统一问你最重要的一步、真正理解的地方和明天的行动。" );
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [isMobileExperience, setIsMobileExperience] = useState(false);
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [isQuizOverlayOpen, setIsQuizOverlayOpen] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [quizGrade, setQuizGrade] = useState<QuizGrade | null>(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizSourceLogId, setQuizSourceLogId] = useState<string | null>(null);
  const [quizError, setQuizError] = useState("");
  const quickLogRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reviewTimer = useRef<number | null>(null);
  const sessionIdRef = useRef("anonymous");
  const [authMode, setAuthMode] = useState<AuthMode>("loading");
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [evening, setEvening] = useState<EveningCardState>({ state: "loading" });

  useEffect(() => {
    const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY) || `session-${Date.now()}`;
    window.localStorage.setItem(SESSION_STORAGE_KEY, storedSessionId);
    sessionIdRef.current = storedSessionId;
    const storedReviewPreference = window.localStorage.getItem(REVIEW_STORAGE_KEY);
    const reviewTimer = window.setTimeout(() => {
      if (storedReviewPreference !== null) setReviewEnabled(storedReviewPreference === "true");
    }, 0);
    return () => window.clearTimeout(reviewTimer);
  }, []);

  // 启动探测数据模式：
  //   /api/demo 返回 seeded-demo -> 数据库未配置，原型模式
  //   /api/demo 返回 401         -> 已配置但未登录，显示登录页
  //   /api/demo 返回 database    -> 已配置且 token 有效，进入工作台
  useEffect(() => {
    let cancelled = false;
    const token = typeof window !== "undefined" ? window.localStorage.getItem(AUTH_TOKEN_KEY) : null;
    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch("/api/demo", { headers });
        if (res.status === 401) {
          if (!cancelled) setAuthMode("login");
          return;
        }
        if (!res.ok) throw new Error("demo unavailable");
        const payload = (await res.json()) as { mode?: string; data?: typeof demoSeed };
        if (payload.mode === "seeded-demo") {
          if (!cancelled) setAuthMode("demo");
        } else if (payload.mode === "database" && payload.data) {
          applyWorkspaceData(payload.data);
          setTasks(payload.data.tasks as Task[]);
          window.localStorage.removeItem(LOG_STORAGE_KEY);
          if (token) setAuthToken(token);
          if (!cancelled) setAuthMode("ready");
        } else {
          throw new Error("unknown demo mode");
        }
      } catch {
        if (!cancelled) setAuthMode("demo"); // 网络异常/未配置：回退原型模式
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 晚报懒触发：ready 模式下查今日晚报；已过 21:30 且未生成则自动生成（服务端幂等）
  useEffect(() => {
    if (authMode !== "ready" || !authToken) return;
    let cancelled = false;
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    (async () => {
      try {
        const res = await fetch("/api/evening-report/today", { headers });
        if (!res.ok) throw new Error("evening unavailable");
        const { report } = (await res.json()) as { report?: { summary: string } | null };
        if (cancelled) return;
        if (report) {
          setEvening({ state: "ready", summary: report.summary });
          return;
        }
        const now = new Date();
        const reached = now.getHours() > EVENING_REVIEW_HOUR || (now.getHours() === EVENING_REVIEW_HOUR && now.getMinutes() >= EVENING_REVIEW_MINUTE);
        if (!reached) {
          setEvening({ state: "no-report" });
          return;
        }
        setEvening({ state: "generating" });
        const gen = await fetch("/api/evening-report", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
        });
        if (!gen.ok) throw new Error("evening generate failed");
        const data = (await gen.json()) as { report?: { summary?: string } };
        if (!cancelled) {
          setEvening({ state: "ready", summary: data.report?.summary ?? "今日晚报已生成" });
        }
      } catch {
        if (!cancelled) setEvening({ state: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authMode, authToken]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 820px)");
    const isAndroidWebView = /Android/i.test(window.navigator.userAgent);
    const syncExperience = () => setIsMobileExperience(Capacitor.isNativePlatform() || isAndroidWebView || mediaQuery.matches);
    syncExperience();
    mediaQuery.addEventListener?.("change", syncExperience);
    mediaQuery.addListener?.(syncExperience);
    return () => {
      mediaQuery.removeEventListener?.("change", syncExperience);
      mediaQuery.removeListener?.(syncExperience);
    };
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!reviewEnabled) return;
    const scheduleNextReview = () => {
      const now = new Date();
      const nextReview = new Date(now);
      nextReview.setHours(EVENING_REVIEW_HOUR, EVENING_REVIEW_MINUTE, 0, 0);
      if (nextReview.getTime() <= now.getTime()) nextReview.setDate(nextReview.getDate() + 1);
      reviewTimer.current = window.setTimeout(() => {
        setInput((value) => value || "今晚回顾");
        setAssistantReply("到晚间了。我会根据今天的记录统一追问三件事：最重要的行动、真正理解或应用的地方、明天的一步。先从你最想保留的一件事开始。" );
        setActiveTab("今日");
        notify("21:30 晚间回顾已准备好");
        scheduleNextReview();
      }, Math.max(1_000, nextReview.getTime() - now.getTime()));
    };
    scheduleNextReview();
    return () => {
      if (reviewTimer.current) window.clearTimeout(reviewTimer.current);
    };
  }, [reviewEnabled]);

  useEffect(() => {
    if (!isPomodoroRunning) return;
    const timer = window.setInterval(() => {
      setPomodoroSeconds((seconds) => {
        if (seconds > 1) return seconds - 1;
        setIsPomodoroRunning(false);
        notify(pomodoroMode === "focus" ? "这一轮专注完成了，切换到 5 分钟恢复吧" : "恢复完成，准备开始下一轮专注吧");
        return pomodoroMode === "focus" ? POMODORO_BREAK_SECONDS : POMODORO_FOCUS_SECONDS;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isPomodoroRunning, pomodoroMode]);

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3_200);
  }

  function commitLogs(nextLogs: LogEntry[]) {
    if (authMode === "ready") {
      // 数据库模式：数据已入库，只更新内存快照用于即时回显
      logSnapshot = { raw: "", value: nextLogs };
      window.dispatchEvent(new Event(LOG_EVENT));
      return;
    }
    writeStoredLogs(nextLogs);
  }

  async function submitAuth(credentials: { email: string; password: string; displayName?: string }, isRegister: boolean) {
    setAuthBusy(true);
    setAuthError("");
    try {
      const res = await fetch(isRegister ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      const payload = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !payload.token) {
        setAuthError(payload.error || "登录失败，请重试");
        return;
      }
      window.localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
      setAuthToken(payload.token);
      const dataRes = await fetch("/api/demo", { headers: { Authorization: `Bearer ${payload.token}` } });
      if (!dataRes.ok) throw new Error("load workspace failed");
      const dataPayload = (await dataRes.json()) as { mode?: string; data?: typeof demoSeed };
      if (dataPayload.mode === "database" && dataPayload.data) {
        applyWorkspaceData(dataPayload.data);
        setTasks(dataPayload.data.tasks as Task[]);
        window.localStorage.removeItem(LOG_STORAGE_KEY);
      }
      setAuthMode("ready");
      notify(isRegister ? "账号已创建，欢迎加入" : "欢迎回来");
    } catch {
      setAuthError("网络异常，请稍后重试");
    } finally {
      setAuthBusy(false);
    }
  }

  function logout() {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    window.location.reload();
  }

  function togglePomodoro() {
    setIsPomodoroRunning((running) => !running);
    notify(isPomodoroRunning ? "番茄钟已暂停，进度会保留" : `${pomodoroMode === "focus" ? "25 分钟专注" : "5 分钟恢复"}已开始`);
  }

  function toggleFocusSession() {
    setIsFocusRunning((running) => !running);
    notify(isFocusRunning ? "专注已暂停，进度会保留" : "专注已开始，先做 10 分钟");
  }

  function resetPomodoro() {
    setIsPomodoroRunning(false);
    setPomodoroSeconds(pomodoroMode === "focus" ? POMODORO_FOCUS_SECONDS : POMODORO_BREAK_SECONDS);
    notify("番茄钟已重置");
  }

  function changePomodoroMode(mode: PomodoroMode) {
    setPomodoroMode(mode);
    setIsPomodoroRunning(false);
    setPomodoroSeconds(mode === "focus" ? POMODORO_FOCUS_SECONDS : POMODORO_BREAK_SECONDS);
  }

  const doneCount = tasks.filter((task) => task.status === "done").length;
  const earnedCoins = tasks.filter((task) => task.status === "done").reduce((total, task) => total + task.coin, 0) + logs.reduce((total, log) => total + log.coin, 0);

  const greeting = useMemo(() => {
    if (doneCount === tasks.length) return "今天的回路已经闭合";
    if (doneCount > 0) return "很好，今天已经开始转起来了";
    return "早上好，周予安";
  }, [doneCount, tasks.length]);

  function toggleTask(id: string) {
    if (authMode === "ready") {
      const target = tasks.find((task) => task.id === id);
      const done = target?.status !== "done";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      fetch("/api/tasks", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ taskId: id, done }),
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("tasks unavailable"))))
        .then(({ task }: { task: Task }) => {
          setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, status: task.status } : t)));
          notify(done ? `+${task.xp} XP · +${task.coin} 积分，行动已记下` : "已把这次行动放回今日计划");
        })
        .catch(() => notify("任务更新失败，请重试"));
      return;
    }
    setTasks((current) =>
      current.map((task) => {
        if (task.id !== id) return task;
        const nextStatus = task.status === "done" ? "upcoming" : "done";
        return { ...task, status: nextStatus };
      }),
    );
    const target = tasks.find((task) => task.id === id);
    if (target?.status === "done") {
      notify("已把这次行动放回今日计划");
    } else {
      notify(`+${target?.xp ?? 0} XP · +${target?.coin ?? 0} 积分，行动已记下`);
    }
  }

  async function generateQuiz(content: string, topic?: string, output?: string, sourceLogId?: string, openOverlay = false) {
    if (!content.trim()) return;
    setQuizBusy(true);
    setQuizError("");
    setQuizGrade(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authMode === "ready" && authToken) headers.Authorization = `Bearer ${authToken}`;
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "generate", content, topic, output, recordId: sourceLogId }),
      });
      if (!response.ok) throw new Error("quiz unavailable");
      const quiz = (await response.json()) as QuizSession;
      setActiveQuiz(quiz);
      setQuizAnswers({});
      setQuizSourceLogId(sourceLogId || null);
      setIsQuizOverlayOpen(openOverlay);
      notify(`已为「${quiz.topic}」生成 ${quiz.questions.length} 道理解题，写完再看分数`);
    } catch {
      setQuizError("题目生成失败了，可以稍后重试；学习记录不会丢失。");
    } finally {
      setQuizBusy(false);
    }
  }

  async function gradeQuiz() {
    if (!activeQuiz || quizBusy) return;
    setQuizBusy(true);
    setQuizError("");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authMode === "ready" && authToken) headers.Authorization = `Bearer ${authToken}`;
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "grade",
          quizId: activeQuiz.quizId,
          topic: activeQuiz.topic,
          source: activeQuiz.sourceSummary,
          questions: activeQuiz.questions,
          answers: quizAnswers,
        }),
      });
      if (!response.ok) throw new Error("grade unavailable");
      const result = (await response.json()) as QuizGrade;
      setQuizGrade(result);
      // 数据库模式：bonus XP 已在服务端幂等发放，这里只记录分数不重复加
      if (quizSourceLogId && authMode !== "ready") {
        const bonus = result.score >= 85 ? 10 : result.score >= 60 ? 6 : 3;
        commitLogs(readStoredLogs().map((log) => {
          if (log.id !== quizSourceLogId) return log;
          if (log.quizRewarded) return { ...log, quizId: activeQuiz.quizId, quizScore: result.score };
          return { ...log, quizId: activeQuiz.quizId, quizScore: result.score, quizRewarded: true, xp: log.xp + bonus, coin: log.coin + Math.max(1, Math.round(bonus / 3)) };
        }));
      }
      notify(`理解测验完成：${result.score} 分，${result.level}`);
    } catch {
      setQuizError("评分暂时不可用，请检查连接后再试。");
    } finally {
      setQuizBusy(false);
    }
  }

  function resetQuiz() {
    setQuizGrade(null);
    setQuizAnswers({});
    setQuizError("");
  }

  function closeQuizOverlay() {
    setIsQuizOverlayOpen(false);
  }

  async function submitLog() {
    const message = input.trim();
    if (!message) return;
    const isEveningReview = /^今晚回顾/.test(message);
    const reviewContext = isEveningReview
      ? logs.slice(0, 12).map((log) => `- ${log.topic || "今日记录"}：${log.text}`).join("\n")
      : undefined;
    const id = typeof window !== "undefined" && window.crypto?.randomUUID ? window.crypto.randomUUID() : `log-${Date.now()}`;
    const optimisticLog: LogEntry = {
      id,
      text: message,
      topic: "整理中…",
      intent: "quick_log",
      xp: 3,
      coin: 1,
      createdAt: "刚刚",
      mode: "pending",
    };
    commitLogs([optimisticLog, ...readStoredLogs()]);
    setInput("");
    setIsAgentBusy(true);
    setAssistantReply("已记下。白天先不用停下来答题，今晚的晚报会把今天的记录合在一起，再统一追问。" );
    notify("已保存，晚报时统一回顾");

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authMode === "ready" && authToken) headers.Authorization = `Bearer ${authToken}`;
      const response = await fetch("/api/agent", {
        method: "POST",
        headers,
        body: JSON.stringify({ message, conversationId: sessionIdRef.current, context: reviewContext }),
      });
      if (!response.ok) throw new Error("agent unavailable");
      const result = (await response.json()) as {
        intent?: LogEntry["intent"];
        mode?: "llm" | "demo";
        extracted?: { kind?: TaskKind; topic?: string; minutes?: number; output?: string };
        reply?: string;
        record?: Parameters<typeof recordToLogEntry>[0] | null;
      };
      setAssistantReply(result.reply || "已记下。今晚我会根据今天的记录统一追问，帮助你把经历变成明天可用的经验。" );

      if (authMode === "ready") {
        // 数据库模式：记录已持久化，用服务端 record 即时回显
        commitLogs(result.record ? [recordToLogEntry(result.record), ...readStoredLogs()] : readStoredLogs());
      } else {
        const resolvedOutput = result.extracted?.output || undefined;
        commitLogs(readStoredLogs().map((log) => log.id === id ? {
          ...log,
          kind: result.extracted?.kind,
          topic: result.extracted?.topic || message || "学习记录",
          minutes: result.extracted?.minutes,
          output: resolvedOutput,
          intent: result.intent || "quick_log",
          mode: result.mode || "demo",
        } : log));
      }
    } catch {
      if (authMode !== "ready") {
        commitLogs(readStoredLogs().map((log) => log.id === id ? { ...log, topic: message || "学习记录", mode: "demo" } : log));
      }
      setAssistantReply(authMode === "ready" ? "这条记录没能保存到云端，稍后重试。" : "我已经先把这条记录保存在本机。今晚的晚报会继续根据今天的记录提问。" );
      notify(authMode === "ready" ? "保存失败，请重试" : "已保存到本机，Agent 整理稍后可重试");
    } finally {
      setIsAgentBusy(false);
    }
  }

  function focusQuickLog() {
    setActiveTab("记录");
    window.setTimeout(() => {
      quickLogRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      quickLogRef.current?.focus();
    }, 80);
  }

  function toggleReviewSchedule() {
    const nextEnabled = !reviewEnabled;
    setReviewEnabled(nextEnabled);
    window.localStorage.setItem(REVIEW_STORAGE_KEY, String(nextEnabled));
    notify(nextEnabled ? "已开启每日 21:30 晚间回顾" : "已关闭晚间回顾提醒");
  }

  function startEveningReview() {
    setInput((value) => value || "今晚回顾" );
    setAssistantReply("晚报会把今天的记录合在一起，依次问你：最重要的行动、真正理解或应用的地方、明天的一步。你只要先告诉我最想保留的一件事。" );
    setActiveTab("今日");
    window.setTimeout(() => {
      quickLogRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      quickLogRef.current?.focus();
    }, 80);
    notify("晚间回顾已准备好，写下今天最重要的一件事");
  }

  function splitGoal(goal: Goal) {
    const taskId = `goal-step-${goal.id}`;
    const isAgentGoal = goal.id === "goal-ai-agent";
    setTasks((current) => current.some((task) => task.id === taskId) ? current : [
      ...current,
      {
        id: taskId,
        title: isAgentGoal ? "AI Agent 最小闭环：定义问题与验收" : `从「${goal.title}」拆一步`,
        subtitle: isAgentGoal ? "写出一个 Agent 要解决的问题，并定义一次可观察的成功结果" : "先完成一个 15 分钟可验证的小动作",
        time: isAgentGoal ? "今天" : "明天",
        duration: isAgentGoal ? "45 min" : "15 min",
        xp: isAgentGoal ? 20 : 5,
        coin: isAgentGoal ? 8 : 2,
        status: "upcoming",
        kind: "focus",
      },
    ]);
    notify(`已把「${goal.title}」拆成一个明天可执行的行动`);
  }

  if (authMode === "loading") {
    return <div className="auth-loading">正在载入…</div>;
  }

  if (authMode === "login") {
    return <AuthScreen busy={authBusy} error={authError} onSubmit={submitAuth} />;
  }

  if (isMobileExperience) {
    return <MobileAppShell
      activeTab={activeTab}
      onNavigate={(tab) => setActiveTab(tab)}
      tasks={tasks}
      logs={logs}
      doneCount={doneCount}
      earnedCoins={earnedCoins}
      input={input}
      setInput={setInput}
      onSubmit={submitLog}
      onToggleTask={toggleTask}
      onSplitGoal={splitGoal}
      assistantReply={assistantReply}
      isAgentBusy={isAgentBusy}
      reviewEnabled={reviewEnabled}
      onToggleReview={toggleReviewSchedule}
      onStartReview={startEveningReview}
      isFocusRunning={isFocusRunning}
      onToggleFocus={toggleFocusSession}
      toast={toast}
    />;
  }

  return (
    <main className={`app-shell ${activeTab === "今日" ? "home-shell" : ""}`}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={16} strokeWidth={2.4} /></div>
          <div>
            <div className="brand-name">成长回路</div>
            <div className="brand-subtitle">GROWTH LOOP</div>
          </div>
        </div>

        <div className="sidebar-label">工作台</div>
        <nav className="side-nav">
          {tabs.map(({ label, icon: Icon }) => (
            <button key={label} className={`side-nav-item ${activeTab === label ? "active" : ""}`} onClick={() => setActiveTab(label)}>
              <Icon size={18} />
              <span>{label}</span>
              {label === "今日" && <span className="nav-dot" aria-label="有今日任务" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-label sidebar-label-spaced">本周状态</div>
        <div className="mini-streak">
          <div className="mini-streak-icon"><Flame size={17} /></div>
          <div>
            <strong>{demoSeed.user.streak} 天</strong>
            <span>连续有效行动</span>
          </div>
          <ChevronRight size={15} className="muted-icon" />
        </div>

        <div className="sidebar-bottom">
          <button className="help-link" onClick={() => notify("小贴士：把下一步缩小到 10 分钟，先留下事实，晚报时再补充结果。")}><CircleHelp size={16} /> 使用小贴士</button>
          <div className="profile-chip">
            <div className="avatar">{demoSeed.user.displayName.slice(0, 1)}</div>
            <div className="profile-meta"><strong>{demoSeed.user.displayName}</strong><span>Lv. {String(demoSeed.user.level).padStart(2, "0")} · {demoSeed.user.role}</span></div>
            {authMode === "ready" && <button className="profile-logout" onClick={logout} aria-label="退出登录" title="退出登录"><LogOut size={15} /></button>}
          </div>
        </div>
      </aside>

      <section className="main-column">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark"><Sparkles size={15} /></div><span>成长回路</span></div>
          <div className="date-stamp">{demoSeed.user.dateLabel} <span>·</span> {demoSeed.user.weekdayLabel}</div>
          <div className="topbar-actions"><span className="ai-online-pill"><span /> AI 在线</span><button className="icon-button" aria-label="打开消息" onClick={() => notify(reviewEnabled ? "下一次 AI 晚间回顾：今天 21:30" : "晚间回顾目前已关闭") }><MessageCircle size={18} /></button><div className="avatar avatar-small">{demoSeed.user.displayName.slice(0, 1)}</div></div>
        </header>

        <div className="content-wrap">
          <section className="hero-row">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> {tabCopy[activeTab].eyebrow} <span className="eyebrow-muted">/ {tabCopy[activeTab].suffix}</span></div>
              <h1>{activeTab === "今日" ? greeting : tabCopy[activeTab].eyebrow}</h1>
              <p className="hero-copy">{tabCopy[activeTab].description}</p>
            </div>
            <div className="hero-actions"><button className="quiet-button" aria-pressed={isRemindersPaused} onClick={() => { setIsRemindersPaused((paused) => !paused); notify(isRemindersPaused ? "提醒已恢复" : "提醒已暂停，今天不会主动打扰你"); }}><Pause size={15} /> {isRemindersPaused ? "恢复提醒" : "暂停提醒"}</button><button className="primary-button" onClick={focusQuickLog}><Plus size={16} /> 快速记录</button></div>
          </section>

          {activeTab === "今日" ? (
            <TodayHome
              greeting={greeting}
              tasks={tasks}
              doneCount={doneCount}
              input={input}
              setInput={setInput}
              quickLogRef={quickLogRef}
              onSubmit={submitLog}
              onToggleTask={toggleTask}
              onOpenPlan={() => setActiveTab("计划")}
              assistantReply={assistantReply}
              isAgentBusy={isAgentBusy}
              reviewEnabled={reviewEnabled}
              onToggleReview={toggleReviewSchedule}
              onStartReview={startEveningReview}
              evening={evening}
              pomodoroVisible={showPomodoro}
              onTogglePomodoro={() => setShowPomodoro((visible) => !visible)}
              pomodoro={<PomodoroWidget mode={pomodoroMode} seconds={pomodoroSeconds} isRunning={isPomodoroRunning} onToggle={togglePomodoro} onReset={resetPomodoro} onModeChange={changePomodoroMode} />}
            />
          ) : activeTab === "计划" ? (
            <PlanPanel tasks={tasks} onToggleTask={toggleTask} onSplitGoal={splitGoal} onBackToToday={() => setActiveTab("今日")} />
          ) : activeTab === "记录" ? (
            <RecordsPanel logs={logs} input={input} setInput={setInput} inputRef={quickLogRef} onSubmit={submitLog} onGenerateQuiz={(log) => generateQuiz(log.text, log.topic, log.output, log.id, true)} onBackToToday={() => setActiveTab("今日")} />
          ) : (
            <GrowthPanel onBackToToday={() => setActiveTab("今日")} />
          )}
        </div>
        <div className="mobile-nav">{tabs.map(({ label, icon: Icon }) => <button key={label} className={activeTab === label ? "active" : ""} onClick={() => setActiveTab(label)} aria-current={activeTab === label ? "page" : undefined}><Icon size={18} /><span>{label}</span></button>)}</div>
      </section>

      <aside className="right-rail">
        <div className="rail-card level-card"><div className="level-orbit"><div className="level-number">{String(demoSeed.user.level).padStart(2, "0")}</div><div className="level-label">LV.</div></div><div><span className="card-kicker">CURRENT LEVEL</span><h3>{demoSeed.user.role}</h3><p>距离 Lv.{String(demoSeed.user.level + 1).padStart(2, "0")} 还差 <strong>84 XP</strong></p></div><div className="level-progress"><span style={{ width: "68%" }} /></div></div>
        <div className="rail-card next-card"><div className="card-kicker">NEXT BEST ACTION</div><h3>{isFocusRunning ? "专注正在进行" : "先做 10 分钟"}</h3><p>{isFocusRunning ? "不用想着完成整件事，只要继续这一小段。" : "把主任务拆成一个最容易开始的动作，今天的回路会从这里转起来。"}</p><button className={`focus-button ${isFocusRunning ? "running" : ""}`} onClick={toggleFocusSession}>{isFocusRunning ? <><Pause size={15} /> 暂停专注</> : <><Play size={15} fill="currentColor" /> 开始专注</>}</button></div>
        <div className="rail-card wallet-card"><div className="wallet-header"><div className="wallet-icon"><WalletCards size={17} /></div><span>成长积分</span><button className="icon-button subtle" aria-label="积分详情" onClick={() => notify(`当前余额 ${demoSeed.user.coinBalance + earnedCoins} COIN，完成行动可继续增加`)}><ChevronRight size={16} /></button></div><div className="wallet-balance">{demoSeed.user.coinBalance + earnedCoins}<span> COIN</span></div><div className="wallet-meta"><span>本周 +{earnedCoins + 42}</span><button className="text-button" onClick={() => notify("兑换入口会在绑定你的现实奖励后开放")}>去兑换 <ChevronRight size={14} /></button></div></div>
        <div className="rail-card quote-card"><div className="quote-mark">“</div><p>{demoSeed.quote}</p><span>— 今日回路</span></div>
      </aside>

      {activeQuiz && isQuizOverlayOpen && <div className="quiz-overlay" role="dialog" aria-modal="true" aria-label={`理解测验：${activeQuiz.topic}`}>
        <button className="quiz-overlay-backdrop" aria-label="关闭理解测验" onClick={closeQuizOverlay} />
        <div className="quiz-overlay-dialog">
          <div className="quiz-overlay-toolbar"><span>正在专注：理解测验</span><button className="quiz-close-button" onClick={closeQuizOverlay}><X size={15} /> 关闭</button></div>
          <LearningQuizCard quiz={activeQuiz} answers={quizAnswers} grade={quizGrade} busy={quizBusy} error={quizError} onAnswer={(id, value) => setQuizAnswers((answers) => ({ ...answers, [id]: value }))} onGrade={gradeQuiz} onReset={resetQuiz} />
        </div>
      </div>}

      {toast && <div className="toast" role="status" aria-live="polite"><span className="toast-status" /> {toast}</div>}
    </main>
  );
}

function formatTimer(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

type TodayHomeProps = {
  greeting: string;
  tasks: Task[];
  doneCount: number;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  quickLogRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: () => void;
  onToggleTask: (id: string) => void;
  onOpenPlan: () => void;
  assistantReply: string;
  isAgentBusy: boolean;
  reviewEnabled: boolean;
  onToggleReview: () => void;
  onStartReview: () => void;
  evening: EveningCardState;
  pomodoroVisible: boolean;
  onTogglePomodoro: () => void;
  pomodoro: React.ReactNode;
};

function TodayHome({ greeting, tasks, doneCount, input, setInput, quickLogRef, onSubmit, onToggleTask, onOpenPlan, assistantReply, isAgentBusy, reviewEnabled, onToggleReview, onStartReview, evening, pomodoroVisible, onTogglePomodoro, pomodoro }: TodayHomeProps) {
  const visibleTasks = tasks.slice(0, 4);
  return <div className="home-command-center">
    <section className="home-intro">
      <div>
        <div className="eyebrow"><span className="eyebrow-line" /> AI DAILY COMPANION <span className="eyebrow-muted">/ 今天只推进下一步</span></div>
        <h1>{greeting}</h1>
        <p className="home-intro-copy">随手记下今天发生的事，白天不打断节奏；晚上 AI 再把一天收束成经验。</p>
      </div>
      <div className="home-intro-stamp"><span className="home-stamp-dot" />{reviewEnabled ? "今晚 21:30 回顾" : "晚间回顾已关闭"}</div>
    </section>

    <section className="ai-dialog-card" aria-label="AI 今日对话入口">
      <div className="ai-dialog-head">
        <div className="ai-avatar"><Sparkles size={18} /></div>
         <div className="ai-dialog-copy"><span className="card-kicker">AI TODAY ENTRY</span><strong>随手告诉我刚刚发生了什么</strong><p>{assistantReply}</p></div>
        <span className={`ai-activity-state ${isAgentBusy ? "is-busy" : ""}`}><span />{isAgentBusy ? "整理中" : "在线"}</span>
      </div>
      <div className="ai-composer">
        <textarea ref={quickLogRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：今天看了 Agent 的工具调用，终于理解了它和普通聊天的区别……" rows={4} aria-label="今天发生了什么" />
        <div className="ai-composer-footer"><span>随手写就好，不用先整理格式 · {input.length}/480 · 晚间统一回顾</span><button className="ai-send-button" onClick={onSubmit} disabled={!input.trim() || isAgentBusy}><span>{isAgentBusy ? "AI 正在整理" : "保存记录"}</span><ArrowUpRight size={16} /></button></div>
      </div>
      <div className="ai-suggestion-row"><span>可以直接说：</span><button onClick={() => setInput("今天学了什么：")}>今天学了什么</button><button onClick={() => setInput("今天卡在哪里：")}>今天卡在哪里</button><button onClick={() => setInput("今晚回顾：")}>今晚回顾</button></div>
    </section>

    <section className="home-follow-up home-evening-report-hint"><div className="follow-up-icon"><BedDouble size={17} /></div><div><span className="eyebrow">EVENING REPORT · 21:30</span><strong>白天先记录，晚上再统一回答</strong><p>AI 会把今天的学习、运动、生活和休息合在一起，依次追问行动、理解与明天的一步。</p></div><span className="follow-up-count">晚报</span></section>

    <section className="home-agenda-grid">
      <div className="home-agenda-card">
        <div className="home-section-head"><div><span className="eyebrow">TODAY AGENDA</span><h2>今天要做的事</h2></div><span className="agenda-count">{doneCount}/{tasks.length} 完成</span></div>
        <div className="home-agenda-list">{visibleTasks.map((task) => <HomeAgendaRow key={task.id} task={task} onToggle={onToggleTask} />)}</div>
        <div className="home-agenda-footer"><button className="home-more-button" onClick={onOpenPlan}>查看完整计划 <ChevronRight size={15} /></button><button className="home-focus-link" onClick={onTogglePomodoro}><Timer size={14} />{pomodoroVisible ? "收起专注工具" : "需要节奏？打开 25 分钟"}</button></div>
        {pomodoroVisible && <div className="home-pomodoro-slot">{pomodoro}</div>}
      </div>

      <aside className="home-review-card"><div className="home-section-head"><div><span className="eyebrow">EVENING REVIEW</span><h2>每日收束</h2></div><BedDouble size={18} className="panel-icon" /></div>
        {evening.state === "ready" && evening.summary ? (
          <>
            <p className="evening-summary-preview">{evening.summary.length > 120 ? `${evening.summary.slice(0, 120)}…` : evening.summary}</p>
            <div className="review-time-row"><strong>今日晚报</strong><span>服务端已生成 · 三问待你回答</span></div>
          </>
        ) : (
          <p>{evening.state === "loading" ? "正在加载今日晚报…" : evening.state === "generating" ? "AI 正在把今天的记录收束成晚报…" : evening.state === "error" ? "今日晚报生成失败，可以稍后手动回顾。" : "AI 会在晚上把今天的记录收束成三问。白天记录，晚上回答。"}</p>
        )}
        {evening.state === "no-report" && <div className="review-time-row"><strong>21:30</strong><span>每天一次 · 轻提醒</span><button className={`review-toggle ${reviewEnabled ? "is-enabled" : ""}`} aria-pressed={reviewEnabled} onClick={onToggleReview}><span />{reviewEnabled ? "已开启" : "已关闭"}</button></div>}
        <button className="review-start-button" onClick={onStartReview}>现在开始回顾 <ArrowUpRight size={15} /></button></aside>
    </section>

    <div className="home-trust-line"><span><Sparkles size={13} /> AI 只在需要时出现</span><span>计划、成长和账本会在你需要时展开</span><button className="text-button" onClick={onOpenPlan}>打开计划地图 <ChevronRight size={14} /></button></div>
  </div>;
}

function HomeAgendaRow({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  return <article className={`home-agenda-row ${task.status === "done" ? "is-done" : task.status === "current" ? "is-current" : ""}`}>
    <div className="home-agenda-time"><strong>{task.time}</strong><span>{task.duration}</span></div>
    <div className={`home-agenda-kind kind-${task.kind}`}>{renderTaskKindIcon(task.kind, 15)}</div>
    <div className="home-agenda-copy"><div><strong>{task.title}</strong><span className={`home-kind-label kind-${task.kind}`}>{taskKindLabel(task.kind)}</span></div><p>{task.subtitle}</p></div>
    <button className={`home-agenda-check ${task.status === "done" ? "is-done" : ""}`} onClick={() => onToggle(task.id)} aria-label={`${task.status === "done" ? "撤销" : "完成"}：${task.title}`}>{task.status === "done" ? <Check size={14} strokeWidth={3} /> : <span />}</button>
  </article>;
}

function PomodoroWidget({ mode, seconds, isRunning, onToggle, onReset, onModeChange }: { mode: PomodoroMode; seconds: number; isRunning: boolean; onToggle: () => void; onReset: () => void; onModeChange: (mode: PomodoroMode) => void }) {
  const totalSeconds = mode === "focus" ? POMODORO_FOCUS_SECONDS : POMODORO_BREAK_SECONDS;
  const progress = Math.min(100, Math.round(((totalSeconds - seconds) / totalSeconds) * 100));
  return <section className={`pomodoro-widget ${mode === "break" ? "is-break" : ""}`} aria-label="可选番茄钟">
    <div className="pomodoro-icon">{mode === "focus" ? <Timer size={18} /> : <Coffee size={18} />}</div>
    <div className="pomodoro-copy"><div className="pomodoro-label"><span className="eyebrow">OPTIONAL POMODORO</span><span>可选，不打断计划</span></div><strong>{mode === "focus" ? "25 分钟专注" : "5 分钟恢复"}</strong><p>{mode === "focus" ? "只做当前行动的一小段，结束后再决定下一步。" : "离开屏幕、喝水或走动，让注意力重新充电。"}</p><div className="pomodoro-track"><span style={{ width: `${progress}%` }} /></div></div>
    <div className="pomodoro-clock"><strong>{formatTimer(seconds)}</strong><div className="pomodoro-controls"><button className="pomodoro-start" onClick={onToggle}>{isRunning ? "暂停" : "开始"}</button><button className="pomodoro-reset" onClick={onReset} aria-label="重置番茄钟"><RotateCcw size={13} /></button></div><div className="pomodoro-modes"><button className={mode === "focus" ? "active" : ""} aria-pressed={mode === "focus"} onClick={() => onModeChange("focus")}>专注</button><button className={mode === "break" ? "active" : ""} aria-pressed={mode === "break"} onClick={() => onModeChange("break")}>休息</button></div></div>
  </section>;
}

function taskKindLabel(kind: TaskKind) {
  return ({ focus: "专注", learn: "学习", exercise: "运动", life: "生活", rest: "休息" })[kind];
}

function renderTaskKindIcon(kind: TaskKind, size: number) {
  if (kind === "learn") return <BookOpen size={size} />;
  if (kind === "exercise") return <Dumbbell size={size} />;
  if (kind === "life") return <HomeIcon size={size} />;
  if (kind === "rest") return <BedDouble size={size} />;
  return <Target size={size} />;
}

function WorkspaceHeader({ eyebrow, title, description, onBackToToday }: { eyebrow: string; title: string; description: string; onBackToToday: () => void }) {
  return <div className="workspace-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div><button className="quiet-button" onClick={onBackToToday}><LayoutDashboard size={15} /> 回到今日</button></div>;
}

function PlanPanel({ tasks, onToggleTask, onSplitGoal, onBackToToday }: { tasks: Task[]; onToggleTask: (id: string) => void; onSplitGoal: (goal: Goal) => void; onBackToToday: () => void }) {
  const completed = tasks.filter((task) => task.status === "done").length;
  return <div className="workspace-page">
    <WorkspaceHeader eyebrow="PLAN BOARD" title="计划地图" description="先看目标，再看今天要落地的那一步。" onBackToToday={onBackToToday} />
    <div className="goal-grid">
      {demoSeed.goals.map((goal) => <article className="goal-card" key={goal.id}><div className="goal-card-top"><span className="goal-status">{goal.status}</span><span className="goal-horizon">{goal.horizon}</span></div><h3>{goal.title}</h3><p>{goal.description}</p><div className="goal-progress-row"><span>当前进度</span><strong>{goal.progress}%</strong></div><div className="goal-progress"><span style={{ width: `${goal.progress}%` }} /></div><div className="goal-footer"><span><Target size={13} /> {goal.id === "goal-product" ? "产品构建" : "技能成长"}</span><button className="text-button" onClick={() => onSplitGoal(goal)}>拆成行动 <ChevronRight size={14} /></button></div></article>)}
    </div>
     <section className="panel agent-roadmap-panel"><div className="panel-heading"><div><span className="eyebrow">AI AGENT TRACK</span><h2>学习 Agent，并开发自己的 Agent</h2></div><Sparkles size={18} className="panel-icon" /></div><p className="panel-desc">这条路线把“学 AI”收敛成一个可以持续交付的小项目：先理解组成，再做最小闭环，最后用测验和真实任务验证。</p><div className="roadmap-stages"><div className="roadmap-stage"><span className="roadmap-number">01</span><div><strong>理解 Agent</strong><p>LLM、Prompt、工具调用、状态/记忆和评估。</p></div></div><div className="roadmap-stage"><span className="roadmap-number">02</span><div><strong>做最小闭环</strong><p>信息 → 决策 → 工具 → 结果，先解决一个具体问题。</p></div></div><div className="roadmap-stage"><span className="roadmap-number">03</span><div><strong>验证与迭代</strong><p>留下可验证证据，用理解题、日志和用户反馈校准。</p></div></div></div><div className="roadmap-action"><div><span>今日建议 · 45 分钟</span><strong>定义你的 Agent 问题与验收标准</strong></div><button className="primary-button" onClick={() => onSplitGoal({ id: "goal-ai-agent", title: "学习 Agent 并开发自己的 Agent", description: "从一个具体问题做出最小可运行闭环", progress: 0, horizon: "今日路线", status: "进行中" })}>加入今日计划 <ArrowUpRight size={15} /></button></div></section>
    <div className="plan-layout">
      <section className="panel schedule-panel"><div className="panel-heading"><div><span className="eyebrow">TODAY TIMELINE</span><h2>今日时间轴</h2></div><span className="count-badge">{completed}/{tasks.length} 已完成</span></div><p className="panel-desc">把任务放进现实的时间里，完成感会更具体。</p><div className="schedule-list">{tasks.map((task) => <div className={`schedule-card ${task.status === "done" ? "is-done" : task.status === "current" ? "is-current" : ""}`} key={task.id}><div className="schedule-time"><strong>{task.time}</strong><span>{task.duration}</span></div><div className={`schedule-icon kind-${task.kind}`}>{renderTaskKindIcon(task.kind, 16)}</div><div className="schedule-copy"><div className="task-title-line"><h3>{task.title}</h3><span className={`schedule-kind kind-${task.kind}`}>{taskKindLabel(task.kind)}</span>{task.status === "current" && <span className="now-pill">NOW</span>}</div><p>{task.subtitle}</p><span className="schedule-reward">+{task.xp} XP · +{task.coin} coin</span></div><button className={`task-check ${task.status === "done" ? "checked" : ""}`} onClick={() => onToggleTask(task.id)} aria-label={`${task.status === "done" ? "撤销" : "完成"}：${task.title}`}>{task.status === "done" ? <Check size={15} strokeWidth={3} /> : <span />}</button></div>)}</div></section>
     <aside className="panel weekly-plan-panel"><div className="panel-heading"><div><span className="eyebrow">WEEKLY INTENT</span><h2>本周只做三件事</h2></div><ListChecks size={18} className="panel-icon" /></div><div className="intent-list"><div className="intent-item"><span className="intent-number">01</span><div><strong>完成首页第一版</strong><p>今天推进 45 分钟，周三前可演示。</p></div></div><div className="intent-item"><span className="intent-number">02</span><div><strong>英语听力保持表达</strong><p>不追求时长，每次留下 3 个表达。</p></div></div><div className="intent-item"><span className="intent-number">03</span><div><strong>周日做一次复盘</strong><p>比较行动证据，不比较情绪。</p></div></div></div><div className="plan-note"><Sparkles size={15} /><span>建议：今天完成主任务后，不再新增新的计划。</span></div></aside>
    </div>
  </div>;
}

function evidenceLabel(evidence: "输入" | "输入 + 输出" | "应用") {
  if (evidence === "应用") return "实际应用";
  if (evidence === "输入 + 输出") return "理解回应";
  return "行动记录";
}

function RecordsPanel({ logs, input, setInput, inputRef, onSubmit, onGenerateQuiz, onBackToToday }: { logs: LogEntry[]; input: string; setInput: React.Dispatch<React.SetStateAction<string>>; inputRef: React.RefObject<HTMLTextAreaElement | null>; onSubmit: () => void; onGenerateQuiz: (log: LogEntry) => void; onBackToToday: () => void }) {
  const totalXp = demoSeed.learningLogs.reduce((total, log) => total + log.xp, 0) + logs.reduce((total, log) => total + log.xp, 0);
  return <div className="workspace-page">
    <WorkspaceHeader eyebrow="EVIDENCE LOG" title="成长记录" description="把今天发生的事放在同一条可回看的时间线上，晚报时再统一回顾。" onBackToToday={onBackToToday} />
    <div className="records-layout">
      <section className="panel records-main"><div className="panel-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>最近发生了什么</h2></div><span className="count-badge">{demoSeed.learningLogs.length + logs.length} 条记录</span></div><div className="record-list">
        {logs.map((log) => <article className="record-item record-item-live" key={log.id}><div className="record-date"><strong>{log.createdAt}</strong><span>新增</span></div><div className="record-marker"><span /></div><div className="record-body"><div className="record-topline"><h3>{log.topic}</h3><span className="record-reward">+{log.xp} XP · +{log.coin} coin</span></div><p>{log.text}</p><div className="record-tags">{log.kind && <span className={`record-kind-tag kind-${log.kind}`}>{taskKindLabel(log.kind)}</span>}<span>{log.intent === "plan_today" ? "计划" : log.intent === "review" ? "复盘" : log.output ? "已整理" : "已记录"}</span><span>{log.output ? `AI 摘要：${log.output}` : log.mode === "pending" ? "AI 正在整理" : "等待晚报回顾"}</span>{typeof log.quizScore === "number" && <span>理解 {log.quizScore} 分</span>}</div>{log.output && <button className="record-quiz-button" onClick={() => onGenerateQuiz(log)}>再测一次 <ChevronRight size={13} /></button>}</div></article>)}
        {demoSeed.learningLogs.map((log) => <article className="record-item" key={log.id}><div className="record-date"><strong>{log.occurredAt.split(" ")[0]}</strong><span>{log.occurredAt.split(" ").slice(1).join(" ")}</span></div><div className="record-marker"><span /></div><div className="record-body"><div className="record-topline"><h3>{log.topic}</h3><span className="record-reward">+{log.xp} XP · +{log.coin} coin</span></div><p>{log.summary}</p><div className="record-tags"><span>{evidenceLabel(log.evidence)}</span><span>{log.duration}</span></div></div></article>)}
      </div></section>
      <aside className="records-side"><section className="panel quick-record-panel"><div className="panel-heading"><div><span className="eyebrow">QUICK NOTE</span><h2>随手记一笔</h2></div><BookOpen size={18} className="panel-icon" /></div><p className="panel-desc">记录任何今天发生的事，不用先分类或整理。晚报时 AI 会把几条记录合在一起统一提问。</p><div className="input-label">今天发生了什么？ <span>学习、运动、生活、休息都可以</span></div><div className="log-input-wrap"><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：读了行动设计的一节内容，下午走了 20 分钟……" rows={6} /></div><div className="input-actions"><span>{input.length}/480</span><button className="send-button" onClick={onSubmit} disabled={!input.trim()}>保存记录 <ArrowUpRight size={15} /></button></div><div className="record-total"><span>本组已获得</span><strong>{totalXp} XP</strong></div></section><section className="panel ledger-panel"><div className="panel-heading"><div><span className="eyebrow">LEDGER</span><h2>最近结算</h2></div><ReceiptText size={18} className="panel-icon" /></div><div className="ledger-list">{demoSeed.ledger.map((entry) => <div className="ledger-item" key={entry.id}><div className={`ledger-icon ${entry.account === "XP" ? "ledger-xp" : "ledger-coin"}`}>{entry.account === "XP" ? <Sparkles size={14} /> : <WalletCards size={14} />}</div><div><strong>{entry.reason}</strong><span>{entry.occurredAt}</span></div><em>+{entry.amount} {entry.account}</em></div>)}</div></section></aside>
    </div>
  </div>;
}

type LearningQuizCardProps = {
  quiz: QuizSession;
  answers: Record<string, string>;
  grade: QuizGrade | null;
  busy: boolean;
  error: string;
  onAnswer: (id: string, value: string) => void;
  onGrade: () => void;
  onReset: () => void;
};

function LearningQuizCard({ quiz, answers, grade, busy, error, onAnswer, onGrade, onReset }: LearningQuizCardProps) {
  const answeredCount = quiz.questions.filter((question) => answers[question.id]?.trim()).length;
  return <section className="quiz-panel"><div className="quiz-panel-header"><div><span className="eyebrow">RECALL CHECK · {quiz.mode === "llm" ? "LLM 出题" : "演示出题"}</span><h2>理解「{quiz.topic}」</h2><p>先别查资料，直接回答，并尽量给一个例子。LLM 会按概念、迁移和表达结构评分。</p></div><div className="quiz-status"><Brain size={18} /><span>{answeredCount}/{quiz.questions.length} 已回答</span></div></div><div className="quiz-source"><span>学习底稿</span><p>{quiz.sourceSummary}</p></div><div className="quiz-question-list">{quiz.questions.map((question, index) => <div className="quiz-question" key={question.id}><div className="quiz-question-top"><span>0{index + 1}</span><strong>{question.prompt}</strong></div><p className="quiz-hint">提示：{question.hint}</p><textarea value={answers[question.id] || ""} onChange={(event) => onAnswer(question.id, event.target.value)} placeholder="写下你的理解，至少给一个具体例子……" rows={3} disabled={Boolean(grade)} /></div>)}</div>{error && <p className="quiz-error" role="alert">{error}</p>}{grade ? <div className="quiz-result"><div className="quiz-result-score"><strong>{grade.score}</strong><span>分</span><em>{grade.level}</em></div><div className="quiz-result-copy"><p>{grade.summary}</p><span>{grade.nextHabit}</span></div></div> : <button className="primary-button quiz-submit" onClick={onGrade} disabled={busy || answeredCount === 0}>{busy ? "LLM 正在评分…" : `提交答案并评分 · ${answeredCount}/${quiz.questions.length}` } <ArrowUpRight size={15} /></button>}{grade && <div className="quiz-feedback-list">{grade.feedback.map((item) => <div className="quiz-feedback" key={item.questionId}><div><strong>第 {quiz.questions.findIndex((question) => question.id === item.questionId) + 1} 题 · {item.score} 分</strong><p>{item.comment}</p></div><span>{item.modelAnswer}</span></div>)}</div>}{grade && <div className="quiz-graded-by"><span>{grade.gradedBy === "llm" ? "LLM 已完成逐题评分" : `LLM 暂时不可用，已使用${grade.provider === "rules" ? "规则" : grade.provider}估分`}</span><button className="quiet-button" onClick={onReset}><RotateCcw size={14} /> 再做一次</button></div>}</section>;
}

function GrowthPanel({ onBackToToday }: { onBackToToday: () => void }) {
  const totalMinutes = demoSeed.weeklyBars.reduce((total, bar) => total + Number.parseInt(bar.label, 10), 0);
  const applicationCount = demoSeed.learningLogs.filter((log) => log.evidence === "应用").length;
  const understandingCount = demoSeed.learningLogs.filter((log) => log.evidence === "输入 + 输出").length;
  return <div className="workspace-page">
    <WorkspaceHeader eyebrow="GROWTH DASHBOARD" title="成长仪表盘" description="不把自己压缩成一个分数，只看节奏、证据和下一轮实验。" onBackToToday={onBackToToday} />
    <div className="growth-metrics"><article className="metric-card metric-coral"><span className="metric-label">有效行动日</span><strong>{demoSeed.user.streak}<small> 天</small></strong><p>连续节奏，比昨天多 1 天</p></article><article className="metric-card metric-navy"><span className="metric-label">本周投入</span><strong>{Math.floor(totalMinutes / 60)}<small>h</small> {totalMinutes % 60}<small>m</small></strong><p>7 天累计专注时长</p></article><article className="metric-card metric-sage"><span className="metric-label">掌握证据</span><strong>{applicationCount + understandingCount}<small> 条</small></strong><p>记录之后形成了理解</p></article><article className="metric-card metric-paper"><span className="metric-label">成长等级</span><strong>Lv.{String(demoSeed.user.level).padStart(2, "0")}</strong><p>{demoSeed.user.role} · 距离升级 84 XP</p></article></div>
    <div className="growth-layout"><section className="panel growth-chart-panel"><div className="panel-heading"><div><span className="eyebrow">RHYTHM TREND</span><h2>近 7 天投入节奏</h2></div><span className="trend-chip"><ArrowUpRight size={13} /> +18% vs 上周</span></div><div className="growth-chart">{weeklyBars.map((bar, index) => <div className="growth-bar-column" key={bar.day}><span className="growth-bar-value">{bar.label}</span><div className="growth-bar-track"><span className={index === 3 ? "highlight" : ""} style={{ height: `${bar.value}%` }} /></div><span>{bar.day}</span></div>)}</div><div className="chart-caption"><span><i className="legend-dot" /> 有效专注时长</span><strong>基线：5h 34m</strong></div></section><section className="panel evidence-panel"><div className="panel-heading"><div><span className="eyebrow">EVIDENCE MIX</span><h2>进步由什么组成</h2></div><BarChart3 size={18} className="panel-icon" /></div><div className="evidence-row"><div className="evidence-label"><span>行动记录</span><strong>1 条</strong></div><div className="evidence-track"><span style={{ width: "34%" }} /></div></div><div className="evidence-row"><div className="evidence-label"><span>理解回应</span><strong>{understandingCount} 条</strong></div><div className="evidence-track"><span className="evidence-green" style={{ width: "67%" }} /></div></div><div className="evidence-row"><div className="evidence-label"><span>实际应用</span><strong>{applicationCount} 条</strong></div><div className="evidence-track"><span className="evidence-gold" style={{ width: "42%" }} /></div><p className="evidence-note"><Sparkles size={13} /> 下一步：给英语练习补一次延迟回忆。</p></div></section></div>
    <section className="panel goal-progress-panel"><div className="panel-heading"><div><span className="eyebrow">GOAL PROGRESS</span><h2>目标的真实进度</h2></div><span className="count-badge">只比较自己的基线</span></div><div className="growth-goal-list">{demoSeed.goals.map((goal) => <div className="growth-goal" key={goal.id}><div className="growth-goal-heading"><div><strong>{goal.title}</strong><span>{goal.description}</span></div><em>{goal.progress}%</em></div><div className="goal-progress"><span style={{ width: `${goal.progress}%` }} /></div><div className="growth-goal-footer"><span>{goal.horizon}</span><span>{goal.status}</span></div></div>)}</div></section>
  </div>;
}

function AuthScreen({ busy, error, onSubmit }: {
  busy: boolean;
  error: string;
  onSubmit: (credentials: { email: string; password: string; displayName?: string }, isRegister: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand"><div className="brand-mark"><Sparkles size={17} /></div><strong>成长回路</strong></div>
        <h1>{mode === "login" ? "欢迎回来" : "创建账号"}</h1>
        <p className="auth-sub">{mode === "login"
          ? "登录后，你的记录、任务和成长账本都会保存在自己的空间里。"
          : "注册一个邮箱账号，保存属于你的成长回路。密码至少 8 位。"}</p>
        {mode === "register" && (
          <div className="auth-field">
            <label>昵称（可选）</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="怎么称呼你" />
          </div>
        )}
        <div className="auth-field">
          <label>邮箱</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
        </div>
        <div className="auth-field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? "至少 8 位" : "你的密码"} autoComplete={mode === "register" ? "new-password" : "current-password"} />
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-submit" disabled={busy || !email.trim() || !password} onClick={() => onSubmit({ email, password, displayName }, mode === "register")}>
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并开始"}
        </button>
        <button className="auth-switch" disabled={busy} onClick={() => setMode((m) => (m === "login" ? "register" : "login"))}>
          {mode === "login" ? "没有账号？创建一个" : "已有账号？去登录"}
        </button>
        <p className="auth-hint">MVP 阶段使用邮箱/密码登录。微信登录会在闭环验证通过后接入。</p>
      </div>
    </div>
  );
}
