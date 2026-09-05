"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  Trash2,
  Trophy,
  Undo2,
  WalletCards,
  X,
} from "lucide-react";
import { demoSeed, initialTasks, todayShanghaiDateLabel, todayShanghaiWeekdayLabel, type Goal, type Task, type TaskKind } from "@/lib/demo-data";
import type { QuizGrade, QuizQuestion } from "@/lib/agent/quiz";
import ChatPanel from "./chat-panel";
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

/** 计划页真实目标：API 返回的派生 taskCount/doneCount 与业务日期附加在 demo Goal 形状上 */
type PlanGoal = Goal & { taskCount?: number; doneCount?: number; startDate?: string; endDate?: string; actionCount?: number; actionDoneCount?: number; actions?: ActionRow[] };

/** 行动阶段行（与后端 ActionView 同构；Smart Planner Step 2c） */
type ActionRow = {
  id: string;
  goalId: string;
  title: string;
  description: string | null;
  estimatedMinutes: number;
  priority: number;
  status: "pending" | "planned" | "completed";
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  dependsOnTitles: string[];
  /** 累计实际投入（execution_records 汇总；Step 5b 展示「投入 x/预计 y」） */
  spentMinutes?: number;
};

/** 行动阶段按 id 去重合并（新生成结果并入已有列表） */
function mergeActionRows(existing: ActionRow[], incoming: ActionRow[]): ActionRow[] {
  const seen = new Set(existing.map((a) => a.id));
  return [...existing, ...incoming.filter((a) => !seen.has(a.id))];
}

/** 分钟数 → 可读时长（阶段总投入展示用） */
function formatActionMinutes(min: number): string {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `约 ${h}小时${m}分` : `约 ${h}小时`;
  }
  return `${min} 分钟`;
}

// ===================== Smart Planner Step 3 前端类型（镜像后端） =====================

type AvailabilityRow = { weekday: number; startTime: string; endTime: string; type: "learn" | "work" | "exercise" | "life" | "rest"; title: string };

/** 今日时间轴项（与后端 TimelineItem 同构；Step 4「时间语义层」，唯一执行数据源） */
type TimelineRow = {
  key: string;
  type: "action" | "manual" | "fixed";
  title: string;
  startTime: string;
  endTime: string;
  status: "planned" | "completed";
  scheduleId?: string;
  actionId?: string | null;
  goalId?: string | null;
  source?: "action" | "manual";
  /** 已完成项的执行记录（Step 5b 行内编辑实际分钟） */
  executionId?: string;
  actualMinutes?: number;
};

type PlanFeasibility = {
  totalMinutes: number;
  remainingDays: number;
  requiredPerDay: number;
  shortTermPerDay: number;
  longTermPerDay: number;
  verdict: "on-track" | "tight" | "risk";
  weeksNeeded: number | null;
  hasDeadline: boolean;
  message: string;
};

type PlanItemDraft = { actionId: string; title: string; date: string; startTime: string; endTime: string };

type PlanPreviewData = {
  blocked?: "no-availability" | "no-pending";
  message?: string;
  feasibility: PlanFeasibility | null;
  items: PlanItemDraft[];
  remainingMinutes?: Record<string, number>;
  source: "llm" | "rules";
  pendingCount?: number;
};

/** Planner 弹层会话（验收 C：关闭即清，不缓存成已安排） */
type PlanSession = { goal: PlanGoal; step: "loading" | "preview" | "blocked" | "ask-replan" | "error"; data: PlanPreviewData | null; error?: string };

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** YYYY-MM-DD → "9月7日 周一"（UTC 解析防时区偏移） */
function formatPlanDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEKDAY_LABELS[wd]}`;
}

function hasPlannedAction(goal: PlanGoal): boolean {
  return (goal.actions ?? []).some((a) => a.status === "planned");
}

/** 用户反馈行（与后端 DbReflection camelCase 同构；Step 6c 手动入口与历史只读） */
type ReflectionRow = {
  id: string;
  goalId: string | null;
  actionId: string | null;
  source: "planner" | "weekly" | "manual";
  content: string;
  rating: "good" | "bad" | null;
  createdAt: string;
};

/** 反馈创建时间（ISO）→ 上海日期（YYYY-MM-DD） */
function formatReflectionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** API reflection（snake_case 原始行）→ 前端 ReflectionRow */
function mapApiReflection(r: Record<string, unknown>): ReflectionRow {
  return {
    id: String(r.id),
    goalId: r.goal_id ? String(r.goal_id) : null,
    actionId: r.action_id ? String(r.action_id) : null,
    source: (r.source as ReflectionRow["source"]) ?? "manual",
    content: String(r.content ?? ""),
    rating: r.rating === "good" || r.rating === "bad" ? r.rating : null,
    createdAt: String(r.created_at ?? ""),
  };
}

/** 目标创建/编辑入参（与 /api/goals 契约对齐） */
type GoalInput = { title: string; description?: string; startDate?: string; endDate?: string; horizon?: string };

/** 晚报卡片单状态驱动（杜绝 loading+error 等非法组合） */
type EveningState = "loading" | "no-report" | "generating" | "ready" | "error";

type EveningCardState = {
  state: EveningState;
  summary?: string;
  /** 结构化晚报内容（Phase 2 起：summary/achievement/problem/suggestion/evaluation） */
  content?: Record<string, unknown> | null;
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
  const [recordMinutes, setRecordMinutes] = useState("");
  const [recordOutput, setRecordOutput] = useState("");
  const logs = useSyncExternalStore(subscribeToLogs, readStoredLogs, () => EMPTY_LOGS);
  const [isFocusRunning, setIsFocusRunning] = useState(false);
  const [pomodoroMode, setPomodoroMode] = useState<PomodoroMode>("focus");
  const [pomodoroSeconds, setPomodoroSeconds] = useState(POMODORO_FOCUS_SECONDS);
  const [isPomodoroRunning, setIsPomodoroRunning] = useState(false);
  const [showPomodoro, setShowPomodoro] = useState(false);
  const [isRemindersPaused, setIsRemindersPaused] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [toast, setToast] = useState("");
  const [eveningTime, setEveningTime] = useState("21:30");
  const [assistantReply, setAssistantReply] = useState(`把今天发生的事直接写给我就好。白天我先帮你收好记录，晚上 ${eveningTime} 再把今天几条记录合在一起，统一问你最重要的一步、真正理解的地方和明天的行动。` );
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
  /** 聊天面板开关（消息图标入口） */
  const [chatOpen, setChatOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [evening, setEvening] = useState<EveningCardState>({ state: "loading" });
  const [dashboardStats, setDashboardStats] = useState<{ profile?: { streak?: number; nickname?: string; level?: number; xp?: number; nextLevelXp?: number; coin?: number }; todayTasks?: Task[]; todayRecords?: number } | null>(null);
  const [growthStats, setGrowthStats] = useState<{ weeklyMinutes?: Array<{ day: string; value: number; label: string }>; evidence?: { input: number; understanding: number; application: number }; activeDays?: number } | null>(null);
  const [focusGoals, setFocusGoals] = useState<Goal[] | null>(null);
  // 计划页真实目标：初始用 demoSeed 回退（原型模式），ready 后由 GET /api/goals 覆盖
  const [goals, setGoals] = useState<PlanGoal[]>(demoSeed.goals);
  // 拆解/行动路线：进行中的目标 id（按钮 loading）+ 最近一次生成结果（undo 用 state 保存，不依赖 toast）
  const [decomposingGoalId, setDecomposingGoalId] = useState<string | null>(null);
  const [generatingGoalId, setGeneratingGoalId] = useState<string | null>(null);
  /** kind: task = 拆今日任务产物；action = 制定行动路线产物（5 分钟 undo 窗口） */
  const [lastGenerate, setLastGenerate] = useState<{ kind: "task" | "action"; ids: string[]; expireAt: number } | null>(null);
  // Step3：每周可用时间 + Planner 弹层会话
  const [availRows, setAvailRows] = useState<AvailabilityRow[]>([]);
  const [planSession, setPlanSession] = useState<PlanSession | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  // Step4：今日时间轴（GET /api/schedules/today；null=未加载/非 ready → 渲染层回退旧任务）
  const [timeline, setTimeline] = useState<TimelineRow[] | null>(null);
  // Step6c：Goal 卡反馈历史（goalId → 倒序列表；仅 ready 拉取）
  const [reflectionsByGoal, setReflectionsByGoal] = useState<Record<string, ReflectionRow[]>>({});
  // 删除账号确认弹层：expectedEmail 来自 /api/auth/me，inputEmail 由用户输入比对
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteExpectedEmail, setDeleteExpectedEmail] = useState("");
  const [deleteInputEmail, setDeleteInputEmail] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

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

  // 晚报懒触发：ready 模式下查今日晚报；已过 eveningTime 且未生成则自动生成（服务端幂等）
  useEffect(() => {
    if (authMode !== "ready" || !authToken) return;
    let cancelled = false;
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    (async () => {
      try {
        const res = await fetch("/api/evening-report/today", { headers });
        if (!res.ok) throw new Error("evening unavailable");
        const { report } = (await res.json()) as { report?: { summary: string; content?: Record<string, unknown> | null } | null };
        if (cancelled) return;
        if (report) {
          setEvening({ state: "ready", summary: report.summary, content: report.content ?? null });
          return;
        }
        const now = new Date();
        const [eh, em] = eveningTime.split(":").map(Number);
        const reached = now.getHours() > eh || (now.getHours() === eh && now.getMinutes() >= em);
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
        const data = (await gen.json()) as { report?: { summary?: string; content?: Record<string, unknown> | null } };
        if (!cancelled) {
          setEvening({ state: "ready", summary: data.report?.summary ?? "今日晚报已生成", content: data.report?.content ?? null });
        }
      } catch {
        if (!cancelled) setEvening({ state: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authMode, authToken, eveningTime]);

  // 聚合数据（真实化）：ready 后拉取 dashboard / growth / goals，供侧边栏/成长页/计划页使用
  useEffect(() => {
    if (authMode !== "ready" || !authToken) return;
    let cancelled = false;
    const headers = { Authorization: `Bearer ${authToken}` };
    (async () => {
      try {
        const [d, g, s, gl, av] = await Promise.all([
          fetch("/api/dashboard", { headers }).then((r) => r.json()),
          fetch("/api/growth/stats", { headers }).then((r) => r.json()),
          fetch("/api/goals/summary", { headers }).then((r) => r.json()),
          fetch("/api/goals", { headers }).then((r) => r.json()),
          fetch("/api/availability", { headers }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (d?.profile) setDashboardStats(d);
        if (g?.weeklyMinutes) setGrowthStats(g);
        if (s?.focusGoals) setFocusGoals(s.focusGoals);
        if (Array.isArray(gl?.goals)) setGoals(gl.goals);
        if (Array.isArray(av?.items)) setAvailRows(av.items as AvailabilityRow[]);
      } catch {
        // 聚合失败不阻塞页面：各面板保持默认/空态
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authMode, authToken]);

  // 晚报时间配置：ready 后从状态接口读取（REPORT_TIME），懒触发与提醒定时器统一用它
  useEffect(() => {
    if (authMode !== "ready") return;
    let cancelled = false;
    fetch("/api/agent")
      .then((r) => r.json())
      .then((s: { eveningReportTime?: string }) => {
        if (!cancelled && s?.eveningReportTime) setEveningTime(s.eveningReportTime);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authMode]);

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
      const [eh, em] = eveningTime.split(":").map(Number);
      nextReview.setHours(eh, em, 0, 0);
      if (nextReview.getTime() <= now.getTime()) nextReview.setDate(nextReview.getDate() + 1);
      reviewTimer.current = window.setTimeout(() => {
        setInput((value) => value || "今晚回顾");
        setAssistantReply("到晚间了。我会根据今天的记录统一追问三件事：最重要的行动、真正理解或应用的地方、明天的一步。先从你最想保留的一件事开始。" );
        setActiveTab("今日");
        notify(`${eveningTime} 晚间回顾已准备好`);
        scheduleNextReview();
      }, Math.max(1_000, nextReview.getTime() - now.getTime()));
    };
    scheduleNextReview();
    return () => {
      if (reviewTimer.current) window.clearTimeout(reviewTimer.current);
    };
  }, [reviewEnabled, eveningTime]);

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

  // 打开删除账号确认弹层：先 GET /api/auth/me 取权威邮箱做防误触比对（方案乙）
  async function openDeleteAccount() {
    setDeleteError("");
    setDeleteInputEmail("");
    setDeleteExpectedEmail("");
    setDeleteOpen(true);
    try {
      const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${authToken}` } });
      const payload = (await res.json()) as { profile?: { email?: string }; error?: string };
      if (!res.ok || !payload.profile?.email) {
        setDeleteError(payload.error || "无法获取账号信息，请重新登录后再试");
        return;
      }
      setDeleteExpectedEmail(payload.profile.email);
    } catch {
      setDeleteError("无法获取账号信息，请重新登录后再试");
    }
  }

  // 确认删除：前端仅做 UX 防误触，真正身份校验在后端 authenticate
  async function confirmDeleteAccount() {
    if (deleteInputEmail !== deleteExpectedEmail) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch("/api/auth/delete", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const payload = (await res.json()) as { deleted?: boolean; error?: string };
      if (!res.ok || !payload.deleted) {
        setDeleteError(payload.error || "删除失败，请重试");
        return;
      }
      // 删除成功：复用 logout 清理本地 token 并回到登录页
      logout();
    } catch {
      setDeleteError("网络异常，请稍后重试");
    } finally {
      setDeleteBusy(false);
    }
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

  // 等级/升级进度：权威来源 xp_balance（ledger 单向派生），不落库重复维护
  const currentLevel = Math.floor(demoSeed.user.xpBalance / 100) + 1;
  const nextLevelXp = 100 - (demoSeed.user.xpBalance % 100);
  const levelProgress = demoSeed.user.xpBalance % 100;
  const displayName = demoSeed.user.displayName || "朋友";

  const greeting = useMemo(() => {
    if (doneCount === tasks.length) return "今天的回路已经闭合";
    if (doneCount > 0) return "很好，今天已经开始转起来了";
    return `早上好，${displayName}`;
  }, [doneCount, tasks.length, displayName]);

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
    const minutesInput = recordMinutes ? Number(recordMinutes) : undefined;
    const outputInput = recordOutput.trim() || undefined;
    setRecordMinutes("");
    setRecordOutput("");
    setIsAgentBusy(true);
    setAssistantReply("已记下。白天先不用停下来答题，今晚的晚报会把今天的记录合在一起，再统一追问。" );
    notify("已保存，晚报时统一回顾");

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authMode === "ready" && authToken) headers.Authorization = `Bearer ${authToken}`;
      const response = await fetch("/api/agent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          message,
          conversationId: sessionIdRef.current,
          context: reviewContext,
          minutes: minutesInput,
          output: outputInput,
        }),
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
    notify(nextEnabled ? `已开启每日 ${eveningTime} 晚间回顾` : "已关闭晚间回顾提醒");
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

  function apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return headers;
  }

  /** API 目标 → 前端 PlanGoal（保留派生计数与业务日期） */
  function mapApiGoal(g: Record<string, unknown>): PlanGoal {
    return {
      id: String(g.id),
      title: String(g.title ?? ""),
      description: String(g.description ?? ""),
      progress: Number(g.progress ?? 0),
      horizon: String(g.horizon ?? ""),
      status: (g.status as Goal["status"]) ?? "进行中",
      taskCount: Number(g.taskCount ?? 0),
      doneCount: Number(g.doneCount ?? 0),
      startDate: g.start_date ? String(g.start_date) : undefined,
      endDate: g.end_date ? String(g.end_date) : undefined,
      actionCount: Number(g.actionCount ?? 0),
      actionDoneCount: Number(g.actionDoneCount ?? 0),
      actions: Array.isArray(g.actions) ? (g.actions as ActionRow[]) : [],
    };
  }

  function requireAuth() {
    if (authMode !== "ready") {
      notify("登录后即可创建目标");
      return false;
    }
    return true;
  }

  /** 今日时间轴加载（唯一 Schedule 来源 GET /api/schedules/today；失败保持 null → 渲染层回退旧任务） */
  const loadTodayTimeline = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch("/api/schedules/today", {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error("timeline unavailable");
      const data = (await res.json()) as { items?: TimelineRow[] };
      setTimeline(Array.isArray(data.items) ? data.items : []);
    } catch {
      // 静默：渲染层按 timeline===null 回退旧任务视图
    }
  }, [authToken]);

  /** Step6c：Goal 卡反馈历史加载（ready + 有行动路线的 goal；按 id 签名变化刷新） */
  const routeGoalIds = goals.filter((g) => (g.actions ?? []).length > 0).map((g) => g.id).join(",");
  useEffect(() => {
    if (authMode !== "ready" || !authToken) return;
    const ids = routeGoalIds ? routeGoalIds.split(",") : [];
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const results = await Promise.all(
          ids.map(async (goalId) => {
            const res = await fetch(`/api/reflections?goal_id=${encodeURIComponent(goalId)}&limit=6`, {
              headers: { Authorization: `Bearer ${authToken}` },
            });
            if (!res.ok) return { goalId, rows: [] as ReflectionRow[] };
            const data = (await res.json()) as { reflections?: Array<Record<string, unknown>> };
            return { goalId, rows: Array.isArray(data.reflections) ? data.reflections.map(mapApiReflection) : ([] as ReflectionRow[]) };
          }),
        );
        if (cancelled) return;
        setReflectionsByGoal((cur) => {
          const next = { ...cur };
          for (const { goalId, rows } of results) next[goalId] = rows;
          return next;
        });
      } catch {
        // 拉取失败保持现状（空态）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authMode, authToken, routeGoalIds]);

  /** 提交反馈（Step6c：manual 来源；成功前置新行到对应 goal） */
  async function submitReflection(goalId: string, actionId: string | null, rating: "good" | "bad" | null, content: string): Promise<boolean> {
    const text = content.trim();
    if (!text || authMode !== "ready" || !authToken) return false;
    try {
      const res = await fetch("/api/reflections", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ goalId, actionId, source: "manual", content: text, rating }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        notify(data.error || "反馈保存失败，请重试");
        return false;
      }
      const data = (await res.json()) as { reflection?: Record<string, unknown> };
      if (data.reflection) {
        const row = mapApiReflection(data.reflection);
        setReflectionsByGoal((cur) => ({ ...cur, [goalId]: [row, ...(cur[goalId] ?? [])].slice(0, 6) }));
      }
      notify(rating === "good" ? "已记下「做得不错」，下次排程会参考" : rating === "bad" ? "已记下「有压力」，下次排程会调整" : "已记下反馈，下次排程会参考");
      return true;
    } catch {
      notify("反馈保存失败，请重试");
      return false;
    }
  }

  /** 完成 / 撤销完成时间轴排程（乐观更新，失败回滚；fixed 无交互） */
  async function toggleTimelineRow(row: TimelineRow) {
    if (!row.scheduleId || authMode !== "ready") return;
    const next = row.status === "completed" ? "planned" : "completed";
    setTimeline((cur) => (cur ? cur.map((i) => (i.key === row.key ? { ...i, status: next } : i)) : cur));
    try {
      const res = await fetch(`/api/schedules/${row.scheduleId}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error("patch failed");
      notify(next === "completed" ? "已记下这个时段的完成" : "已把该时段放回待执行");
    } catch {
      setTimeline((cur) => (cur ? cur.map((i) => (i.key === row.key ? { ...i, status: row.status } : i)) : cur));
      notify("时段状态更新失败，请重试");
    }
  }

  /** 删除手动事项（仅 manual 行有删除钮；action 排程删除后端 409，撤销走「撤销安排」） */
  async function deleteTimelineRow(row: TimelineRow) {
    if (!row.scheduleId || row.type !== "manual" || authMode !== "ready") return;
    if (!window.confirm(`删除手动安排「${row.title}」？`)) return;
    try {
      const res = await fetch(`/api/schedules/${row.scheduleId}`, { method: "DELETE", headers: apiHeaders() });
      if (!res.ok) throw new Error("delete failed");
      setTimeline((cur) => (cur ? cur.filter((i) => i.key !== row.key) : cur));
      notify("已删除这条手动安排");
    } catch {
      notify("删除失败，请重试");
    }
  }

  /** 手动添加今日事项（POST /api/schedules → 刷新时间轴） */
  async function addManualSchedule(input: { title: string; startTime: string; endTime: string }) {
    if (!requireAuth()) return false;
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("add failed");
      await loadTodayTimeline();
      notify("已加入今日安排");
      return true;
    } catch {
      notify("保存失败，请重试");
      return false;
    }
  }

  /** 行内编辑实际投入分钟（只改 execution_records，不影响 schedule 时长/状态） */
  async function updateExecutionMinutes(row: TimelineRow, minutes: number): Promise<boolean> {
    if (!row.executionId || authMode !== "ready") return false;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      notify("实际投入应为 1-1440 的整数");
      return false;
    }
    try {
      const res = await fetch(`/api/executions/${row.executionId}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ actualMinutes: minutes }),
      });
      if (!res.ok) throw new Error("execution update failed");
      setTimeline((cur) => (cur ? cur.map((i) => (i.key === row.key ? { ...i, actualMinutes: minutes } : i)) : cur));
      notify(`实际投入已更新为 ${minutes} 分钟`);
      return true;
    } catch {
      notify("实际分钟更新失败，请重试");
      return false;
    }
  }

  // Step4：进入执行视图（今日/计划 tab）且已登录 → 刷新今日时间轴（accept/reset 后由各自 handler 主动刷新）
  useEffect(() => {
    if (authMode !== "ready" || !authToken) return;
    if (activeTab !== "今日" && activeTab !== "计划") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/schedules/today", {
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) throw new Error("timeline unavailable");
        const data = (await res.json()) as { items?: TimelineRow[] };
        if (!cancelled) setTimeline(Array.isArray(data.items) ? data.items : []);
      } catch {
        // 失败保持 null → 渲染层回退旧任务视图
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, authMode, authToken]);

  async function createGoal(input: GoalInput) {
    if (!requireAuth()) return;
    try {
      const res = await fetch("/api/goals", { method: "POST", headers: apiHeaders(), body: JSON.stringify(input) });
      if (!res.ok) throw new Error("create failed");
      const { goal } = (await res.json()) as { goal: Record<string, unknown> };
      setGoals((current) => [...current, mapApiGoal(goal)]);
      notify("目标已创建");
    } catch {
      notify("目标创建失败，请重试");
    }
  }

  async function updateGoal(id: string, input: GoalInput) {
    if (!requireAuth()) return;
    try {
      const res = await fetch(`/api/goals/${id}`, { method: "PUT", headers: apiHeaders(), body: JSON.stringify(input) });
      if (!res.ok) throw new Error("update failed");
      const { goal } = (await res.json()) as { goal: Record<string, unknown> };
      setGoals((current) => current.map((g) => (g.id === id ? mapApiGoal(goal) : g)));
      notify("目标已更新");
    } catch {
      notify("目标更新失败，请重试");
    }
  }

  async function deleteGoal(id: string) {
    if (!requireAuth()) return;
    if (!window.confirm("删除目标会同时删除它的行动路线（今日任务会保留为独立任务）。确定删除？")) return;
    try {
      const res = await fetch(`/api/goals/${id}`, { method: "DELETE", headers: apiHeaders() });
      if (!res.ok) throw new Error("delete failed");
      setGoals((current) => current.filter((g) => g.id !== id));
      notify("目标已删除");
    } catch {
      notify("目标删除失败，请重试");
    }
  }

  /** 新增任务（拆解/路线卡共用）；同目标下同标题已存在时服务端 409，前端也按标题先拦截 */
  async function addTask(input: { title: string; goalId?: string | null; subtitle?: string; scheduledTime?: string; durationMinutes?: number; kind?: TaskKind }) {
    if (!requireAuth()) return;
    if (tasks.some((t) => t.title === input.title)) {
      notify("这条行动已经在计划里了");
      return;
    }
    try {
      const res = await fetch("/api/tasks", { method: "POST", headers: apiHeaders(), body: JSON.stringify(input) });
      if (res.status === 409) {
        notify("同目标下已存在同名任务");
        return;
      }
      if (!res.ok) throw new Error("create failed");
      const { task } = (await res.json()) as { task: Task };
      setTasks((current) => [...current, task]);
      notify("已加入今日计划");
    } catch {
      notify("任务创建失败，请重试");
    }
  }

  /** 刷新目标列表（拆解/撤销后派生 taskCount/doneCount 需要更新） */
  const refreshGoals = useCallback(() => {
    if (authMode !== "ready" || !authToken) return;
    fetch("/api/goals", { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((d: { goals?: Record<string, unknown>[] }) => {
        if (Array.isArray(d.goals)) setGoals(d.goals.map(mapApiGoal));
      })
      .catch(() => {});
  }, [authMode, authToken]);

  /** 战术层入口「拆今日任务」：POST decompose → 新任务并入今日列表 + undo 记录（5 分钟窗口） */
  async function decomposeGoal(goalId: string) {
    if (!requireAuth()) return;
    if (decomposingGoalId) return;
    setDecomposingGoalId(goalId);
    try {
      const res = await fetch(`/api/goals/${goalId}/decompose`, { method: "POST", headers: apiHeaders() });
      if (!res.ok) throw new Error("decompose failed");
      const data = (await res.json()) as { count?: number; createdTaskIds?: string[]; tasks?: Task[] };
      if (data.tasks?.length) {
        setTasks((current) => [...current, ...(data.tasks as Task[])]);
        setLastGenerate({ kind: "task", ids: data.createdTaskIds ?? [], expireAt: Date.now() + 5 * 60_000 });
        notify(`已拆出 ${data.tasks.length} 个今日任务`);
      } else {
        notify("这次没有新增任务（步骤与已有任务重复）");
      }
      refreshGoals();
    } catch {
      notify("拆解失败，请稍后再试");
    } finally {
      setDecomposingGoalId(null);
    }
  }

  /** 战略层入口「制定行动路线」：POST actions/generate → Action 池，不进今日列表（2c） */
  async function generateRoute(goalId: string) {
    if (!requireAuth()) return;
    if (generatingGoalId || decomposingGoalId) return;
    setGeneratingGoalId(goalId);
    try {
      const res = await fetch(`/api/goals/${goalId}/actions/generate`, { method: "POST", headers: apiHeaders() });
      if (!res.ok) throw new Error("generate route failed");
      const data = (await res.json()) as { count?: number; skipped?: number; actions?: ActionRow[] };
      const acts = data.actions ?? [];
      if (acts.length > 0) {
        setGoals((current) =>
          current.map((g) =>
            g.id === goalId ? { ...g, actions: mergeActionRows(g.actions ?? [], acts) } : g,
          ),
        );
        setLastGenerate({ kind: "action", ids: acts.map((a) => a.id), expireAt: Date.now() + 5 * 60_000 });
        notify(`已生成 ${acts.length} 个行动阶段`);
      } else {
        notify("暂未生成行动阶段，可以重新规划");
      }
      refreshGoals();
    } catch {
      notify("行动路线生成失败，请稍后重试");
    } finally {
      setGeneratingGoalId(null);
    }
  }

  /** 手动标记行动阶段完成 / 撤销完成（乐观更新；D5：不入 records/账本，只记 completed_at） */
  async function toggleActionStatus(action: ActionRow) {
    if (!requireAuth()) return;
    const next: ActionRow["status"] = action.status === "completed" ? "pending" : "completed";
    const applyToGoal = (rows: ActionRow[]) => rows.map((a) => (a.id === action.id ? { ...a, status: next } : a));
    setGoals((current) => current.map((g) => (g.id === action.goalId ? { ...g, actions: applyToGoal(g.actions ?? []) } : g)));
    try {
      const res = await fetch(`/api/actions/${action.id}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error("patch action failed");
      const data = (await res.json()) as { action?: ActionRow };
      if (data.action) {
        setGoals((current) =>
          current.map((g) => (g.id === action.goalId ? { ...g, actions: (g.actions ?? []).map((a) => (a.id === action.id ? (data.action as ActionRow) : a)) } : g)),
        );
      }
      refreshGoals();
    } catch {
      setGoals((current) =>
        current.map((g) => (g.id === action.goalId ? { ...g, actions: (g.actions ?? []).map((a) => (a.id === action.id ? action : a)) } : g)),
      );
      notify("行动阶段更新失败，请重试");
    }
  }

  /** 撤销最近一次生成（task 分支删 tasks；action 分支删行动路线） */
  async function undoDecompose() {
    if (!lastGenerate || !requireAuth()) return;
    const { kind, ids } = lastGenerate;
    try {
      if (kind === "task") {
        const res = await fetch("/api/tasks/batch", {
          method: "DELETE",
          headers: apiHeaders(),
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error("undo tasks failed");
        setTasks((current) => current.filter((t) => !ids.includes(t.id)));
        notify("已撤销拆解");
      } else {
        const res = await fetch("/api/actions", {
          method: "DELETE",
          headers: apiHeaders(),
          body: JSON.stringify({ actionIds: ids }),
        });
        if (!res.ok) throw new Error("undo actions failed");
        setGoals((current) =>
          current.map((g) => ({ ...g, actions: (g.actions ?? []).filter((a) => !ids.includes(a.id)) })),
        );
        notify("已撤销行动路线");
      }
      setLastGenerate(null);
      refreshGoals();
    } catch {
      notify("撤销失败，请重试");
    }
  }

  /** 保存每周可用时间（整组替换；标签留空=可排空档，非空=固定块） */
  async function saveAvailabilityRows(next: AvailabilityRow[]) {
    if (!requireAuth()) return;
    setAvailRows(next);
    try {
      const res = await fetch("/api/availability", {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify({ items: next }),
      });
      if (!res.ok) throw new Error("save availability failed");
    } catch {
      notify("可用时间保存失败，请重试");
    }
  }

  /** 加载 Planner 预览（每次打开都重新请求 —— 验收 C，不缓存旧计划） */
  async function loadPlanPreview(goal: PlanGoal) {
    setPlanSession({ goal, step: "loading", data: null });
    try {
      const res = await fetch(`/api/goals/${goal.id}/plan`, { method: "POST", headers: apiHeaders() });
      if (!res.ok) throw new Error("plan failed");
      const data = (await res.json()) as PlanPreviewData;
      setPlanSession(data.blocked ? { goal, step: "blocked", data } : { goal, step: "preview", data });
    } catch {
      setPlanSession({ goal, step: "error", data: null, error: "计划生成失败，请稍后重试" });
    }
  }

  /** 打开 Planner（验收 D：已有 planned → 先问是否重新规划） */
  function openPlanner(goal: PlanGoal) {
    if (!requireAuth()) return;
    if (hasPlannedAction(goal)) {
      setPlanSession({ goal, step: "ask-replan", data: null });
      return;
    }
    void loadPlanPreview(goal);
  }

  /** 关闭弹层即清会话（不残留 accept 状态） */
  function closePlanner() {
    setPlanSession(null);
  }

  /** 接受计划（唯一写库点；成功后关闭 + 刷新 + 用户语 toast） */
  async function acceptPlanPreview() {
    const session = planSession;
    if (!session?.goal || !session.data?.items?.length) return;
    setPlanBusy(true);
    const items = session.data.items;
    try {
      const res = await fetch(`/api/goals/${session.goal.id}/plan/accept`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
          items: items.map((it) => ({ actionId: it.actionId, date: it.date, startTime: it.startTime, endTime: it.endTime })),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { accepted?: number; error?: string };
      if (!res.ok) throw new Error(payload.error || "accept failed");
      const covered = new Set(items.map((it) => it.actionId)).size;
      setPlanSession(null);
      await Promise.all([refreshGoals(), loadTodayTimeline()]);
      notify(`计划已安排：未来 14 天生成 ${payload.accepted ?? items.length} 个学习时段，涉及 ${covered} 个行动阶段。执行列表之后可在今日时间轴查看。`);
    } catch {
      notify("接受计划失败，请重试");
    } finally {
      setPlanBusy(false);
    }
  }

  /** 撤销安排（reset）：只清 AI 排程，行动路线/手动日程/完成记录不受影响 */
  async function resetGoalPlanNow(goal: PlanGoal, thenPreview: boolean) {
    setPlanBusy(true);
    try {
      const res = await fetch(`/api/goals/${goal.id}/plan/reset`, { method: "POST", headers: apiHeaders() });
      if (!res.ok) throw new Error("reset failed");
      await Promise.all([refreshGoals(), loadTodayTimeline()]);
      if (thenPreview) {
        setPlanSession(null);
        await loadPlanPreview(goal);
      } else {
        setPlanSession(null);
        notify("已撤销 AI 安排（行动路线与手动日程不受影响）");
      }
    } catch {
      notify("撤销安排失败，请重试");
    } finally {
      setPlanBusy(false);
    }
  }

  /** AI Agent 路线卡：库中无该目标则先创建真实 goal，再拆出首个任务（防重复由 addTask/409 兜底） */
  async function handleAgentGoal() {
    if (!requireAuth()) return;
    const existing = goals.find((g) => g.title.includes("学习 Agent"));
    let goalId = existing?.id ?? null;
    if (!goalId) {
      try {
        const res = await fetch("/api/goals", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ title: "学习 Agent 并开发自己的 Agent", description: "从一个具体问题做出最小可运行闭环", horizon: "今日路线" }),
        });
        if (!res.ok) throw new Error("goal create failed");
        const { goal } = (await res.json()) as { goal: Record<string, unknown> };
        const mapped = mapApiGoal(goal);
        setGoals((current) => [...current, mapped]);
        goalId = mapped.id;
      } catch {
        notify("目标创建失败，请重试");
        return;
      }
    }
    await addTask({
      title: "AI Agent 最小闭环：定义问题与验收",
      goalId,
      subtitle: "写出一个 Agent 要解决的问题，并定义一次可观察的成功结果",
      scheduledTime: "今天",
      durationMinutes: 45,
      kind: "focus",
    });
  }

  if (authMode === "loading") {
    return <div className="auth-loading">正在载入…</div>;
  }

  if (authMode === "login") {
    return <AuthScreen busy={authBusy} error={authError} onSubmit={submitAuth} />;
  }

  if (isMobileExperience) {
    return <>
      <MobileAppShell
        activeTab={activeTab}
        onNavigate={(tab) => setActiveTab(tab)}
        tasks={tasks}
        goals={goals}
        logs={logs}
        doneCount={doneCount}
        earnedCoins={earnedCoins}
        input={input}
        setInput={setInput}
        onSubmit={submitLog}
        onToggleTask={toggleTask}
        onAgentGoal={handleAgentGoal}
        assistantReply={assistantReply}
        isAgentBusy={isAgentBusy}
        reviewEnabled={reviewEnabled}
        onToggleReview={toggleReviewSchedule}
        onStartReview={startEveningReview}
        eveningTime={eveningTime}
        isFocusRunning={isFocusRunning}
        onToggleFocus={toggleFocusSession}
        toast={toast}
        onOpenChat={() => {
          if (authMode !== "ready" || !authToken) {
            notify("请先登录后再与 AI 聊天");
            return;
          }
          setChatOpen(true);
        }}
      />
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} authToken={authToken} onNotify={notify} />
    </>;
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
            <strong>{dashboardStats?.profile?.streak ?? demoSeed.user.streak} 天</strong>
            <span>连续有效行动</span>
          </div>
          <ChevronRight size={15} className="muted-icon" />
        </div>

        <div className="sidebar-bottom">
          <button className="help-link" onClick={() => notify("小贴士：把下一步缩小到 10 分钟，先留下事实，晚报时再补充结果。")}><CircleHelp size={16} /> 使用小贴士</button>
          <div className="profile-chip">
            <div className="avatar">{demoSeed.user.displayName.slice(0, 1)}</div>
            <div className="profile-meta"><strong>{demoSeed.user.displayName}</strong><span>Lv. {String(currentLevel).padStart(2, "0")} · {demoSeed.user.role}</span></div>
            {authMode === "ready" && (
              <div className="profile-actions">
                <button className="profile-logout" onClick={logout} aria-label="退出登录" title="退出登录"><LogOut size={15} /></button>
                <button className="profile-logout" onClick={openDeleteAccount} aria-label="删除账号" title="删除账号"><Trash2 size={15} /></button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <section className="main-column">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark"><Sparkles size={15} /></div><span>成长回路</span></div>
          <div className="date-stamp">{todayShanghaiDateLabel()} <span>·</span> {todayShanghaiWeekdayLabel()}</div>
          <div className="topbar-actions"><span className="ai-online-pill"><span /> AI 在线</span><button className="icon-button" aria-label="打开消息" onClick={() => { if (authMode !== "ready" || !authToken) { notify("请先登录后再与 AI 聊天"); return; } setChatOpen(true); } }><MessageCircle size={18} /></button><div className="avatar avatar-small">{demoSeed.user.displayName.slice(0, 1)}</div></div>
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
              recordMinutes={recordMinutes}
              setRecordMinutes={setRecordMinutes}
              recordOutput={recordOutput}
              setRecordOutput={setRecordOutput}
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
              eveningTime={eveningTime}
              pomodoroVisible={showPomodoro}
              onTogglePomodoro={() => setShowPomodoro((visible) => !visible)}
              pomodoro={<PomodoroWidget mode={pomodoroMode} seconds={pomodoroSeconds} isRunning={isPomodoroRunning} onToggle={togglePomodoro} onReset={resetPomodoro} onModeChange={changePomodoroMode} />}
              timeline={timeline}
              onToggleTimeline={(row) => void toggleTimelineRow(row)}
              onDeleteTimeline={(row) => void deleteTimelineRow(row)}
              onEditTimelineMinutes={(row, minutes) => updateExecutionMinutes(row, minutes)}
            />
          ) : activeTab === "计划" ? (
            <PlanPanel tasks={tasks} goals={goals} focusGoals={focusGoals} onToggleTask={toggleTask} onDecomposeGoal={decomposeGoal} onGenerateRoute={generateRoute} decomposingGoalId={decomposingGoalId} generatingGoalId={generatingGoalId} onToggleAction={toggleActionStatus} onOpenPlan={openPlanner} onResetPlan={(goal) => resetGoalPlanNow(goal, false)} availRows={availRows} onSaveAvailability={saveAvailabilityRows} onCreateGoal={createGoal} onUpdateGoal={updateGoal} onDeleteGoal={deleteGoal} onAgentGoal={handleAgentGoal} onBackToToday={() => setActiveTab("今日")} timeline={timeline} onToggleTimeline={(row) => void toggleTimelineRow(row)} onDeleteTimeline={(row) => void deleteTimelineRow(row)} onEditTimelineMinutes={(row, minutes) => updateExecutionMinutes(row, minutes)} onAddManual={(input) => addManualSchedule(input)} reflectionsByGoal={reflectionsByGoal} onSubmitReflection={submitReflection} />
          ) : activeTab === "记录" ? (
            <RecordsPanel logs={logs} input={input} setInput={setInput} recordMinutes={recordMinutes} setRecordMinutes={setRecordMinutes} recordOutput={recordOutput} setRecordOutput={setRecordOutput} inputRef={quickLogRef} onSubmit={submitLog} onGenerateQuiz={(log) => generateQuiz(log.text, log.topic, log.output, log.id, true)} onBackToToday={() => setActiveTab("今日")} />
          ) : (
            <GrowthPanel growthStats={growthStats} goals={goals} onBackToToday={() => setActiveTab("今日")} />
          )}
        </div>
        <div className="mobile-nav">{tabs.map(({ label, icon: Icon }) => <button key={label} className={activeTab === label ? "active" : ""} onClick={() => setActiveTab(label)} aria-current={activeTab === label ? "page" : undefined}><Icon size={18} /><span>{label}</span></button>)}</div>
      </section>

      <aside className="right-rail">
        <div className="rail-card level-card"><div className="level-orbit"><div className="level-number">{String(currentLevel).padStart(2, "0")}</div><div className="level-label">LV.</div></div><div><span className="card-kicker">CURRENT LEVEL</span><h3>{demoSeed.user.role}</h3><p>距离 Lv.{String(currentLevel + 1).padStart(2, "0")} 还差 <strong>{nextLevelXp} XP</strong></p></div><div className="level-progress"><span style={{ width: `${levelProgress}%` }} /></div></div>
        <div className="rail-card next-card"><div className="card-kicker">NEXT BEST ACTION</div><h3>{isFocusRunning ? "专注正在进行" : "先做 10 分钟"}</h3><p>{isFocusRunning ? "不用想着完成整件事，只要继续这一小段。" : "把主任务拆成一个最容易开始的动作，今天的回路会从这里转起来。"}</p><button className={`focus-button ${isFocusRunning ? "running" : ""}`} onClick={toggleFocusSession}>{isFocusRunning ? <><Pause size={15} /> 暂停专注</> : <><Play size={15} fill="currentColor" /> 开始专注</>}</button></div>
        <div className="rail-card wallet-card"><div className="wallet-header"><div className="wallet-icon"><WalletCards size={17} /></div><span>成长积分</span><button className="icon-button subtle" aria-label="积分详情" onClick={() => notify(`当前余额 ${demoSeed.user.coinBalance + earnedCoins} COIN，完成行动可继续增加`)}><ChevronRight size={16} /></button></div><div className="wallet-balance">{demoSeed.user.coinBalance + earnedCoins}<span> COIN</span></div><div className="wallet-meta"><span>本周 +{earnedCoins}</span><button className="text-button" onClick={() => notify("兑换入口会在绑定你的现实奖励后开放")}>去兑换 <ChevronRight size={14} /></button></div></div>
        <div className="rail-card quote-card"><div className="quote-mark">“</div><p>{demoSeed.quote}</p><span>— 今日回路</span></div>
      </aside>

      {activeQuiz && isQuizOverlayOpen && <div className="quiz-overlay" role="dialog" aria-modal="true" aria-label={`理解测验：${activeQuiz.topic}`}>
        <button className="quiz-overlay-backdrop" aria-label="关闭理解测验" onClick={closeQuizOverlay} />
        <div className="quiz-overlay-dialog">
          <div className="quiz-overlay-toolbar"><span>正在专注：理解测验</span><button className="quiz-close-button" onClick={closeQuizOverlay}><X size={15} /> 关闭</button></div>
          <LearningQuizCard quiz={activeQuiz} answers={quizAnswers} grade={quizGrade} busy={quizBusy} error={quizError} onAnswer={(id, value) => setQuizAnswers((answers) => ({ ...answers, [id]: value }))} onGrade={gradeQuiz} onReset={resetQuiz} />
        </div>
      </div>}

      {deleteOpen && <div className="quiz-overlay" role="dialog" aria-modal="true" aria-label="删除账号">
        <button className="quiz-overlay-backdrop" aria-label="取消删除" onClick={() => !deleteBusy && setDeleteOpen(false)} />
        <div className="quiz-overlay-dialog">
          <div className="quiz-overlay-toolbar"><span>删除账号</span><button className="quiz-close-button" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}><X size={15} /> 关闭</button></div>
          <div className="delete-account-panel">
            <h3 className="delete-account-title">永久删除账号</h3>
            <p className="delete-account-copy">此操作将<strong>永久删除</strong>你的账号，以及所有目标、任务、记录、积分账本与成长报告数据，<strong>无法恢复</strong>。请确认这是你想要的。</p>
            {deleteExpectedEmail ? (
              <>
                <p className="delete-account-hint">请输入你的邮箱 <code>{deleteExpectedEmail}</code> 以确认删除</p>
                <input
                  className="delete-account-input"
                  type="email"
                  value={deleteInputEmail}
                  onChange={(e) => setDeleteInputEmail(e.target.value)}
                  placeholder={deleteExpectedEmail}
                  disabled={deleteBusy}
                  autoComplete="off"
                />
              </>
            ) : (
              <p className="delete-account-hint delete-account-hint-warn">{deleteError || "正在获取账号信息…"}</p>
            )}
            {deleteError && deleteExpectedEmail && <p className="delete-account-error">{deleteError}</p>}
            <div className="delete-account-actions">
              <button className="quiet-button" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>取消</button>
              <button
                className="delete-account-confirm"
                onClick={confirmDeleteAccount}
                disabled={deleteBusy || !deleteExpectedEmail || deleteInputEmail !== deleteExpectedEmail}
              >
                {deleteBusy ? "正在删除…" : "永久删除账号"}
              </button>
            </div>
          </div>
        </div>
      </div>}

      {toast && <div className="toast" role="status" aria-live="polite"><span className="toast-status" /> {toast}</div>}
      {lastGenerate && Date.now() < lastGenerate.expireAt && (
        <div className="undo-bar" role="status" aria-live="polite">
          <span>{lastGenerate.kind === "task" ? `已拆出 ${lastGenerate.ids.length} 个今日任务` : `已生成 ${lastGenerate.ids.length} 个行动阶段`}</span>
          <button onClick={undoDecompose}>撤销 <Undo2 size={13} /></button>
        </div>
      )}

      {planSession && (
        <PlannerModal
          session={planSession}
          busy={planBusy}
          hasReflections={(reflectionsByGoal[planSession.goal.id]?.length ?? 0) > 0}
          onClose={closePlanner}
          onAccept={() => void acceptPlanPreview()}
          onReplan={() => resetGoalPlanNow(planSession.goal, true)}
          onKeepExisting={() => { closePlanner(); notify("已保留当前安排；执行时段将在今日时间轴（下一步）展示。"); }}
          onGoAvailability={() => { closePlanner(); document.getElementById("availability-card")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
        />
      )}

      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} authToken={authToken} onNotify={notify} />
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
  recordMinutes: string;
  setRecordMinutes: React.Dispatch<React.SetStateAction<string>>;
  recordOutput: string;
  setRecordOutput: React.Dispatch<React.SetStateAction<string>>;
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
  eveningTime: string;
  pomodoroVisible: boolean;
  onTogglePomodoro: () => void;
  pomodoro: React.ReactNode;
  timeline: TimelineRow[] | null;
  onToggleTimeline: (row: TimelineRow) => void;
  onDeleteTimeline: (row: TimelineRow) => void;
  onEditTimelineMinutes?: (row: TimelineRow, minutes: number) => Promise<boolean>;
};

function TodayHome({ greeting, tasks, doneCount, input, setInput, recordMinutes, setRecordMinutes, recordOutput, setRecordOutput, quickLogRef, onSubmit, onToggleTask, onOpenPlan, assistantReply, isAgentBusy, reviewEnabled, onToggleReview, onStartReview, evening, eveningTime, pomodoroVisible, onTogglePomodoro, pomodoro, timeline, onToggleTimeline, onDeleteTimeline, onEditTimelineMinutes }: TodayHomeProps) {
  const visibleTasks = tasks.slice(0, 4);
  const tlItems = timeline ?? [];
  const timelineMode = tlItems.length > 0;
  const tlDone = tlItems.filter((x) => x.status === "completed").length;
  return <div className="home-command-center">
    <section className="home-intro">
      <div>
        <div className="eyebrow"><span className="eyebrow-line" /> AI DAILY COMPANION <span className="eyebrow-muted">/ 今天只推进下一步</span></div>
        <h1>{greeting}</h1>
        <p className="home-intro-copy">随手记下今天发生的事，白天不打断节奏；晚上 AI 再把一天收束成经验。</p>
      </div>
      <div className="home-intro-stamp"><span className="home-stamp-dot" />{reviewEnabled ? `今晚 ${eveningTime} 回顾` : "晚间回顾已关闭"}</div>
    </section>

    <section className="ai-dialog-card" aria-label="AI 今日对话入口">
      <div className="ai-dialog-head">
        <div className="ai-avatar"><Sparkles size={18} /></div>
         <div className="ai-dialog-copy"><span className="card-kicker">AI TODAY ENTRY</span><strong>随手告诉我刚刚发生了什么</strong><p>{assistantReply}</p></div>
        <span className={`ai-activity-state ${isAgentBusy ? "is-busy" : ""}`}><span />{isAgentBusy ? "整理中" : "在线"}</span>
      </div>
      <div className="ai-composer">
        <textarea ref={quickLogRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：今天看了 Agent 的工具调用，终于理解了它和普通聊天的区别……" rows={4} aria-label="今天发生了什么" />
        <div className="ai-record-fields">
          <input type="number" min={0} max={1440} value={recordMinutes} onChange={(event) => setRecordMinutes(event.target.value)} placeholder="时长（分钟，可选）" aria-label="记录时长（分钟）" />
          <input value={recordOutput} onChange={(event) => setRecordOutput(event.target.value)} placeholder="产出 / 结果（可选）" aria-label="记录产出" />
        </div>
        <div className="ai-composer-footer"><span>随手写就好，不用先整理格式 · {input.length}/480 · 晚间统一回顾</span><button className="ai-send-button" onClick={onSubmit} disabled={!input.trim() || isAgentBusy}><span>{isAgentBusy ? "AI 正在整理" : "保存记录"}</span><ArrowUpRight size={16} /></button></div>
      </div>
      <div className="ai-suggestion-row"><span>可以直接说：</span><button onClick={() => setInput("今天学了什么：")}>今天学了什么</button><button onClick={() => setInput("今天卡在哪里：")}>今天卡在哪里</button><button onClick={() => setInput("今晚回顾：")}>今晚回顾</button></div>
    </section>

    <section className="home-follow-up home-evening-report-hint"><div className="follow-up-icon"><BedDouble size={17} /></div><div><span className="eyebrow">EVENING REPORT · {eveningTime}</span><strong>白天先记录，晚上再统一回答</strong><p>AI 会把今天的学习、运动、生活和休息合在一起，依次追问行动、理解与明天的一步。</p></div><span className="follow-up-count">晚报</span></section>

    <section className="home-agenda-grid">
      <div className="home-agenda-card">
        <div className="home-section-head"><div><span className="eyebrow">TODAY AGENDA</span><h2>{timelineMode ? "今日安排" : "今天要做的事"}</h2></div><span className="agenda-count">{timelineMode ? `${tlDone}/${tlItems.length} 已完成` : `${doneCount}/${tasks.length} 完成`}</span></div>
        <div className="home-agenda-list">{timelineMode ? tlItems.slice(0, 4).map((row) => <TimelineItemCard key={row.key} row={row} onToggle={onToggleTimeline} onDelete={onDeleteTimeline} onEditActual={onEditTimelineMinutes} />) : visibleTasks.map((task) => <HomeAgendaRow key={task.id} task={task} onToggle={onToggleTask} />)}</div>
        {!timelineMode && tasks.length === 0 && <p className="agenda-empty">今天还没有安排：在「计划地图」给目标制定行动路线并安排计划，时间轴会从这里长出真实的下一步。</p>}
        <div className="home-agenda-footer"><button className="home-more-button" onClick={onOpenPlan}>查看完整计划 <ChevronRight size={15} /></button><button className="home-focus-link" onClick={onTogglePomodoro}><Timer size={14} />{pomodoroVisible ? "收起专注工具" : "需要节奏？打开 25 分钟"}</button></div>
        {pomodoroVisible && <div className="home-pomodoro-slot">{pomodoro}</div>}
      </div>

      <aside className="home-review-card"><div className="home-section-head"><div><span className="eyebrow">EVENING REVIEW</span><h2>每日收束</h2></div><BedDouble size={18} className="panel-icon" /></div>
        {evening.state === "ready" && evening.summary ? (
          <>
            <p className="evening-summary-preview">{evening.summary.length > 120 ? `${evening.summary.slice(0, 120)}…` : evening.summary}</p>
            {evening.content && <EveningStructured content={evening.content} />}
            <div className="review-time-row"><strong>今日晚报</strong><span>服务端已生成 · 三问待你回答</span></div>
          </>
        ) : (
          <p>{evening.state === "loading" ? "正在加载今日晚报…" : evening.state === "generating" ? "AI 正在把今天的记录收束成晚报…" : evening.state === "error" ? "今日晚报生成失败，可以稍后手动回顾。" : "AI 会在晚上把今天的记录收束成三问。白天记录，晚上回答。"}</p>
        )}
        {evening.state === "no-report" && <div className="review-time-row"><strong>{eveningTime}</strong><span>每天一次 · 轻提醒</span><button className={`review-toggle ${reviewEnabled ? "is-enabled" : ""}`} aria-pressed={reviewEnabled} onClick={onToggleReview}><span />{reviewEnabled ? "已开启" : "已关闭"}</button></div>}
        <button className="review-start-button" onClick={onStartReview}>现在开始回顾 <ArrowUpRight size={15} /></button></aside>
    </section>

    <div className="home-trust-line"><span><Sparkles size={13} /> AI 只在需要时出现</span><span>计划、成长和账本会在你需要时展开</span><button className="text-button" onClick={onOpenPlan}>打开计划地图 <ChevronRight size={14} /></button></div>
  </div>;
}

/** 晚报卡结构化内容（Phase 2：今日达成 / 遇到的阻碍 / 明日建议） */
function EveningStructured({ content }: { content: Record<string, unknown> }) {
  const achievement = Array.isArray(content.achievement) ? content.achievement.filter((x): x is string => typeof x === "string") : [];
  const problem = Array.isArray(content.problem) ? content.problem.filter((x): x is string => typeof x === "string") : [];
  const suggestion = Array.isArray(content.suggestion) ? content.suggestion.filter((x): x is string => typeof x === "string") : [];
  if (achievement.length === 0 && problem.length === 0 && suggestion.length === 0) return null;
  return <div className="evening-structured">
    {achievement.length > 0 && <div className="evening-block"><strong>今日达成</strong><ul>{achievement.map((a) => <li key={a}>{a}</li>)}</ul></div>}
    {problem.length > 0 && <div className="evening-block"><strong>遇到的阻碍</strong><ul>{problem.map((p) => <li key={p}>{p}</li>)}</ul></div>}
    {suggestion.length > 0 && <div className="evening-block"><strong>明日建议</strong><ul>{suggestion.map((s) => <li key={s}>{s}</li>)}</ul></div>}
  </div>;
}

/** 时间轴行（Step 4）：action/manual/fixed 统一卡片；fixed 纯展示，manual 带删除钮 */
function TimelineItemCard({ row, onToggle, onDelete, onEditActual }: { row: TimelineRow; onToggle: (row: TimelineRow) => void; onDelete: (row: TimelineRow) => void; onEditActual?: (row: TimelineRow, minutes: number) => Promise<boolean> | boolean }) {
  const interactive = row.type !== "fixed" && !!row.scheduleId;
  const canEdit = row.status === "completed" && !!row.executionId && !!onEditActual;
  const [editingActual, setEditingActual] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const draftValid = Number.isInteger(Number(draft)) && Number(draft) >= 1 && Number(draft) <= 1440;
  async function saveActual() {
    if (!draftValid || saving || !onEditActual) return;
    setSaving(true);
    const saved = await onEditActual(row, Number(draft));
    setSaving(false);
    if (saved) setEditingActual(false);
  }
  return (
    <div className={`timeline-item type-${row.type} ${row.status === "completed" ? "is-done" : ""}`}>
      <div className="timeline-time"><strong>{row.startTime}</strong><span>{row.endTime}</span></div>
      <div className="timeline-copy">
        <div className="timeline-title-line">
          <h3>{row.title}</h3>
          <span className={`timeline-badge src-${row.type}`}>{row.type === "action" ? "AI安排" : row.type === "manual" ? "手动" : "固定时间"}</span>
        </div>
        {canEdit && (
          <div className="timeline-actual">
            {editingActual ? (
              <>
                <input type="number" min={1} max={1440} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="实际投入分钟" />
                <button className="timeline-actual-save" disabled={!draftValid || saving} onClick={() => void saveActual()}>{saving ? "保存中" : "保存"}</button>
                <button className="timeline-actual-cancel" onClick={() => setEditingActual(false)}>取消</button>
              </>
            ) : (
              <span className="timeline-actual-note">实际投入 {row.actualMinutes ?? "—"} 分钟<button className="timeline-actual-edit" onClick={() => { setDraft(String(row.actualMinutes ?? "")); setEditingActual(true); }}>修改</button></span>
            )}
          </div>
        )}
      </div>
      {interactive && (
        <button
          className={`timeline-check ${row.status === "completed" ? "checked" : ""}`}
          onClick={() => onToggle(row)}
          aria-label={`${row.status === "completed" ? "撤销" : "完成"}：${row.title}`}
        >
          {row.status === "completed" ? <Check size={15} strokeWidth={3} /> : <span />}
        </button>
      )}
      {row.type === "manual" && row.scheduleId && (
        <button className="timeline-del" onClick={() => onDelete(row)} aria-label={`删除：${row.title}`}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function HomeAgendaRow({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(task.acceptance);
  return <article className={`home-agenda-row ${task.status === "done" ? "is-done" : task.status === "current" ? "is-current" : ""} ${expandable ? "is-expandable" : ""}`} onClick={() => expandable && setExpanded((value) => !value)}>
    <div className="home-agenda-time"><strong>{task.time || "今天"}</strong><span>{task.duration}</span></div>
    <div className={`home-agenda-kind kind-${task.kind}`}>{renderTaskKindIcon(task.kind, 15)}</div>
    <div className="home-agenda-copy"><div><strong>{task.title}</strong><span className={`home-kind-label kind-${task.kind}`}>{taskKindLabel(task.kind)}</span></div><p>{task.subtitle}</p>{expanded && task.acceptance ? <p className="task-acceptance"><span>完成标准</span>{task.acceptance}</p> : null}</div>
    <button className={`home-agenda-check ${task.status === "done" ? "is-done" : ""}`} onClick={(event) => { event.stopPropagation(); onToggle(task.id); }} aria-label={`${task.status === "done" ? "撤销" : "完成"}：${task.title}`}>{task.status === "done" ? <Check size={14} strokeWidth={3} /> : <span />}</button>
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

function WorkspaceHeader({ eyebrow, title, description, onBackToToday, action }: { eyebrow: string; title: string; description: string; onBackToToday?: () => void; action?: ReactNode }) {
  return <div className="workspace-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div><div className="workspace-heading-actions">{action}{onBackToToday ? <button className="quiet-button" onClick={onBackToToday}><LayoutDashboard size={15} /> 回到今日</button> : null}</div></div>;
}

function PlanPanel({ tasks, goals, focusGoals, onToggleTask, onCreateGoal, onUpdateGoal, onDeleteGoal, onAgentGoal, onDecomposeGoal, onGenerateRoute, decomposingGoalId, generatingGoalId, onToggleAction, onOpenPlan, onResetPlan, availRows, onSaveAvailability, onBackToToday, timeline, onToggleTimeline, onDeleteTimeline, onEditTimelineMinutes, onAddManual, reflectionsByGoal, onSubmitReflection }: {
  tasks: Task[];
  goals: PlanGoal[];
  focusGoals: Goal[] | null;
  onToggleTask: (id: string) => void;
  onCreateGoal: (input: GoalInput) => void;
  onUpdateGoal: (id: string, input: GoalInput) => void;
  onDeleteGoal: (id: string) => void;
  onAgentGoal: () => void;
  onDecomposeGoal: (goalId: string) => void;
  onGenerateRoute: (goalId: string) => void;
  decomposingGoalId: string | null;
  generatingGoalId: string | null;
  onToggleAction: (action: ActionRow) => void;
  onOpenPlan: (goal: PlanGoal) => void;
  onResetPlan: (goal: PlanGoal) => void;
  availRows: AvailabilityRow[];
  onSaveAvailability: (rows: AvailabilityRow[]) => void;
  onBackToToday?: () => void;
  timeline: TimelineRow[] | null;
  onToggleTimeline: (row: TimelineRow) => void;
  onDeleteTimeline: (row: TimelineRow) => void;
  onEditTimelineMinutes?: (row: TimelineRow, minutes: number) => Promise<boolean>;
  onAddManual: (input: { title: string; startTime: string; endTime: string }) => Promise<boolean>;
  reflectionsByGoal: Record<string, ReflectionRow[]>;
  onSubmitReflection: (goalId: string, actionId: string | null, rating: "good" | "bad" | null, content: string) => Promise<boolean>;
}) {
  const completed = tasks.filter((task) => task.status === "done").length;
  const tlItems = timeline ?? [];
  const timelineMode = tlItems.length > 0;
  const tlDone = tlItems.filter((x) => x.status === "completed").length;
  const legacyOpenTasks = tasks.filter((task) => task.status !== "done");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", description: "", startDate: "", endDate: "", horizon: "" });
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // Step4：手动安排表单
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualStart, setManualStart] = useState("09:00");
  const [manualEnd, setManualEnd] = useState("10:00");
  const [manualBusy, setManualBusy] = useState(false);

  /** 旧任务卡（Step 4 legacy 视图/折叠池复用；toggle 仍走 tasks 入账链路） */
  const renderLegacyCard = (task: Task) => (
    <div className={`schedule-card ${task.status === "done" ? "is-done" : task.status === "current" ? "is-current" : ""} ${task.acceptance ? "is-expandable" : ""}`} key={task.id} onClick={() => task.acceptance && setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}>
      <div className="schedule-time"><strong>{task.time || "今天"}</strong><span>{task.duration}</span></div>
      <div className={`schedule-icon kind-${task.kind}`}>{renderTaskKindIcon(task.kind, 16)}</div>
      <div className="schedule-copy">
        <div className="task-title-line"><h3>{task.title}</h3><span className={`schedule-kind kind-${task.kind}`}>{taskKindLabel(task.kind)}</span>{task.status === "current" && <span className="now-pill">NOW</span>}</div>
        <p>{task.subtitle}</p>
        {expandedTaskId === task.id && task.acceptance ? <p className="task-acceptance"><span>完成标准</span>{task.acceptance}</p> : null}
        <span className="schedule-reward">+{task.xp} XP · +{task.coin} coin</span>
      </div>
      <button className={`task-check ${task.status === "done" ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onToggleTask(task.id); }} aria-label={`${task.status === "done" ? "撤销" : "完成"}：${task.title}`}>{task.status === "done" ? <Check size={15} strokeWidth={3} /> : <span />}</button>
    </div>
  );

  async function submitManual() {
    const title = manualTitle.trim();
    if (!title || manualBusy || !manualEnd || manualEnd <= manualStart) return;
    setManualBusy(true);
    const ok = await onAddManual({ title, startTime: manualStart, endTime: manualEnd });
    setManualBusy(false);
    if (ok) {
      setManualOpen(false);
      setManualTitle("");
    }
  }

  function startCreate() {
    setEditingId(null);
    setForm({ title: "", description: "", startDate: "", endDate: "", horizon: "" });
    setShowForm(true);
  }
  function startEdit(goal: PlanGoal) {
    setEditingId(goal.id);
    setForm({ title: goal.title, description: goal.description, startDate: goal.startDate ?? "", endDate: goal.endDate ?? "", horizon: goal.horizon });
    setShowForm(true);
  }
  function submitForm() {
    if (!form.title.trim()) return;
    const input: GoalInput = {
      title: form.title.trim(),
      description: form.description.trim(),
      startDate: form.startDate || undefined,
      endDate: form.endDate || undefined,
      horizon: form.horizon.trim(),
    };
    if (editingId) onUpdateGoal(editingId, input);
    else onCreateGoal(input);
    setShowForm(false);
    setEditingId(null);
  }

  return <div className="workspace-page">
    <WorkspaceHeader eyebrow="PLAN BOARD" title="计划地图" description="先看目标，再看今天要落地的那一步。" onBackToToday={onBackToToday} action={<button className="quiet-button" onClick={startCreate}><Plus size={14} /> 新建目标</button>} />
    <div className="goal-grid-head"><span>你的真实目标 · 进度按行动阶段完成率派生（旧任务自动兼容）</span></div>
    <div className="goal-grid">
      {goals.map((goal) => {
        const goalActions = goal.actions ?? [];
        const hasRoute = goalActions.length > 0;
        const busy = decomposingGoalId !== null || generatingGoalId !== null;
        return (
          <article className="goal-card" key={goal.id}>
            <div className="goal-card-top"><span className="goal-status">{goal.status}</span><span className="goal-horizon">{goal.horizon || "未设周期"}</span></div>
            <h3>{goal.title}</h3>
            <p>{goal.description || "还没有描述"}</p>
            <div className="goal-progress-row"><span>{hasRoute ? "行动阶段" : "当前进度"}</span><strong>{hasRoute ? `${goal.actionDoneCount ?? 0}/${goal.actionCount ?? 0} 已完成` : `${goal.progress}%`}</strong></div>
            <div className="goal-progress"><span style={{ width: `${goal.progress}%` }} /></div>
            {hasRoute && (
              <div className="goal-actions-list">
                {goalActions.map((action) => {
                  const spent = action.spentMinutes ?? 0;
                  const reached = action.status !== "completed" && spent >= action.estimatedMinutes;
                  return (
                    <div className={`goal-action-row ${action.status === "completed" ? "is-done" : ""}`} key={action.id}>
                      <span className={`goal-action-status status-${action.status}`}>{action.status === "completed" ? <Check size={13} strokeWidth={3} /> : action.status === "planned" ? <span className="goal-action-clock" /> : <span className="goal-action-dot" />}</span>
                      <div className="goal-action-copy">
                        <div className="goal-action-title-line"><strong>{action.title}</strong>{reached && <span className="goal-action-reached">已达预计投入</span>}<span className="goal-action-est">{spent > 0 ? `投入 ${formatActionMinutes(spent)} / 预计 ${formatActionMinutes(action.estimatedMinutes)}` : `预计 ${formatActionMinutes(action.estimatedMinutes)}`}</span></div>
                        {action.dependsOnTitles.length > 0 && <span className="goal-action-depends">依赖：{action.dependsOnTitles.join("、")}</span>}
                      </div>
                      <button className="goal-action-toggle" disabled={action.status === "planned"} onClick={() => onToggleAction(action)}>{action.status === "completed" ? "撤销完成" : action.status === "planned" ? "已安排" : reached ? "确认完成" : "标记完成"}</button>
                    </div>
                  );
                })}
              </div>
            )}
            {goalActions.length > 0 && (() => {
              const plannedN = goalActions.filter((a) => a.status === "planned").length;
              const pendingN = goalActions.filter((a) => a.status === "pending").length;
              return (
                <div className="goal-plan-bar">
                  <span className="goal-plan-bar-note">{plannedN > 0 ? `已安排 ${plannedN} 个阶段` : pendingN > 0 ? "可安排排程" : "全部完成"}</span>
                  <div className="goal-plan-bar-actions">
                    {pendingN > 0 && <button className="text-button goal-plan-btn" disabled={busy} onClick={() => onOpenPlan(goal)}>安排计划 <ChevronRight size={13} /></button>}
                    {plannedN > 0 && (
                      <button
                        className="text-button"
                        onClick={() => {
                          if (window.confirm("撤销 AI 安排的计划？\n\n已生成的时间安排会被移除，但不会删除行动路线，也不会影响手动添加的日程。\n（点「确定」=撤销安排；「取消」=保留计划）")) onResetPlan(goal);
                        }}
                      >
                        撤销安排
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
            {hasRoute && <GoalReflectionBox goal={goal} reflections={reflectionsByGoal[goal.id] ?? []} onSubmit={onSubmitReflection} />}
            <div className="goal-footer">
              <span>{hasRoute ? <><Target size={13} /> 行动路线 {goal.actionDoneCount ?? 0}/{goal.actionCount ?? 0} 完成</> : <><Target size={13} /> {goal.taskCount ?? 0} 个任务 · {goal.doneCount ?? 0} 完成</>}</span>
              <div className="goal-actions">
                <button className="text-button" onClick={() => startEdit(goal)}>编辑</button>
                <button className="text-button" onClick={() => onDeleteGoal(goal.id)}>删除</button>
                <button className="text-button" disabled={busy} onClick={() => onDecomposeGoal(goal.id)}>{decomposingGoalId === goal.id ? "拆解中…" : "拆今日任务"}</button>
                <button className="text-button goal-route-button" disabled={busy} onClick={() => onGenerateRoute(goal.id)}>{generatingGoalId === goal.id ? "生成中…" : "制定行动路线"} <ChevronRight size={14} /></button>
              </div>
            </div>
          </article>
        );
      })}
      {goals.length === 0 && <article className="goal-card goal-card-empty"><h3>还没有目标</h3><p>创建一个 4–12 周目标，计划地图会从这里长出真实的下一步。</p><button className="primary-button" onClick={startCreate}>创建第一个目标 <ArrowUpRight size={15} /></button></article>}
    </div>
    {showForm && <section className="panel goal-form-panel"><div className="panel-heading"><div><span className="eyebrow">{editingId ? "EDIT GOAL" : "NEW GOAL"}</span><h2>{editingId ? "编辑目标" : "新建目标"}</h2></div><button className="quiet-button" onClick={() => { setShowForm(false); setEditingId(null); }}>收起</button></div><div className="goal-form"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="目标标题，例如：半年英语提升" aria-label="目标标题" /><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="描述（可选）：想达到什么结果" aria-label="目标描述" /><div className="goal-form-row"><input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} aria-label="开始日期" /><input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} aria-label="结束日期" /><input value={form.horizon} onChange={(e) => setForm({ ...form, horizon: e.target.value })} placeholder="周期，如 4 周目标" aria-label="周期" /></div><button className="primary-button" onClick={submitForm} disabled={!form.title.trim()}>{editingId ? "保存修改" : "创建目标"} <ArrowUpRight size={15} /></button></div></section>}
     <section className="panel agent-roadmap-panel"><div className="panel-heading"><div><span className="eyebrow">AI AGENT TRACK</span><h2>学习 Agent，并开发自己的 Agent</h2></div><Sparkles size={18} className="panel-icon" /></div><p className="panel-desc">这条路线把“学 AI”收敛成一个可以持续交付的小项目：先理解组成，再做最小闭环，最后用测验和真实任务验证。</p><div className="roadmap-stages"><div className="roadmap-stage"><span className="roadmap-number">01</span><div><strong>理解 Agent</strong><p>LLM、Prompt、工具调用、状态/记忆和评估。</p></div></div><div className="roadmap-stage"><span className="roadmap-number">02</span><div><strong>做最小闭环</strong><p>信息 → 决策 → 工具 → 结果，先解决一个具体问题。</p></div></div><div className="roadmap-stage"><span className="roadmap-number">03</span><div><strong>验证与迭代</strong><p>留下可验证证据，用理解题、日志和用户反馈校准。</p></div></div></div><div className="roadmap-action"><div><span>今日建议 · 45 分钟</span><strong>定义你的 Agent 问题与验收标准</strong></div><button className="primary-button" onClick={onAgentGoal}>加入今日计划 <ArrowUpRight size={15} /></button></div></section>
    <div className="plan-layout">
      <section className="panel schedule-panel"><div className="panel-heading"><div><span className="eyebrow">TODAY TIMELINE</span><h2>今日时间轴</h2></div><span className="count-badge">{timelineMode ? `${tlDone}/${tlItems.length} 已完成` : `${completed}/${tasks.length} 已完成`}</span></div><p className="panel-desc">{timelineMode ? "AI 排程与手动事项都在这里；固定时间块只展示、不可占用。完成时段只记执行，不推进目标阶段。" : "还没有排程，先显示待办任务；给行动路线点「安排计划」后，这里会变成真正的时间轴。"}</p>
        {timelineMode ? (
          <>
            <div className="schedule-list timeline-list">{tlItems.map((row) => <TimelineItemCard key={row.key} row={row} onToggle={onToggleTimeline} onDelete={onDeleteTimeline} onEditActual={onEditTimelineMinutes} />)}</div>
            {legacyOpenTasks.length > 0 && (
              <details className="timeline-legacy-pool"><summary>{legacyOpenTasks.length} 个待办旧任务（未排程，完成仍计入成长）</summary><div className="schedule-list">{legacyOpenTasks.map(renderLegacyCard)}</div></details>
            )}
            <div className="timeline-add">
              {manualOpen ? (
                <div className="timeline-manual-form">
                  <input value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} placeholder="手动事项，例如：下午买菜" aria-label="手动事项标题" />
                  <input type="time" value={manualStart} onChange={(e) => setManualStart(e.target.value)} aria-label="开始时间" />
                  <input type="time" value={manualEnd} onChange={(e) => setManualEnd(e.target.value)} aria-label="结束时间" />
                  <button className="primary-button" disabled={!manualTitle.trim() || !manualEnd || manualEnd <= manualStart || manualBusy} onClick={() => void submitManual()}>{manualBusy ? "保存中…" : "加入安排"}</button>
                  <button className="quiet-button" onClick={() => setManualOpen(false)}>取消</button>
                </div>
              ) : (
                <button className="quiet-button timeline-add-btn" onClick={() => setManualOpen(true)}><Plus size={13} /> 手动安排</button>
              )}
            </div>
          </>
        ) : tasks.length > 0 ? (
          <div className="schedule-list">{tasks.map(renderLegacyCard)}</div>
        ) : (
          <p className="timeline-empty-guide">今天还没有安排：给目标点「制定行动路线」→「安排计划」，这里会生成未来 14 天真正的时间轴；也可以先用「手动安排」随手加上今天的时段。</p>
        )}
      </section>
     <aside className="panel weekly-plan-panel"><div className="panel-heading"><div><span className="eyebrow">WEEKLY INTENT</span><h2>本周重点</h2></div><ListChecks size={18} className="panel-icon" /></div><div className="intent-list">{focusGoals && focusGoals.length > 0 ? focusGoals.map((goal, index) => <div className="intent-item" key={goal.id}><span className="intent-number">0{index + 1}</span><div><strong>{goal.title}</strong><p>{goal.description}</p></div></div>) : <div className="intent-item"><span className="intent-number">—</span><div><strong>还没有进行中的目标</strong><p>在计划里创建一个 4-12 周目标，本周重点会从这里出现。</p></div></div>}</div><div className="plan-note"><Sparkles size={15} /><span>建议：今天完成主任务后，不再新增新的计划。</span></div></aside>
    </div>

    <AvailabilityEditor rows={availRows} onSave={onSaveAvailability} />
  </div>;
}

/** Goal 卡「反馈一下这次计划」（Step 6c：快捷评分 good/bad + 可选文字；下方只读历史反馈） */
function GoalReflectionBox({ goal, reflections, onSubmit }: {
  goal: PlanGoal;
  reflections: ReflectionRow[];
  onSubmit: (goalId: string, actionId: string | null, rating: "good" | "bad" | null, content: string) => Promise<boolean>;
}) {
  const [rating, setRating] = useState<"good" | "bad" | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const actionTitleById = new Map((goal.actions ?? []).map((a) => [a.id, a.title]));

  async function submit() {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onSubmit(goal.id, null, rating, text);
    setBusy(false);
    if (ok) {
      setRating(null);
      setContent("");
    }
  }

  return (
    <div className="goal-reflection">
      <div className="goal-reflection-form">
        <div className="goal-reflection-head"><span>反馈一下这次计划</span><em>AI 下次排程会参考</em></div>
        <div className="goal-reflection-rating">
          <button type="button" className={`goal-ref-chip ${rating === "good" ? "is-good" : ""}`} onClick={() => setRating(rating === "good" ? null : "good")} aria-pressed={rating === "good"}>做得不错</button>
          <button type="button" className={`goal-ref-chip ${rating === "bad" ? "is-bad" : ""}`} onClick={() => setRating(rating === "bad" ? null : "bad")} aria-pressed={rating === "bad"}>有压力</button>
        </div>
        <div className="goal-reflection-write">
          <textarea value={content} onChange={(e) => setContent(e.target.value.slice(0, 500))} rows={2} maxLength={500} placeholder={rating === "bad" ? "补充一下：哪个部分有压力？（可选）" : rating === "good" ? "补充一下：哪里让你觉得不错？（可选）" : "写一句这次计划的感受（可选）"} aria-label="反馈内容" />
          <button type="button" className="text-button goal-ref-submit" disabled={busy || !content.trim()} onClick={() => void submit()}>{busy ? "提交中…" : "提交反馈"}</button>
        </div>
      </div>
      {reflections.length > 0 && (
        <div className="goal-reflection-history">
          <span className="goal-reflection-history-title">历史反馈</span>
          {reflections.slice(0, 3).map((r) => (
            <div className="goal-reflection-item" key={r.id}>
              <span className="goal-reflection-item-rating">{r.rating === "good" ? "不错" : r.rating === "bad" ? "有压力" : "反馈"}</span>
              <span className="goal-reflection-item-text">{r.content}{r.actionId && actionTitleById.get(r.actionId) ? `（针对阶段：${actionTitleById.get(r.actionId)}）` : ""}</span>
              <span className="goal-reflection-item-date">{formatReflectionDate(r.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 本周可用时间设置卡（Step3；标签留空 = 可排空档，非空 = 固定块不可占用） */
function AvailabilityEditor({ rows, onSave }: { rows: AvailabilityRow[]; onSave: (rows: AvailabilityRow[]) => void }) {
  const [wd, setWd] = useState(0);
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("21:00");
  const [title, setTitle] = useState("");
  const [touched, setTouched] = useState(false);

  const sortedRows = [...rows].sort((a, b) => (a.weekday === b.weekday ? a.startTime.localeCompare(b.startTime) : a.weekday - b.weekday));

  function addRow(w: number, startTime: string, endTime: string, label: string) {
    const dup = rows.some((r) => r.weekday === w && r.startTime === startTime && r.endTime === endTime && r.title === label);
    if (dup) return;
    onSave([...rows, { weekday: w, startTime, endTime, type: "learn", title: label }]);
    setTouched(true);
  }
  function removeRow(indexInSorted: number) {
    const target = sortedRows[indexInSorted];
    onSave(rows.filter((r) => !(r.weekday === target.weekday && r.startTime === target.startTime && r.endTime === target.endTime && r.title === target.title)));
    setTouched(true);
  }
  function addPreset() {
    // 工作日 19:00-22:00 学习空档（去重后并入）
    const next = [...rows];
    for (let w = 0; w <= 4; w++) {
      if (!next.some((r) => r.weekday === w && r.startTime === "19:00" && r.endTime === "22:00")) {
        next.push({ weekday: w, startTime: "19:00", endTime: "22:00", type: "learn", title: "" });
      }
    }
    onSave(next);
    setTouched(true);
  }

  return (
    <section id="availability-card" className="panel availability-panel">
      <div className="panel-heading"><div><span className="eyebrow">WEEKLY TIME</span><h2>本周可用时间</h2></div><span className="availability-hint">标签留空 = 可排空档 · 填标签（如“上课/运动”）= 固定块只展示</span></div>
      <div className="availability-list">
        {sortedRows.length === 0 && <div className="availability-empty">还没有可用时间。先告诉 AI 你每周什么时候能投入，Planner 才能排学习时段。</div>}
        {sortedRows.map((row, i) => (
          <div className={`availability-row ${row.title ? "is-busy" : ""}`} key={`${row.weekday}-${row.startTime}-${row.title}`}>
            <span className="availability-weekday">{WEEKDAY_LABELS[row.weekday]}</span>
            <span className="availability-time">{row.startTime}–{row.endTime}</span>
            <span className="availability-type">{row.title ? row.title : "可安排"}</span>
            <button className="availability-remove" aria-label={`删除 ${WEEKDAY_LABELS[row.weekday]} ${row.startTime}-${row.endTime}`} onClick={() => removeRow(i)}>×</button>
          </div>
        ))}
      </div>
      <div className="availability-add">
        <select value={wd} onChange={(e) => setWd(Number(e.target.value))} aria-label="周几">{WEEKDAY_LABELS.map((label, i) => <option key={label} value={i}>{label}</option>)}</select>
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="开始时间" />
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="结束时间" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标签（可空 = 可排空档）" aria-label="标签" />
        <button className="quiet-button availability-add-btn" disabled={!start || !end || end <= start} title={start && end && end <= start ? "结束时间必须晚于开始时间" : "添加"} onClick={() => { if (start && end && end > start) addRow(wd, start, end, title.trim()); }}>添加</button>
      </div>
      <div className="availability-tools">
        <button className="quiet-button" onClick={addPreset}>快捷预设：工作日 19:00-22:00 学习</button>
        {touched && <button className="text-button" onClick={() => { setTitle(""); setStart("19:00"); setEnd("21:00"); setTouched(false); }}>已自动保存 ✓</button>}
      </div>
    </section>
  );
}

/** Planner 建议弹层（Step3；关闭即清会话 = 验收 C；accept 才写库） */
function PlannerModal({ session, busy, hasReflections, onClose, onAccept, onReplan, onKeepExisting, onGoAvailability }: {
  session: PlanSession;
  busy: boolean;
  hasReflections: boolean;
  onClose: () => void;
  onAccept: () => void;
  onReplan: () => void;
  onKeepExisting: () => void;
  onGoAvailability: () => void;
}) {
  const { goal, step, data, error } = session;
  const verdictLabel: Record<string, string> = { "on-track": "节奏合适", tight: "有压力", risk: "风险提示" };
  return (
    <div className="quiz-overlay" role="dialog" aria-modal="true" aria-label="计划建议">
      <button className="quiz-overlay-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="quiz-overlay-dialog plan-dialog">
        <div className="quiz-overlay-toolbar"><span>计划建议 · {goal.title}</span><button className="quiz-close-button" onClick={onClose}><X size={15} /> 关闭</button></div>

        {step === "loading" && <div className="plan-loading">正在生成未来 14 天的排程建议…</div>}

        {step === "ask-replan" && (
          <div className="plan-replan">
            <h3>已存在安排计划</h3>
            <p>「{goal.title}」已有阶段被安排过。重新规划会先撤销现有 AI 排程（行动路线与手动日程不受影响），再按当前可用时间重新生成建议。</p>
            <div className="plan-dialog-actions">
              <button className="primary-button" disabled={busy} onClick={onReplan}>{busy ? "处理中…" : "重新规划"} <RotateCcw size={14} /></button>
              <button className="quiet-button" onClick={onKeepExisting}>查看已有安排（保留）</button>
            </div>
          </div>
        )}

        {step === "blocked" && data && (
          <div className="plan-blocked">
            <p>{data.message || "暂时无法排程"}</p>
            <div className="plan-dialog-actions">
              {data.blocked === "no-availability" && <button className="primary-button" onClick={onGoAvailability}>去设置可用时间</button>}
              <button className="quiet-button" onClick={onClose}>知道了</button>
            </div>
          </div>
        )}

        {step === "error" && (
          <div className="plan-blocked"><p>{error || "出错了，请重试"}</p><div className="plan-dialog-actions"><button className="quiet-button" onClick={onClose}>关闭</button></div></div>
        )}

        {step === "preview" && data && (
          <div className="plan-preview">
            <div className={`plan-feasibility verdict-${data.feasibility?.verdict ?? "risk"}`}>
              <div className="plan-feasibility-msg">
                <span className={`plan-verdict-badge v-${data.feasibility?.verdict ?? "risk"}`}>{verdictLabel[data.feasibility?.verdict ?? "risk"]}</span>
                <p>{data.feasibility?.message}</p>
              </div>
              <div className="plan-meta">
                <span>总投入 {formatActionMinutes(data.feasibility?.totalMinutes ?? 0)}</span>
                <span>剩余 {data.feasibility?.remainingDays ?? "-"} 天</span>
                {typeof data.feasibility?.weeksNeeded === "number" && <span>预计约 {data.feasibility.weeksNeeded} 周</span>}
              </div>
            </div>
            <div className="plan-source-note">{data.source === "llm" ? "AI 已给出执行顺序建议" : "按依赖与优先级规则排序"}</div>
            {hasReflections && <div className="plan-ref-note">AI 会参考你的历史反馈调整建议。</div>}
            <div className="plan-day-list">
              {(() => {
                const groups = new Map<string, PlanItemDraft[]>();
                for (const it of data.items) {
                  const list = groups.get(it.date) ?? [];
                  list.push(it);
                  groups.set(it.date, list);
                }
                return [...groups.entries()].map(([date, its]) => (
                  <div className="plan-day-group" key={date}>
                    <div className="plan-day-head"><strong>{formatPlanDate(date)}</strong><span>{its.length} 个时段</span></div>
                    {its.map((it, i) => (
                      <div className="plan-item" key={`${it.actionId}-${i}`}>
                        <span className="plan-item-time">{it.startTime}–{it.endTime}</span>
                        <span className="plan-item-title">{it.title}</span>
                      </div>
                    ))}
                  </div>
                ));
              })()}
            </div>
            {data.remainingMinutes && Object.values(data.remainingMinutes).some((v) => v > 0) && (
              <div className="plan-remain-note">部分阶段超出 14 天窗口，将按此节奏后续续排。</div>
            )}
            <div className="plan-dialog-actions">
              <button className="primary-button" disabled={busy} onClick={onAccept}>{busy ? "安排中…" : `接受计划（${data.items.length} 个时段）`} <Check size={14} /></button>
              <button className="quiet-button" onClick={onClose}>再看看</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function evidenceLabel(evidence: "输入" | "输入 + 输出" | "应用") {
  if (evidence === "应用") return "实际应用";
  if (evidence === "输入 + 输出") return "理解回应";
  return "行动记录";
}

function RecordsPanel({ logs, input, setInput, recordMinutes, setRecordMinutes, recordOutput, setRecordOutput, inputRef, onSubmit, onGenerateQuiz, onBackToToday }: { logs: LogEntry[]; input: string; setInput: React.Dispatch<React.SetStateAction<string>>; recordMinutes: string; setRecordMinutes: React.Dispatch<React.SetStateAction<string>>; recordOutput: string; setRecordOutput: React.Dispatch<React.SetStateAction<string>>; inputRef: React.RefObject<HTMLTextAreaElement | null>; onSubmit: () => void; onGenerateQuiz: (log: LogEntry) => void; onBackToToday: () => void }) {
  const totalXp = demoSeed.learningLogs.reduce((total, log) => total + log.xp, 0) + logs.reduce((total, log) => total + log.xp, 0);
  return <div className="workspace-page">
    <WorkspaceHeader eyebrow="EVIDENCE LOG" title="成长记录" description="把今天发生的事放在同一条可回看的时间线上，晚报时再统一回顾。" onBackToToday={onBackToToday} />
    <div className="records-layout">
      <section className="panel records-main"><div className="panel-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>最近发生了什么</h2></div><span className="count-badge">{demoSeed.learningLogs.length + logs.length} 条记录</span></div><div className="record-list">
        {logs.map((log) => <article className="record-item record-item-live" key={log.id}><div className="record-date"><strong>{log.createdAt}</strong><span>新增</span></div><div className="record-marker"><span /></div><div className="record-body"><div className="record-topline"><h3>{log.topic}</h3><span className="record-reward">+{log.xp} XP · +{log.coin} coin</span></div><p>{log.text}</p><div className="record-tags">{log.kind && <span className={`record-kind-tag kind-${log.kind}`}>{taskKindLabel(log.kind)}</span>}<span>{log.intent === "plan_today" ? "计划" : log.intent === "review" ? "复盘" : log.output ? "已整理" : "已记录"}</span><span>{log.output ? `AI 摘要：${log.output}` : log.mode === "pending" ? "AI 正在整理" : "等待晚报回顾"}</span>{typeof log.quizScore === "number" && <span>理解 {log.quizScore} 分</span>}</div>{log.output && <button className="record-quiz-button" onClick={() => onGenerateQuiz(log)}>再测一次 <ChevronRight size={13} /></button>}</div></article>)}
        {demoSeed.learningLogs.map((log) => <article className="record-item" key={log.id}><div className="record-date"><strong>{log.occurredAt.split(" ")[0]}</strong><span>{log.occurredAt.split(" ").slice(1).join(" ")}</span></div><div className="record-marker"><span /></div><div className="record-body"><div className="record-topline"><h3>{log.topic}</h3><span className="record-reward">+{log.xp} XP · +{log.coin} coin</span></div><p>{log.summary}</p><div className="record-tags"><span>{evidenceLabel(log.evidence)}</span><span>{log.duration}</span></div></div></article>)}
      </div></section>
      <aside className="records-side"><section className="panel quick-record-panel"><div className="panel-heading"><div><span className="eyebrow">QUICK NOTE</span><h2>随手记一笔</h2></div><BookOpen size={18} className="panel-icon" /></div><p className="panel-desc">记录任何今天发生的事，不用先分类或整理。晚报时 AI 会把几条记录合在一起统一提问。</p><div className="input-label">今天发生了什么？ <span>学习、运动、生活、休息都可以</span></div><div className="log-input-wrap"><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：读了行动设计的一节内容，下午走了 20 分钟……" rows={6} /></div><div className="ai-record-fields"><input type="number" min={0} max={1440} value={recordMinutes} onChange={(event) => setRecordMinutes(event.target.value)} placeholder="时长（分钟，可选）" aria-label="记录时长（分钟）" /><input value={recordOutput} onChange={(event) => setRecordOutput(event.target.value)} placeholder="产出 / 结果（可选）" aria-label="记录产出" /></div><div className="input-actions"><span>{input.length}/480</span><button className="send-button" onClick={onSubmit} disabled={!input.trim()}>保存记录 <ArrowUpRight size={15} /></button></div><div className="record-total"><span>本组已获得</span><strong>{totalXp} XP</strong></div></section><section className="panel ledger-panel"><div className="panel-heading"><div><span className="eyebrow">LEDGER</span><h2>最近结算</h2></div><ReceiptText size={18} className="panel-icon" /></div><div className="ledger-list">{demoSeed.ledger.map((entry) => <div className="ledger-item" key={entry.id}><div className={`ledger-icon ${entry.account === "XP" ? "ledger-xp" : "ledger-coin"}`}>{entry.account === "XP" ? <Sparkles size={14} /> : <WalletCards size={14} />}</div><div><strong>{entry.reason}</strong><span>{entry.occurredAt}</span></div><em>+{entry.amount} {entry.account}</em></div>)}</div></section></aside>
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

type GrowthStats = { weeklyMinutes?: Array<{ day: string; value: number; label: string }>; evidence?: { input: number; understanding: number; application: number }; activeDays?: number } | null;

function GrowthPanel({ growthStats, goals, onBackToToday }: { growthStats: GrowthStats; goals: PlanGoal[]; onBackToToday: () => void }) {
  const weekly = growthStats?.weeklyMinutes ?? [];
  const totalMinutes = weekly.reduce((sum, bar) => sum + bar.value, 0);
  const applicationCount = growthStats?.evidence?.application ?? 0;
  const understandingCount = growthStats?.evidence?.understanding ?? 0;
  const inputCount = growthStats?.evidence?.input ?? 0;
  const streak = growthStats?.activeDays ?? 0;
  const xpBalance = demoSeed.user.xpBalance;
  const currentLevel = Math.floor(xpBalance / 100) + 1;
  const nextLevelXp = 100 - (xpBalance % 100);
  const hasData = totalMinutes > 0 || inputCount > 0 || understandingCount > 0 || applicationCount > 0 || streak > 0;
  const evidenceTotal = Math.max(1, inputCount + understandingCount + applicationCount);

  if (!hasData) {
    return <div className="workspace-page">
      <WorkspaceHeader eyebrow="GROWTH DASHBOARD" title="成长仪表盘" description="不把自己压缩成一个分数，只看节奏、证据和下一轮实验。" onBackToToday={onBackToToday} />
      <div className="panel growth-empty-panel">
        <div className="growth-empty-icon"><Sparkles size={22} /></div>
        <h3>还没有成长数据</h3>
        <p>写下今天的第一条行动记录，这里就会出现你的节奏、投入和证据。</p>
        <button className="primary-button" onClick={onBackToToday}>去记录第一条 <ArrowUpRight size={15} /></button>
      </div>
    </div>;
  }

  return <div className="workspace-page">
    <WorkspaceHeader eyebrow="GROWTH DASHBOARD" title="成长仪表盘" description="不把自己压缩成一个分数，只看节奏、证据和下一轮实验。" onBackToToday={onBackToToday} />
    <div className="growth-metrics"><article className="metric-card metric-coral"><span className="metric-label">有效行动日</span><strong>{streak}<small> 天</small></strong><p>连续记录节奏</p></article><article className="metric-card metric-navy"><span className="metric-label">本周投入</span><strong>{Math.floor(totalMinutes / 60)}<small>h</small> {totalMinutes % 60}<small>m</small></strong><p>7 天累计专注时长</p></article><article className="metric-card metric-sage"><span className="metric-label">掌握证据</span><strong>{applicationCount + understandingCount}<small> 条</small></strong><p>理解 + 应用形成证据</p></article><article className="metric-card metric-paper"><span className="metric-label">成长等级</span><strong>Lv.{String(currentLevel).padStart(2, "0")}</strong><p>{demoSeed.user.role} · 距离升级 {nextLevelXp} XP</p></article></div>
    <div className="growth-layout"><section className="panel growth-chart-panel"><div className="panel-heading"><div><span className="eyebrow">RHYTHM TREND</span><h2>近 7 天投入节奏</h2></div><span className="trend-chip"><ArrowUpRight size={13} /> 真实投入</span></div><div className="growth-chart">{weekly.map((bar, index) => <div className="growth-bar-column" key={bar.day}><span className="growth-bar-value">{bar.value > 0 ? bar.label : "—"}</span><div className="growth-bar-track"><span className={index === 3 ? "highlight" : ""} style={{ height: `${Math.min(100, bar.value)}%` }} /></div><span>{bar.day.slice(5)}</span></div>)}</div><div className="chart-caption"><span><i className="legend-dot" /> 有效专注时长</span><strong>按你的记录累计</strong></div></section><section className="panel evidence-panel"><div className="panel-heading"><div><span className="eyebrow">EVIDENCE MIX</span><h2>进步由什么组成</h2></div><BarChart3 size={18} className="panel-icon" /></div><div className="evidence-row"><div className="evidence-label"><span>行动记录</span><strong>{inputCount} 条</strong></div><div className="evidence-track"><span style={{ width: `${(inputCount / evidenceTotal) * 100}%` }} /></div></div><div className="evidence-row"><div className="evidence-label"><span>理解回应</span><strong>{understandingCount} 条</strong></div><div className="evidence-track"><span className="evidence-green" style={{ width: `${(understandingCount / evidenceTotal) * 100}%` }} /></div></div><div className="evidence-row"><div className="evidence-label"><span>实际应用</span><strong>{applicationCount} 条</strong></div><div className="evidence-track"><span className="evidence-gold" style={{ width: `${(applicationCount / evidenceTotal) * 100}%` }} /></div><p className="evidence-note"><Sparkles size={13} /> 理解来自测验 ≥60 分，应用来自完成任务。</p></div></section></div>
    <section className="panel goal-progress-panel"><div className="panel-heading"><div><span className="eyebrow">GOAL PROGRESS</span><h2>目标的真实进度</h2></div><span className="count-badge">只比较自己的基线</span></div><div className="growth-goal-list">{(goals.length > 0 ? goals : demoSeed.goals).map((goal) => <div className="growth-goal" key={goal.id}><div className="growth-goal-heading"><div><strong>{goal.title}</strong><span>{goal.description}</span></div><em>{goal.progress}%</em></div><div className="goal-progress"><span style={{ width: `${goal.progress}%` }} /></div><div className="growth-goal-footer"><span>{goal.horizon || "未设周期"}</span><span>{goal.status}</span></div></div>)}</div></section>
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
