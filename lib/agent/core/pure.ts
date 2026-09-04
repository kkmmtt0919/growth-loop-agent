/**
 * Pure Validation Boundary（Agent 纯函数层）。
 * 唯一允许的依赖：string / object / array。禁止 pg / env / API client。
 * 生产代码（generator）与 eval 都从这里 import，建立稳定、可离线回归的边界。
 *
 * 来源：understanding / decompose-validator / evening-generator / weekly-generator
 * 抽出后原文件仅做 re-export，对外 API 不变。
 */

// ============================================================================
// 1. 意图识别（原 understanding.ts）
// ============================================================================

export type ParsedIntent = "quick_log" | "plan_today" | "review";
export type LearningTrack = "ai_agent";
export type ActionKind = "focus" | "learn" | "exercise" | "life" | "rest";

export type LearningGuide = {
  track: LearningTrack;
  label: string;
  goal: string;
  stage: string;
  todaySteps: string[];
  outputPrompt: string;
  quizFocus: string[];
};

export type ParsedAction = {
  intent: ParsedIntent;
  kind: ActionKind;
  topic: string;
  goal?: string;
  track?: LearningTrack;
  guide?: LearningGuide;
  minutes?: number;
  output?: string;
  isCorrection: boolean;
  missing: string[];
  confidence: number;
};

export type PreviousAction = Pick<ParsedAction, "intent" | "kind" | "topic" | "goal" | "track" | "guide" | "minutes" | "output">;

const MINUTES_PATTERN = /(\d{1,3})\s*(?:分钟|分|min|m)/i;

function normalize(value: string | undefined) {
  return value?.replace(/\s+/g, " ").replace(/^[，,。；;：:]+|[，,。；;：:]+$/g, "").trim();
}

function cleanOutput(value: string | undefined) {
  return normalize(value)?.replace(/(?:重新记录|记录下来|告诉我.*|还缺什么.*)$/g, "").trim();
}

function cleanTopic(value: string | undefined) {
  return normalize(value)
    ?.replace(/^(?:请|帮我|把|将|今天的|今天要做的|今天|我今天|我|刚刚|上一条|本次的)\s*/g, "")
    .replace(/(?:安排成|安排为|安排|计划做|计划|完成了|完成|做了|学习了|听了|读了|看了)\s*$/g, "")
    .trim();
}

function cleanGoal(value: string | undefined) {
  return normalize(value)?.replace(/^(?:我想|我希望|目标是|目标为|计划就是|计划是)\s*/g, "").trim();
}

function extractGoal(message: string) {
  const matched = message.match(/(?:目标(?:是|为)|计划(?:就是|是))\s*([^，,。；;\n]+?)(?=，|,|。|；|;|请|帮我|安排|规划|$)/i);
  return cleanGoal(matched?.[1]);
}

function inferTrack(message: string, goal: string | undefined, topic: string) {
  const source = `${message} ${goal || ""} ${topic}`;
  return /AI|人工智能|Agent|agent|智能体|大模型|LLM|RAG|提示词|工具调用|工作流/i.test(source) ? "ai_agent" as const : undefined;
}

function inferKind(message: string, topic: string, previous?: ActionKind): ActionKind {
  const source = `${message} ${topic}`;
  if (/运动|锻炼|健身|跑步|骑行|游泳|力量|拉伸|瑜伽|俯卧撑|深蹲|球类|训练/i.test(source)) return "exercise";
  if (/休息|睡眠|午睡|小憩|放松|冥想|呼吸|睡前|早睡|恢复|关屏/i.test(source)) return "rest";
  if (/生活|家务|吃饭|用餐|洗澡|散步|通勤|购物|家庭|日常|整理房间/i.test(source)) return "life";
  if (/学习|课程|阅读|听力|复习|记忆|看书|知识|AI|Agent|智能体|大模型|LLM|RAG|提示词|工具调用/i.test(source)) return "learn";
  return previous || "focus";
}

function buildLearningGuide(track: LearningTrack | undefined, goal: string | undefined, minutes?: number): LearningGuide | undefined {
  if (track !== "ai_agent") return undefined;
  const duration = minutes || 45;
  const buildMinutes = Math.max(10, duration - 25);
  const resolvedGoal = goal || "学习 Agent 并开发自己的 Agent";
  return {
    track,
    label: "AI Agent 学习路线",
    goal: resolvedGoal,
    stage: "从概念理解走到最小可运行闭环",
    todaySteps: [
      `10 分钟：明确 Agent 要解决的问题和成功标准`,
      `15 分钟：拆解 LLM、工具调用、状态/记忆和评估`,
      `${buildMinutes} 分钟：做一个最小闭环并留下可运行结果`,
    ],
    outputPrompt: "画出自己的 Agent 信息→决策→工具→结果流程，并写一个验收问题",
    quizFocus: ["Agent 与普通聊天的差异", "工具调用、状态和评估各自解决什么问题", "如何把目标收敛为最小可运行 Agent"],
  };
}

function extractMinutes(message: string) {
  const match = message.match(MINUTES_PATTERN);
  return match ? Number(match[1]) : undefined;
}

function extractOutput(message: string) {
  const marked = message.match(
    /(?:输出|成果|产出|留下|记下|要求留下)(?:了)?(?:是|为|：|:)?\s*([^，,。；;]+?)(?=[，,。；;]|$)/i,
  );
  if (marked?.[1]) return cleanOutput(marked[1]);

  const count = message.match(/\d{1,3}\s*(?:个|条)\s*[^，,。；;]+/i);
  return count?.[0] ? cleanOutput(count[0]) : undefined;
}

function extractTopic(message: string, isCorrection: boolean) {
  if (isCorrection) {
    const correction = message.match(
      /不是[^，,。；;]+[，,；;]\s*(?:而是|改成|是)\s*([^，,。；;]+?)(?=\d{1,3}\s*(?:分钟|分|min|m)|输出|成果|产出|留下|记下|并|$)/i,
    );
    if (correction?.[1]) return cleanTopic(correction[1]);

    const restated = message.match(/(?:按|改为|改成)\s*([^，,。；;]+?)(?=\d{1,3}\s*(?:分钟|分|min|m)|输出|成果|产出|留下|并|$)/i);
    if (restated?.[1]) return cleanTopic(restated[1]);
  }

  const planned = message.match(/(?:今天的|今天要做的|把|将)\s*([^，,。；;]+?)\s*安排(?:成|为)/i);
  if (planned?.[1]) return cleanTopic(planned[1]);

  const completed = message.match(
    /(?:完成了|完成|做了|学习了?|听了|读了|看了)\s*([^，,。；;\n]+?)(?=，|,|。|；|;|花了|用时|耗时|\d{1,3}\s*(?:分钟|分|min|m)|输出|成果|产出|留下|记下|并|$)/i,
  );
  if (completed?.[1]) return cleanTopic(completed[1]);

  const arranged = message.match(
    /(?:计划|安排)\s*(?:做|学习|完成)?\s*([^，,。；;]+?)(?=\d{1,3}\s*(?:分钟|分|min|m)|并|要求|输出|留下|$)/i,
  );
  if (arranged?.[1]) return cleanTopic(arranged[1]);

  const fallback = message
    .replace(/(?:请|帮我|今天|我|刚刚|更正上一条|更正一下|用户纠正|复盘今天|复盘这周)/g, "")
    .split(/[，,。；;]/)[0];
  return cleanTopic(fallback) || undefined;
}

function inferIntent(message: string, isCorrection: boolean, previous?: PreviousAction) {
  if (isCorrection && previous) return previous.intent;
  if (/复盘|回顾|总结今天|总结这周|进步/.test(message)) return "review" as const;
  if (/计划|安排|排进|规划/.test(message)) return "plan_today" as const;
  return "quick_log" as const;
}

export function parseAction(message: string, previous?: PreviousAction): ParsedAction {
  const isCorrection = /更正|纠正|改成|不是[^，,。；;]+[，,；;].*(?:而是|是)/.test(message);
  const intent = inferIntent(message, isCorrection, previous);
  const extractedGoal = extractGoal(message);
  const goal = extractedGoal || previous?.goal;
  const rawTopic = extractTopic(message, isCorrection) || previous?.topic || "今日行动";
  const kind = inferKind(message, rawTopic, previous?.kind);
  const track = inferTrack(message, goal, rawTopic) || previous?.track;
  const topic = track === "ai_agent" && (goal || /Agent|智能体/i.test(rawTopic)) ? "Agent 学习与开发" : rawTopic;
  const minutes = extractMinutes(message) ?? previous?.minutes;
  const output = extractOutput(message) ?? previous?.output;
  const missing: string[] = [];

  if (intent === "plan_today" && !minutes) missing.push("时长");
  if ((intent === "quick_log" || intent === "review") && !output) missing.push("结果记录");

  const knownFields = [topic !== "今日行动", Boolean(minutes), Boolean(output)].filter(Boolean).length;
  const guide = buildLearningGuide(track, goal, minutes);
  return {
    intent,
    kind,
    topic,
    goal,
    track,
    guide,
    minutes,
    output,
    isCorrection,
    missing,
    confidence: Math.min(0.98, 0.45 + knownFields * 0.18),
  };
}

export function buildActionReply(action: ParsedAction) {
  const duration = action.minutes ? `${action.minutes} 分钟` : "时长待定";
  const evidence = action.output ? `结果记录：${action.output}` : "还缺一条可核对的结果，晚报时再补充即可";
  const correctionPrefix = action.isCorrection ? "已按你的更正更新。" : "";

  if (action.intent === "review") {
    return `${correctionPrefix}晚报开始：我会把今天的记录合在一起，依次问你三件事——1）今天最重要的行动是什么？2）哪个地方真正被你理解或用上了？3）明天要延续的最小一步是什么？先从第一件开始。`;
  }

  if (action.guide) {
    const guide = action.guide;
    if (action.intent === "plan_today") {
      return `${correctionPrefix}已把「${guide.goal}」安排为 ${duration}。今天按三步推进：${guide.todaySteps.join("；")}。完成后留下：${guide.outputPrompt}。晚报时我会把今天的记录合起来回顾。`;
    }
    return `${correctionPrefix}已记录「${guide.goal}」${action.minutes ? ` · ${duration}` : ""}。下一步画出 Agent 的信息→决策→工具→结果，并留下一个可验证结果；晚报时再统一回顾。`;
  }

  if (action.intent === "plan_today") {
    return `${correctionPrefix}已安排：${action.topic} · ${duration}。完成后留下${action.output || "一条具体结果"}。${action.missing.length ? `还需要补：${action.missing.join("、")}。` : ""}`;
  }

  if (action.kind === "exercise") {
    return `${correctionPrefix}已记录运动行动「${action.topic}」${action.minutes ? ` · ${duration}` : ""}。先从可持续的强度开始，结束后记下身体感受或一个可观察结果。`;
  }

  if (action.kind === "rest") {
    return `${correctionPrefix}已记录休息行动「${action.topic}」${action.minutes ? ` · ${duration}` : ""}。把恢复当成计划的一部分，结束后只需记下一句精神状态变化。`;
  }

  if (action.kind === "life") {
    return `${correctionPrefix}已记录生活行动「${action.topic}」${action.minutes ? ` · ${duration}` : ""}。完成后留下一条事实或感受，让生活安排也能成为成长证据。`;
  }

  return `${correctionPrefix}已记录：${action.topic}${action.minutes ? ` · ${duration}` : ""}。${evidence}。下一步先保留这条事实，晚些时候再补充应用结果。`;
}

// ============================================================================
// 2. 拆解校验（原 decompose-validator.ts）
// ============================================================================

export type DecomposeStep = {
  order: number;
  title: string;
  description: string;
  acceptance: string;
  estimatedMinutes: number;
  category: string;
};

/** 大目标词黑名单：命中即判定该步过大、不可执行 */
export const BIG_GOAL_WORDS = [
  "掌握",
  "精通",
  "学完",
  "全面学习",
  "彻底理解",
  "完成整个课程",
  "学会全部",
];

/** 标题归一化：小写 + 去空格 + 去标点（用于语义近似判重） */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、；：！？,.!?;:'"“”‘’（）()《》<>【】\[\]-]/g, "");
}

/** Levenshtein 编辑距离（阈值比较用，标题 ≤40 字成本可忽略） */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** 与已有标题是否近似重复：归一化相等 / 包含 / 编辑距离 ≤ 3 */
export function isTitleDuplicate(candidate: string, existingTitles: string[]): boolean {
  const norm = normalizeTitle(candidate);
  if (!norm) return true;
  for (const existing of existingTitles) {
    const normExisting = normalizeTitle(existing);
    if (!normExisting) continue;
    if (norm === normExisting) return true;
    if (norm.length >= 4 && (norm.includes(normExisting) || normExisting.includes(norm))) return true;
    if (levenshtein(norm, normExisting) <= 3) return true;
  }
  return false;
}

export function validateStep(step: DecomposeStep, existingTitles: string[]): string | null {
  const title = step.title?.trim() ?? "";
  const description = step.description?.trim() ?? "";
  if (!title) return "title 为空";
  if (title.length > 40) return `title 超长（${title.length} > 40）`;
  if (!description) return "description 为空";
  if (!Number.isInteger(step.estimatedMinutes) || step.estimatedMinutes < 5 || step.estimatedMinutes > 240) {
    return `estimatedMinutes 不在 5-240（${step.estimatedMinutes}）`;
  }
  for (const word of BIG_GOAL_WORDS) {
    if (title.includes(word)) return `命中大目标词「${word}」`;
  }
  if (isTitleDuplicate(title, existingTitles)) return "与已有任务标题重复";
  return null;
}

export type ValidateResult = {
  validSteps: DecomposeStep[];
  issues: Array<{ order: number; reason: string }>;
};

/** 逐步校验并丢弃不合格步；返回合法步骤与问题清单（全部被过滤由调用方处理回退） */
export function validateSteps(steps: DecomposeStep[], existingTitles: string[]): ValidateResult {
  const validSteps: DecomposeStep[] = [];
  const issues: Array<{ order: number; reason: string }> = [];
  for (const step of steps) {
    const reason = validateStep(step, existingTitles);
    if (reason) {
      issues.push({ order: step.order, reason });
    } else {
      validSteps.push(step);
    }
  }
  return { validSteps, issues };
}

// ============================================================================
// 3. JSON 提取 + 晚报 schema（原 evening-generator.ts）
// ============================================================================

export type EveningContent = {
  summary: string;
  achievement: string[];
  problem: string[];
  suggestion: string[];
  evaluation: string;
};

/** Schema 校验：类型不符即失败（走规则回退） */
export function isEveningContent(value: unknown): value is EveningContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" &&
    Array.isArray(v.achievement) &&
    v.achievement.every((x) => typeof x === "string") &&
    Array.isArray(v.problem) &&
    v.problem.every((x) => typeof x === "string") &&
    Array.isArray(v.suggestion) &&
    v.suggestion.every((x) => typeof x === "string") &&
    typeof v.evaluation === "string"
  );
}

/** 从 LLM 回复中提取 JSON（容错：直接解析 → ```json 块 → 花括号区间） */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 忽略，尝试下一种
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // 忽略
    }
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // 忽略
    }
  }
  return null;
}

// ============================================================================
// 4. 周报 schema + 事实边界（原 weekly-generator.ts）
// ============================================================================

export const WEEKLY_SCHEMA_VERSION = 1;
export const MAX_GOAL_SUGGESTION_TITLE = 40;

/** 固定结构：LLM 不得自由发挥（v2 仅支持 update_title，archive 暂不支持） */
export type GoalSuggestion = {
  goalId: string;
  action: "update_title";
  newTitle: string;
  reason: string;
};

export type WeeklyStats = {
  periodStart: string;
  periodEnd: string;
  activeDays: number;
  recordCount: number;
  minutes: number;
  doneTasks: number;
  windowTotal: number;
  /** 计划执行率 = round(doneTasks / max(1, windowTotal) * 100) */
  completionRate: number;
  streak: number;
  goalProgress: Array<{
    goalId: string;
    title: string;
    status: string;
    progress: number;
    doneThisWeek: number;
  }>;
  vsPrevWeek: {
    recordCount: number;
    minutes: number;
    doneTasks: number;
    completionRate: number;
  };
};

export type WeeklyContent = {
  schemaVersion: number;
  stats: WeeklyStats;
  summary: string;
  achievement: string[];
  problem: string[];
  suggestion: string[];
  goalSuggestions: GoalSuggestion[];
  replySource: "llm" | "rules";
};

/** 纯函数：组装最终 content（stats 永远用规则值，只取 LLM 文字字段） */
export function buildWeeklyContent(
  stats: WeeklyStats,
  text: Pick<WeeklyContent, "summary" | "achievement" | "problem" | "suggestion">,
  goalSuggestions: GoalSuggestion[],
  replySource: "llm" | "rules",
): WeeklyContent {
  return {
    schemaVersion: WEEKLY_SCHEMA_VERSION,
    stats,
    summary: text.summary,
    achievement: text.achievement,
    problem: text.problem,
    suggestion: text.suggestion,
    goalSuggestions,
    replySource,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

/** UUID 合法性（goalId 将进入 SQL uuid 列，非法值会触发 string_to_uuid 异常，须在入库前过滤） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 单条建议结构校验（action 白名单 + goalId 必须是 UUID + newTitle 非空且 ≤40 字） */
export function isValidGoalSuggestion(value: unknown): value is GoalSuggestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.goalId === "string" &&
    UUID_RE.test(v.goalId) &&
    v.action === "update_title" &&
    typeof v.newTitle === "string" &&
    v.newTitle.trim().length > 0 &&
    v.newTitle.length <= MAX_GOAL_SUGGESTION_TITLE &&
    typeof v.reason === "string"
  );
}

/**
 * 服务端校验：LLM 原始对象 → 文字字段 + 合法建议。
 * 不合法的字段丢弃（summary 缺失则视为整体失败）；返回 null 表示应走规则回退。
 * 事实边界：只取文字字段，不透传未知字段（如 LLM 塞入的假 stats）。
 */
export function extractWeeklyText(raw: unknown): Pick<WeeklyContent, "summary" | "achievement" | "problem" | "suggestion"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.summary !== "string") return null;
  if (!isStringArray(v.achievement) || !isStringArray(v.problem) || !isStringArray(v.suggestion)) return null;
  return {
    summary: v.summary,
    achievement: v.achievement,
    problem: v.problem,
    suggestion: v.suggestion,
  };
}

// ============================================================================
// 5. 空上下文判定（Phase 6 新增，统一封装，供 evening/weekly/未来 Agent 复用）
// ============================================================================

/** 是否有值得生成报告的上下文（任一业务数据存在即为有意义） */
export function hasMeaningfulContext(c: { hasGoal: boolean; hasTasks: boolean; hasRecords: boolean }): boolean {
  return c.hasGoal || c.hasTasks || c.hasRecords;
}

// ============================================================================
// 6. ActionPlan（Smart Planner Step 2：目标 → 阶段级行动池）
// ============================================================================
// 语义（docs/DESIGN_SMART_PLANNER_STEP2.md §3，2026-09-04 用户定稿）：
//   - Action = 目标路线中的阶段节点（战略层），NOT 今日任务（战术层走旧 Decompose）
//   - estimatedMinutes = **完成整个 Action 阶段预计总投入**，30-3000；
//     30min 以下应进 Task，>3000min（50h）说明阶段过粗需再拆（LLM feedback 重试）
//   - dependsOnTitles 显式依赖（多对多）；无 order/category/acceptance
//   - 数量 3-6：由 actionStageRange 按剩余天数分档，不让模型自由发挥

/** Action 阶段行（LLM 原始产物 / 校验对象 / 前端展示同构） */
export type ActionStep = {
  title: string;
  description: string | null;
  estimatedMinutes: number;
  /** 1 最高 → 10 最低 */
  priority: number;
  /** 前置阶段标题（必须与同批其它 step 的 title 精确一致，否则解析时丢弃） */
  dependsOnTitles: string[];
};

/** Action 阶段数量分档（D2 定稿）：短 <2 周 → 3；中 2 周-3 个月 → 4；长期 >3 个月 → 5-6 */
export function actionStageRange(remainingDays: number): { min: number; max: number } {
  if (remainingDays < 14) return { min: 3, max: 3 };
  if (remainingDays <= 90) return { min: 4, max: 4 };
  return { min: 5, max: 6 };
}

export type ActionValidateIssue = { index: number; reason: string };

/** 单步校验：返回 issue 原因（null = 合格）。不抛异常，宽容优先。 */
function validateActionStep(step: ActionStep, goalTitle: string, existingTitles: string[]): string | null {
  const title = step.title?.trim() ?? "";
  if (!title) return "title 为空";
  if (title.length > 60) return `title 超长（${title.length} > 60）`;
  // 整目标当阶段（如把「完成毕业论文」整个当作阶段）→ 硬拒（feedback 要求细分）
  const normTitle = normalizeTitle(title);
  const normGoal = normalizeTitle(goalTitle);
  if (normGoal && normTitle && (normTitle === normGoal || normTitle.includes(normGoal) || normGoal.includes(normTitle))) {
    return "阶段与整目标重复，需细分为目标内的具体阶段";
  }
  if (!Number.isInteger(step.estimatedMinutes) || step.estimatedMinutes < 30 || step.estimatedMinutes > 3000) {
    return `estimatedMinutes 应在 30-3000（当前 ${step.estimatedMinutes}）——代表完成整个阶段的总投入，不是单次执行时长`;
  }
  if (!Number.isInteger(step.priority) || step.priority < 1 || step.priority > 10) {
    return `priority 应在 1-10（当前 ${step.priority}）`;
  }
  if (isTitleDuplicate(title, existingTitles)) return "与已有行动阶段标题重复";
  return null;
}

/** 整批校验：过滤不合格步 + 返回全部 issue（供 LLM feedback 重试）。合法步数量由调用方按 range 判定 */
export function validateActionSteps(
  steps: ActionStep[],
  goalTitle: string,
  existingTitles: string[],
): { validSteps: ActionStep[]; issues: ActionValidateIssue[] } {
  const validSteps: ActionStep[] = [];
  const issues: ActionValidateIssue[] = [];
  steps.forEach((step, index) => {
    const reason = validateActionStep(step, goalTitle, existingTitles);
    if (reason) {
      issues.push({ index, reason });
      return;
    }
    const cleaned: ActionStep = {
      title: step.title.trim(),
      description: typeof step.description === "string" && step.description.trim() ? step.description.trim() : null,
      estimatedMinutes: step.estimatedMinutes,
      priority: step.priority,
      dependsOnTitles: Array.isArray(step.dependsOnTitles)
        ? step.dependsOnTitles.map((d) => d.trim()).filter((d) => d && d !== step.title)
        : [],
    };
    validSteps.push(cleaned);
  });
  return { validSteps, issues };
}
