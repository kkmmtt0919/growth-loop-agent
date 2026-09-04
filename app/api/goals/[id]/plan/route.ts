import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { generatePlanPreview } from "@/lib/service/planner";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 生成计划建议（Smart Planner Step 3）。**纯读 + 内存计算，零落库**（审核边界 §0.3）：
 * POST /plan 后 schedules / actions 均不变；只有 /plan/accept 才写库。
 * 返回 Preview：blocked=no-availability/no-pending 时携带引导 message，feasibility/items 为空。
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(_request);
    const { id } = await params;
    const preview = await generatePlanPreview(userId, id);
    return NextResponse.json({ success: true, ...preview });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals/plan]", error);
    return NextResponse.json({ error: "计划生成失败，请稍后重试" }, { status: 500 });
  }
}
