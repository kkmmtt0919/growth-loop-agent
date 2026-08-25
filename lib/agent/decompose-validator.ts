/**
 * Quality Validator（Agent Decompose V1）——确定性规则层，不做无限重试。
 * 检查：title 非空 ≤40 / description 非空 / estimatedMinutes 5-240 / 大目标词 blacklist /
 *       与已有任务标题重复（normalized compare + Levenshtein）。
 * 处理：不合格步丢弃；全部被过滤 → 由调用方走带反馈重试/规则回退（本模块只负责判定与丢弃）。
 */

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
