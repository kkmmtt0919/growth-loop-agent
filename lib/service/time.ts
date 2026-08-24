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
