import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { acceptPlan, type PlanItemInput } from "@/lib/service/planner";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 接受计划（Smart Planner Step 3 唯一写库点，单事务）：
 * body { items: Preview 原样回传的 [{actionId,date,startTime,endTime}] }。
 * 幂等：item 对应 action 已非 pending（重复 accept / 已完成）→ skipped，不产生重复 schedule。
 * Action 状态只在这次 accept 事务里 pending → planned（审核边界 §0.4）。
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(request);
    const { id } = await params;
    let body: { items?: unknown };
    try {
      body = (await request.json()) as { items?: unknown };
    } catch {
      body = {};
    }
    if (!Array.isArray(body.items)) {
      throw new ServiceError("items 必填（来自计划预览）", 400);
    }
    const result = await acceptPlan(userId, id, body.items as PlanItemInput[]);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals/plan/accept]", error);
    return NextResponse.json({ error: "计划接受失败，请稍后重试" }, { status: 500 });
  }
}
