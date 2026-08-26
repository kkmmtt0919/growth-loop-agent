import type { Mood } from "@/lib/repo/types";

/** 心情枚举 → emoji 映射（DB 存英文枚举，前端展示 emoji） */
export const MOOD_OPTIONS: Array<{ value: Mood; emoji: string; label: string }> = [
  { value: "great", emoji: "😄", label: "很好" },
  { value: "good", emoji: "🙂", label: "不错" },
  { value: "normal", emoji: "😐", label: "一般" },
  { value: "bad", emoji: "😞", label: "不好" },
  { value: "terrible", emoji: "😣", label: "很差" },
];

const MOOD_EMOJI: Record<Mood, string> = Object.fromEntries(
  MOOD_OPTIONS.map((m) => [m.value, m.emoji]),
) as Record<Mood, string>;

/** 取 mood 对应 emoji，null/未知返回空串 */
export function moodEmoji(mood: Mood | null): string {
  return mood ? (MOOD_EMOJI[mood] ?? "") : "";
}

/** 取 mood 中文 label，未知返回空串 */
export function moodLabel(mood: Mood | null): string {
  if (!mood) return "";
  return MOOD_OPTIONS.find((m) => m.value === mood)?.label ?? "";
}
