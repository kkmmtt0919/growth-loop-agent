/**
 * Rule Scheduler（Smart Planner Step 3）——纯函数，无 DB / 无副作用。
 * 定位（冻结设计 §2.3 + 开发规范③）：LLM 只出「顺序/工作量/周建议」，**精确 slot 由这里规则排**，
 * 保证：不重叠、只落在用户可排空档（title=''）、跳过固定块（title≠''）、单段 ≤90min、不跨天。
 * 第一版 = 简单贪心（最近可用 slot 即排，不做全局最优/回溯/碎片优化）。
 */

import { dateMinusDays } from "./time";

/** 模板行：busy=false（title=''）= 可排自由时间；busy=true（title≠''）= 固定块，需从可排时间中扣除 */
export type TemplateSlotRow = { weekday: number; startMin: number; endMin: number; busy: boolean };

/** 排程项（Preview / accept 回传体） */
export type PlanItemDraft = {
  actionId: string;
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
};

export type GreedyResult = {
  items: PlanItemDraft[];
  /** actionId → 未排完的剩余分钟（>0 表示超出窗口，Preview 提示续排） */
  remainingByAction: Map<string, number>;
};

/** 日期（YYYY-MM-DD，Asia/Shanghai 语义）→ 周几（0=周一 … 6=周日），UTC 解析防时区漂移 */
export function dateToDbWeekday(dateStr: string): number {
  const jsDay = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=周日 … 6=周六
  return (jsDay + 6) % 7; // 周一 → 0 … 周日 → 6
}

export function hmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function minToHm(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

function mergeSegs(segs: Array<{ startMin: number; endMin: number }>): Array<{ startMin: number; endMin: number }> {
  const sorted = segs.slice().sort((a, b) => a.startMin - b.startMin);
  const merged: Array<{ startMin: number; endMin: number }> = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (last && seg.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, seg.endMin);
    } else {
      merged.push({ startMin: seg.startMin, endMin: seg.endMin });
    }
  }
  return merged;
}

/** 从自由区间中扣除 busy 固定块（如空档 19-22 里扣除会议 20-21 → 剩 19-20、21-22） */
function subtractBusy(free: Array<{ startMin: number; endMin: number }>, busy: Array<{ startMin: number; endMin: number }>): Array<{ startMin: number; endMin: number }> {
  let result = free.map((s) => ({ ...s }));
  for (const b of busy) {
    const next: Array<{ startMin: number; endMin: number }> = [];
    for (const s of result) {
      if (b.endMin <= s.startMin || b.startMin >= s.endMin) {
        next.push(s); // 不相交，保留
        continue;
      }
      if (b.startMin > s.startMin) next.push({ startMin: s.startMin, endMin: Math.min(b.startMin, s.endMin) });
      if (b.endMin < s.endMin) next.push({ startMin: Math.max(b.endMin, s.startMin), endMin: s.endMin });
    }
    result = next;
  }
  return result.filter((s) => s.endMin - s.startMin >= 1);
}

/**
 * 把模板按 fromDate 起 days 天展开为每日「净可排空档」：
 * 自由区间（busy=false）先合并，再逐个扣除当日固定块（busy=true）——保证不会排进会议/课程里。
 */
export function expandFreeSlots(template: TemplateSlotRow[], fromDate: string, days: number): Map<string, Array<{ startMin: number; endMin: number }>> {
  const freeBy = new Map<number, Array<{ startMin: number; endMin: number }>>();
  const busyBy = new Map<number, Array<{ startMin: number; endMin: number }>>();
  for (const row of template) {
    if (row.endMin <= row.startMin) continue;
    const bucket = row.busy ? busyBy : freeBy;
    const list = bucket.get(row.weekday) ?? [];
    list.push({ startMin: row.startMin, endMin: row.endMin });
    bucket.set(row.weekday, list);
  }
  const result = new Map<string, Array<{ startMin: number; endMin: number }>>();
  for (let i = 0; i < days; i++) {
    const date = dateMinusDays(fromDate, -i);
    const weekday = dateToDbWeekday(date);
    const free = mergeSegs(freeBy.get(weekday) ?? []);
    if (free.length === 0) continue;
    const busy = mergeSegs(busyBy.get(weekday) ?? []);
    const net = busy.length > 0 ? subtractBusy(free, busy) : free;
    if (net.length > 0) result.set(date, net);
  }
  return result;
}

/**
 * 简单贪心排程：按传入 order 逐个阶段填充未来空档。
 * 单段 = min(剩余, 空档余量, maxChunkMinutes)；填完一段空档起点前移；同天可多段；不跨天。
 */
export function greedySchedule(input: {
  /** 已按执行序排好的待排阶段（LLM 拓扑校正后；estimatedMinutes = 阶段总投入） */
  actions: Array<{ id: string; title: string; estimatedMinutes: number }>;
  /** expandFreeSlots 产物：date → 当日可用区间 */
  freeSlots: Map<string, Array<{ startMin: number; endMin: number }>>;
  /** 单段上限（默认 90 分钟） */
  maxChunkMinutes?: number;
}): GreedyResult {
  const maxChunk = input.maxChunkMinutes ?? 90;
  const items: PlanItemDraft[] = [];
  const remainingByAction = new Map<string, number>();
  const dates = [...input.freeSlots.keys()].sort();

  // 每个 date 的空档使用游标（已消耗分钟）
  const used = new Map<string, number[]>(); // date -> used[i] 对应 freeSlots 该日第 i 段起点偏移
  const initUsed = (date: string) => {
    if (!used.has(date)) used.set(date, input.freeSlots.get(date)!.map(() => 0));
  };

  for (const action of input.actions) {
    let remain = Math.max(0, Math.round(action.estimatedMinutes));
    if (remain <= 0) {
      remainingByAction.set(action.id, 0);
      continue;
    }
    for (const date of dates) {
      if (remain <= 0) break;
      initUsed(date);
      const segs = input.freeSlots.get(date)!;
      for (let idx = 0; idx < segs.length && remain > 0; idx++) {
        const seg = segs[idx];
        const cursor = used.get(date)![idx];
        const segFree = seg.endMin - seg.startMin - cursor;
        if (segFree < 1) continue;
        const chunk = Math.min(remain, segFree, maxChunk);
        if (chunk < 1) continue;
        const startMin = seg.startMin + cursor;
        items.push({
          actionId: action.id,
          title: action.title,
          date,
          startTime: minToHm(startMin),
          endTime: minToHm(startMin + chunk),
        });
        used.get(date)![idx] = cursor + chunk;
        remain -= chunk;
      }
    }
    remainingByAction.set(action.id, remain);
  }

  items.sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
  return { items, remainingByAction };
}
