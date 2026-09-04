import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { decomposeToActions } from "@/lib/service/action-decompose";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 制定行动路线（Smart Planner Step 2，战略层）：目标 → Action 池 + 依赖。
 * 无业务 body：上下文（目标 + 已有行动 + 阶段数分档）全部由服务端收集。
 * 产物只写 actions / action_dependencies，不写 tasks（不污染今日时间轴）。
 * 返回 { count, source, skipped, actions }；source 供统计 Agent 使用率/fallback 比例。
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(_request);
    const { id } = await params;
    const result = await decomposeToActions(userId, id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals/actions/generate]", error);
    return NextResponse.json({ error: "行动路线生成失败，请稍后重试" }, { status: 500 });
  }
}
