import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { setExecutionActualMinutes } from "@/lib/service/execution";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 执行记录（Smart Planner Step 5b）。
 * PATCH /api/executions/:id { actualMinutes: number } —— 行内编辑实际投入
 * 只改 execution_records.actual_minutes，不影响 schedule 时长/状态与 action。
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(request);
    const { id } = await params;
    let body: { actualMinutes?: unknown };
    try {
      body = (await request.json()) as { actualMinutes?: unknown };
    } catch {
      body = {};
    }
    if (body.actualMinutes == null) {
      throw new ServiceError("actualMinutes 必填", 400);
    }
    const execution = await setExecutionActualMinutes(userId, id, Number(body.actualMinutes));
    return NextResponse.json({ success: true, execution });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/executions PATCH]", error);
    return NextResponse.json({ error: "执行记录更新失败，请稍后重试" }, { status: 500 });
  }
}
