/**
 * 服务端统一时间口径（Asia/Shanghai）。
 * 与既有 evening.ts 的 todayInShanghai 保持一致；调度器/Context/状态接口共用。
 */

/** 上海时区的今天，格式 YYYY-MM-DD（不依赖服务器本地时区） */
export function todayInShanghai(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 上海时区当前 HH:MM（如 "21:30"） */
export function nowHmShanghai(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/** 晚报生成时间（环境变量 REPORT_TIME=HH:MM，默认 21:30；解析失败用默认） */
export function readReportTime(): string {
  const value = process.env.REPORT_TIME?.trim();
  return value && /^\d{1,2}:\d{2}$/.test(value) ? value : "21:30";
}

/** 日期往前/后偏移 N 天（YYYY-MM-DD） */
export function dateMinusDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * 滚动快照起点：取所在周的周一（ISO 周一为一周开始）。
 * 用 UTC 语义计算偏移避免时区漂移（输入已是 Asia/Shanghai 的 YYYY-MM-DD）。
 */
export function weekStartOf(dateStr: string): string {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=周日,1=周一..6=周六
  const offset = day === 0 ? 6 : day - 1; // 周一偏移 0，周日偏移 6
  return dateMinusDays(dateStr, offset);
}

/** 滚动快照终点：起点 + 6 天（周日） */
export function weekEndOf(periodStart: string): string {
  return dateMinusDays(periodStart, -6);
}
