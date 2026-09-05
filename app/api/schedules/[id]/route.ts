import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { deleteManualSchedule, setTimelineStatus } from "@/lib/service/timeline";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 单条排程（Smart Planner Step 4 时间轴）。
 * PATCH /api/schedules/:id { status: "planned" | "completed" } —— 完成/撤销完成
 *   （只记 completed_at，不推进 action.status，不写账本）
 * DELETE /api/schedules/:id —— 仅 manual 可删；action 排程 409（撤销请用 plan/reset）
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(request);
    const { id } = await params;
    let body: { status?: unknown };
    try {
      body = (await request.json()) as { status?: unknown };
    } catch {
      body = {};
    }
    if (body.status !== "planned" && body.status !== "completed") {
      throw new ServiceError("status 应为 planned 或 completed", 400);
    }
    const schedule = await setTimelineStatus(userId, id, body.status);
    return NextResponse.json({ success: true, schedule });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/schedules PATCH]", error);
    return NextResponse.json({ error: "排程更新失败，请稍后重试" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(request);
    const { id } = await params;
    await deleteManualSchedule(userId, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/schedules DELETE]", error);
    return NextResponse.json({ error: "排程删除失败，请稍后重试" }, { status: 500 });
  }
}
