/**
 * Rule Scheduler 排程约束离线评测（Step 6b Evaluation 2 / 验收 10、12）。
 * 只测确定性规则（planner-scheduler 纯函数，无 DB）：expandFreeSlots（自由区间扣固定块）+
 * greedySchedule（贪心）。断言任何产出的 slot 都满足：
 *   availability 范围内 + 不与 fixed block 冲突 + 同天互不重叠 + 单段 ≤90min 不跨天。
 */
import {
  expandFreeSlots,
  greedySchedule,
  dateToDbWeekday,
  hmToMin,
  type TemplateSlotRow,
} from "../../lib/service/planner-scheduler";
import { assert, assertEq } from "../assert";

export type Case = { name: string; fn: () => void };

const MON = "2026-09-07"; // 周一（2026-09-05 周六、09-06 周日、09-07 周一）
const MAX = 90;

/** 断言 fixture 前提：日期/周几对齐 */
function assertFixture() {
  assertEq(dateToDbWeekday(MON), 0, "2026-09-07 应为周一(weekday=0)");
}

/** 所有 item 满足排程约束；返回 { itemMinutes, perDaySegs } 供进一步断言 */
function assertSlotsLegal(
  items: Array<{ actionId: string; title: string; date: string; startTime: string; endTime: string }>,
  netSlots: Map<string, Array<{ startMin: number; endMin: number }>>,
  maxChunk: number,
): void {
  for (const it of items) {
    const s = hmToMin(it.startTime);
    const e = hmToMin(it.endTime);
    const segs = netSlots.get(it.date);
    assert(!!segs, `item 日期 ${it.date} 必须在净空档中`);
    const seg = segs!.find((x) => s >= x.startMin && e <= x.endMin);
    assert(!!seg, `item ${it.title ?? it.actionId} ${it.date} ${it.startTime}-${it.endTime} 超出净空档`);
    assert(e > s && e - s <= maxChunk, `单段应在 (0, ${maxChunk}] 分钟（实际 ${e - s}）`);
  }
  // 同天不重叠（贪心逐段推进，按时间序应两两不交）
  const byDate = new Map<string, Array<{ s: number; e: number }>>();
  for (const it of items) {
    const list = byDate.get(it.date) ?? [];
    list.push({ s: hmToMin(it.startTime), e: hmToMin(it.endTime) });
    byDate.set(it.date, list);
  }
  for (const [date, list] of byDate) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i++) {
      assert(list[i].s >= list[i - 1].e, `${date} 时段重叠：${list[i - 1].e} > ${list[i].s}`);
    }
  }
}

/** 工作日 19:00-22:00 空档 + 周三 20:00-21:00 固定会议 */
function workdayTemplate(): TemplateSlotRow[] {
  const rows: TemplateSlotRow[] = [];
  for (let w = 0; w <= 4; w++) rows.push({ weekday: w, startMin: 19 * 60, endMin: 22 * 60, busy: false });
  rows.push({ weekday: 2, startMin: 20 * 60, endMin: 21 * 60, busy: true }); // 周三会议
  return rows;
}

export const cases: Case[] = [
  // ---- fixture 前提 ----
  {
    name: "fixture-日期周几对齐",
    fn: () => {
      assertFixture();
    },
  },
  // ---- 正向：正常排程 + 固定块扣除 ----
  {
    name: "expandFreeSlots-自由区间扣除固定块",
    fn: () => {
      assertFixture();
      const net = expandFreeSlots(workdayTemplate(), MON, 5);
      assertEq(net.size, 5, "周一至周五每天都有净空档");
      // 周三（2026-09-09）19-22 扣除会议 20-21 → 剩 19-20、21-22
      const wed = net.get("2026-09-09");
      assertDeepSegs(wed, [
        { startMin: 19 * 60, endMin: 20 * 60 },
        { startMin: 21 * 60, endMin: 22 * 60 },
      ]);
      // 普通工作日（周一）保留整段 19-22
      assertDeepSegs(net.get("2026-09-07"), [{ startMin: 19 * 60, endMin: 22 * 60 }]);
    },
  },
  {
    name: "greedySchedule-多阶段连续排程全约束满足",
    fn: () => {
      assertFixture();
      // 10 天窗口（含 2 个周三扣减段）足够消化 600+300：断言总量守恒 + 全部约束合法
      const net = expandFreeSlots(workdayTemplate(), MON, 10);
      const result = greedySchedule({
        actions: [
          { id: "a", title: "阶段甲", estimatedMinutes: 600 },
          { id: "b", title: "阶段乙", estimatedMinutes: 300 },
        ],
        freeSlots: net,
      });
      assertSlotsLegal(result.items, net, MAX);
      const total = result.items.reduce((n, i) => n + (hmToMin(i.endTime) - hmToMin(i.startTime)), 0);
      assertEq(total, 900, "窗口充足时全部需求应排完（总量守恒）");
      assertEq(result.remainingByAction.get("a"), 0, "阶段甲无剩余");
      assertEq(result.remainingByAction.get("b"), 0, "阶段乙无剩余");
      // 贪心从最早日期最早时段开始 → 首个 slot 必属第一个 action（产品轮转语义：同阶段可多段跨天）
      assert(result.items[0].actionId === "a", "首个 slot 应属阶段甲");
    },
  },
  {
    name: "greedySchedule-固定会议时段不被占用",
    fn: () => {
      assertFixture();
      const net = expandFreeSlots(workdayTemplate(), MON, 5);
      const result = greedySchedule({
        actions: [{ id: "a", title: "阶段甲", estimatedMinutes: 3000 }],
        freeSlots: net,
      });
      const wedItems = result.items.filter((i) => i.date === "2026-09-09");
      for (const it of wedItems) {
        const s = hmToMin(it.startTime);
        const e = hmToMin(it.endTime);
        assert(e <= 20 * 60 || s >= 21 * 60, `周三 ${it.startTime}-${it.endTime} 不得覆盖会议 20:00-21:00`);
      }
    },
  },
  {
    name: "greedySchedule-超出窗口-remaining为正且不越界",
    fn: () => {
      assertFixture();
      const net = expandFreeSlots(workdayTemplate(), MON, 2); // 只给 2 天（周一+周二）
      const result = greedySchedule({
        actions: [{ id: "a", title: "阶段甲", estimatedMinutes: 900 }],
        freeSlots: net,
      });
      assertSlotsLegal(result.items, net, MAX);
      assert(result.remainingByAction.get("a")! > 0, "超出窗口应报剩余分钟（不硬塞越界）");
    },
  },
  // ---- 负路径（验收 12 空输入失败 / 不可排环境）----
  {
    name: "expandFreeSlots-空模板-无净空档",
    fn: () => {
      const net = expandFreeSlots([], MON, 7);
      assertEq(net.size, 0, "空模板不应产生任何空档");
    },
  },
  {
    name: "expandFreeSlots-仅固定块无自由时间",
    fn: () => {
      const net = expandFreeSlots(
        [{ weekday: 0, startMin: 20 * 60, endMin: 21 * 60, busy: true }],
        MON,
      7,
      );
      assertEq(net.size, 0, "只有固定块没有自由区间 → 不可排");
    },
  },
  {
    name: "greedySchedule-无可排空档-零排程全剩余",
    fn: () => {
      const result = greedySchedule({
        actions: [{ id: "a", title: "阶段甲", estimatedMinutes: 300 }],
        freeSlots: new Map(),
      });
      assertEq(result.items.length, 0, "无可排空档不应产生任何 item");
      assertEq(result.remainingByAction.get("a"), 300, "全部作为剩余返回（验收 12 空输入失败语义）");
    },
  },
];

function assertDeepSegs(
  actual: Array<{ startMin: number; endMin: number }> | undefined,
  expected: Array<{ startMin: number; endMin: number }>,
): void {
  assert(!!actual, "该日应有净空档");
  const a = JSON.stringify(actual!.map((x) => [x.startMin, x.endMin]));
  const e = JSON.stringify(expected.map((x) => [x.startMin, x.endMin]));
  if (a !== e) throw new Error(`净空档不符（期望 ${e}，实际 ${a}）`);
}
