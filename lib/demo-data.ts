/**
 * 按上海时区返回今天的中文日期标签（如 "2026 年 8 月 22 日"）。
 * 前后端共用：服务端 profile 映射与前端顶部日期戳都从这里取真实时间，
 * 不再使用写死的 demo 日期。
 */
export function todayShanghaiDateLabel(): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")} 年 ${get("month")} 月 ${get("day")} 日`;
}

/** 按上海时区返回今天的中文星期标签（如 "星期六"）。 */
export function todayShanghaiWeekdayLabel(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
  }).format(new Date());
}

export type TaskKind = "focus" | "learn" | "exercise" | "life" | "rest";

export type Task = {
  id: string;
  title: string;
  subtitle: string;
  time: string;
  duration: string;
  xp: number;
  coin: number;
  status: "done" | "current" | "upcoming";
  kind: TaskKind;
};

export type LearningLog = {
  id: string;
  topic: string;
  summary: string;
  duration: string;
  xp: number;
  coin: number;
  evidence: "输入" | "输入 + 输出" | "应用";
  occurredAt: string;
};

export type Goal = {
  id: string;
  title: string;
  description: string;
  progress: number;
  horizon: string;
  status: "进行中" | "待复盘";
};

export type LedgerEntry = {
  id: string;
  account: "XP" | "COIN";
  amount: number;
  reason: string;
  occurredAt: string;
};

export type DemoSeed = {
  seedVersion: string;
  user: {
    displayName: string;
    level: number;
    role: string;
    streak: number;
    focusScore: number;
    xpBalance: number;
    coinBalance: number;
    dateLabel: string;
    weekdayLabel: string;
  };
  goals: Goal[];
  tasks: Task[];
  learningLogs: LearningLog[];
  ledger: LedgerEntry[];
  weeklyBars: Array<{ day: string; value: number; label: string }>;
  insight: string;
  quote: string;
};

/**
 * 可复用的本地种子数据：页面、API 与后续数据库 seed 都从这里读取。
 * 这些是虚构测试数据，不代表真实用户内容。
 */
export const demoSeed: DemoSeed = {
  seedVersion: "2026-08-10.v2",
  user: {
    displayName: "周予安",
    level: 4,
    role: "探索者",
    streak: 6,
    focusScore: 76,
    xpBalance: 416,
    coinBalance: 312,
    dateLabel: "2026 年 8 月 9 日",
    weekdayLabel: "星期日",
  },
  goals: [
    {
      id: "goal-product",
      title: "把产品做成可用的每日回路",
      description: "完成今日工作台、Agent 记录和第一轮用户验证",
      progress: 42,
      horizon: "4 周目标",
      status: "进行中",
    },
    {
      id: "goal-english",
      title: "建立英语听力的表达习惯",
      description: "每周 4 次听力，每次留下 3 个可复用表达",
      progress: 68,
      horizon: "8 周目标",
      status: "进行中",
    },
  ],
  tasks: [
    {
      id: "deep-work",
      title: "完成产品首页的第一版",
      subtitle: "把“今日行动”卡片做到可点击",
      time: "09:30",
      duration: "45 min",
      xp: 20,
      coin: 8,
      status: "current",
      kind: "focus",
    },
    {
      id: "english",
      title: "英语听力 · 第 12 课",
      subtitle: "听完后记 3 个可复用表达",
      time: "14:00",
      duration: "25 min",
      xp: 10,
      coin: 4,
      status: "upcoming",
      kind: "learn",
    },
    {
      id: "walk",
      title: "晚饭后散步",
      subtitle: "给大脑留一个换挡的空隙",
      time: "20:30",
      duration: "20 min",
      xp: 5,
      coin: 2,
      status: "upcoming",
      kind: "life",
    },
    {
      id: "stretch",
      title: "午后拉伸 · 肩颈与髋部",
      subtitle: "8 分钟舒展，给下午学习换档",
      time: "16:30",
      duration: "8 min",
      xp: 4,
      coin: 2,
      status: "upcoming",
      kind: "exercise",
    },
    {
      id: "wind-down",
      title: "睡前收束 · 关屏与呼吸",
      subtitle: "10 分钟放下屏幕，让大脑完成恢复",
      time: "22:30",
      duration: "10 min",
      xp: 5,
      coin: 2,
      status: "upcoming",
      kind: "rest",
    },
  ],
  learningLogs: [
    {
      id: "log-0808-english",
      topic: "英语听力 · 第 11 课",
      summary: "记下 3 个可复用表达，并复述了一遍",
      duration: "25 min",
      xp: 5,
      coin: 2,
      evidence: "输入 + 输出",
      occurredAt: "昨天 14:26",
    },
    {
      id: "log-0808-product",
      topic: "产品阅读 · 行动设计",
      summary: "写下两条页面决策，删除一个不必要的提醒入口",
      duration: "45 min",
      xp: 10,
      coin: 4,
      evidence: "应用",
      occurredAt: "昨天 09:58",
    },
    {
      id: "log-0809-review",
      topic: "晨间整理",
      summary: "确认今天的主任务，并把英语放到午后",
      duration: "10 min",
      xp: 5,
      coin: 2,
      evidence: "输入",
      occurredAt: "今天 08:42",
    },
  ],
  ledger: [
    { id: "ledger-xp-1", account: "XP", amount: 20, reason: "产品阅读 · 应用证据", occurredAt: "昨天 09:58" },
    { id: "ledger-xp-2", account: "XP", amount: 5, reason: "英语听力 · 理解记录", occurredAt: "昨天 14:26" },
    { id: "ledger-coin-1", account: "COIN", amount: 6, reason: "完成两次有效成长行动", occurredAt: "昨天 18:03" },
  ],
  weeklyBars: [
    { day: "一", value: 58, label: "58m" },
    { day: "二", value: 78, label: "78m" },
    { day: "三", value: 42, label: "42m" },
    { day: "四", value: 92, label: "92m" },
    { day: "五", value: 66, label: "66m" },
    { day: "六", value: 34, label: "34m" },
    { day: "日", value: 24, label: "24m" },
  ],
  insight: "你最近更容易在上午开始深度任务。把英语练习也放到午后，给大脑一个轻一点的入口。",
  quote: "稳定不是每天都做很多，而是知道什么时候把事情做小。",
};

export const initialTasks = demoSeed.tasks;
export const weeklyBars = demoSeed.weeklyBars;
