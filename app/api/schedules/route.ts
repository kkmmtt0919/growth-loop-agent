import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { createManualSchedule } from "@/lib/service/timeline";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/**
 * 手动添加今日事项（Smart Planner Step 4）。
 * POST /api/schedules { title, startTime, endTime } → source='manual'，date=today。
 * 手动事项是「承诺的执行计划」：不关联 action/goal，不影响目标进度；可完成/撤销/删除。
 */
export async function POST(request: Request) {
  try {
    const { userId } = await authenticate(request);
    let body: { title?: unknown; startTime?: unknown; endTime?: unknown };
    try {
      body = (await request.json()) as { title?: unknown; startTime?: unknown; endTime?: unknown };
    } catch {
      body = {};
    }
    const schedule = await createManualSchedule(userId, {
      title: typeof body.title === "string" ? body.title : "",
      startTime: typeof body.startTime === "string" ? body.startTime : "",
      endTime: typeof body.endTime === "string" ? body.endTime : "",
    });
    return NextResponse.json({ success: true, schedule }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/schedules POST]", error);
    return NextResponse.json({ error: "手动事项保存失败，请稍后重试" }, { status: 500 });
  }
}
