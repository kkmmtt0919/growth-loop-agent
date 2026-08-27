/**
 * 意图识别（Phase 1）。
 * 纯函数实现已抽离到 lib/agent/core/pure.ts，本文件仅 re-export 保持对外 API 不变。
 */

export {
  parseAction,
  buildActionReply,
} from "./core/pure";
export type {
  ParsedIntent,
  LearningTrack,
  ActionKind,
  LearningGuide,
  ParsedAction,
  PreviousAction,
} from "./core/pure";
