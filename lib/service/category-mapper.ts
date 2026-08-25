import type { DbTask } from "@/lib/repo/types";

/**
 * Category Mapper（Agent Decompose V1）。
 * 语义层（Agent 输出的 category，未来可自由扩展）→ 系统层（tasks.kind 固定 5 值）。
 * 独立模块而不是 service 里的 if/else：新增 category 只改映射表，不污染业务代码。
 */

export const CATEGORY_TO_KIND: Record<string, DbTask["kind"]> = {
  learning: "learn",
  exercise: "exercise",
  coding: "focus",
  reading: "learn",
  creative: "focus",
  life: "life",
  rest: "rest",
  other: "focus",
};

/** 未知 category 一律 fallback "focus"（永远合法，前端 kind-* 样式稳定） */
export function mapCategoryToKind(category: string | undefined | null): DbTask["kind"] {
  const key = category?.toLowerCase().trim() ?? "";
  return CATEGORY_TO_KIND[key] ?? "focus";
}
