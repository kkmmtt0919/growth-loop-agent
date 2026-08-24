import { listUserIds } from "@/lib/repo/users";
import { generateEveningReport } from "@/lib/service/evening";
import { nowHmShanghai, readReportTime, todayInShanghai } from "@/lib/service/time";

/**
 * 晚报调度器（Phase 3）。
 * Scheduler 抽象：
 * - runDailyEveningScheduler()：独立可调用的触发函数（遍历全部用户 + 幂等生成），
 *   未来替换外部 Cron 时只改挂载点（CRON_SECRET 系统模式接口也复用同链路）。
 * - startEveningScheduler()：MVP 调度实现（setInterval 每分钟比对上海时区时间），
 *   仅常驻进程生效；serverless 部署用 CRON_SECRET 外部触发。
 */

let lastRunDate = "";

export type SchedulerRunResult = { generated: number; failed: number };

/** 触发一次全量晚报生成（幂等：已生成则覆盖为最新；单用户失败不中断） */
export async function runDailyEveningScheduler(): Promise<SchedulerRunResult> {
  const userIds = await listUserIds();
  let generated = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await generateEveningReport(userId);
      generated += 1;
    } catch (error) {
      failed += 1;
      console.error(`[scheduler] 生成晚报失败 user=${userId}`, error);
    }
  }
  console.log(`[scheduler] runDailyEveningScheduler: users=${userIds.length} generated=${generated} failed=${failed}`);
  return { generated, failed };
}

/** MVP 调度实现：每分钟检查；已到达 REPORT_TIME（上海时区 HH:MM 字典序比较）且今日未跑过 → 触发。
 * 条件用「已到达」而非「精确相等」：避免 60s 心跳错过分钟窗口；
 * 服务在目标时间后启动也会补生成当天晚报（与「服务端懒触发」语义一致）。 */
export function startEveningScheduler(options: { intervalMs?: number } = {}): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  async function tickOnce() {
    const today = todayInShanghai();
    const target = readReportTime();
    const hm = nowHmShanghai();
    if (process.env.SCHEDULER_DEBUG === "1") {
      console.log(`[scheduler] tick last=${lastRunDate} now=${hm} target=${target}`);
    }
    if (lastRunDate === today) return;
    if (hm < target) return;
    lastRunDate = today;
    try {
      console.log("[scheduler] triggering runDailyEveningScheduler");
      const result = await runDailyEveningScheduler();
      console.log("[scheduler] run completed", JSON.stringify(result));
    } catch (error) {
      console.error("[scheduler] run failed", error);
    }
  }
  // 不阻止进程退出（next build 等场景）
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[scheduler] startEveningScheduler: REPORT_TIME=${readReportTime()} interval=${intervalMs}ms`);
  return timer;
}
