import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { resetGoalPlan } from "@/lib/service/planner";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 撤销安排（Smart Planner Step 3，审核边界 §0.2）：
 * 只清该目标 source='action' and status='planned' 的 schedules，并把 planned 阶段回 pending；
 * **绝不碰 source='manual'** 与已完成 schedule / completed action。
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(_request);
    const { id } = await params;
    const result = await resetGoalPlan(userId, id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals/plan/reset]", error);
    return NextResponse.json({ error: "撤销安排失败，请稍后重试" }, { status: 500 });
  }
}
