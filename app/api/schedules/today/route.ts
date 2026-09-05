import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { buildTodayTimeline } from "@/lib/service/timeline";

export const runtime = "nodejs";

/**
 * 今日时间轴（Smart Planner Step 4）。
 * GET /api/schedules/today → { date, items: TimelineItem[] }
 * 后端聚合 action/manual 排程 + 今日固定块（title≠''），按 start_time 排序，前端零拼接。
 * 昨天 planned 天然不出现（只查 date=today）。
 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const timeline = await buildTodayTimeline(userId);
    return NextResponse.json({ success: true, ...timeline });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/schedules/today GET]", error);
    return NextResponse.json({ error: "今日时间轴读取失败，请稍后重试" }, { status: 500 });
  }
}
