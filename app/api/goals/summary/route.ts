import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { getGoalsSummary } from "@/lib/service/stats";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 计划页重点目标：进行中 → 最近创建 → 前 3 个 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const summary = await getGoalsSummary(userId);
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals/summary]", error);
    return NextResponse.json({ error: "聚合失败" }, { status: 500 });
  }
}
