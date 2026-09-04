import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { setActionStatus } from "@/lib/service/action-decompose";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 单个行动阶段状态（Smart Planner Step 2c）。
 * PATCH /api/actions/:id { status: "completed" | "pending" }
 * 手动标记完成/撤销完成（D5：不入 records/账本，只记 completed_at）。planned 拒绝手动切换。
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
    if (body.status !== "completed" && body.status !== "pending") {
      throw new ServiceError("status 应为 completed 或 pending", 400);
    }
    const action = await setActionStatus(userId, id, body.status);
    return NextResponse.json({ success: true, action });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/actions PATCH]", error);
    return NextResponse.json({ error: "行动阶段更新失败，请稍后重试" }, { status: 500 });
  }
}
