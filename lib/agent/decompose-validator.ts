/**
 * Quality Validator（Agent Decompose V1）——确定性规则层，不做无限重试。
 * 纯函数实现已抽离到 lib/agent/core/pure.ts，本文件仅 re-export 保持对外 API 不变。
 */

export {
  BIG_GOAL_WORDS,
  normalizeTitle,
  levenshtein,
  isTitleDuplicate,
  validateStep,
  validateSteps,
} from "./core/pure";
export type {
  DecomposeStep,
  ValidateResult,
} from "./core/pure";
