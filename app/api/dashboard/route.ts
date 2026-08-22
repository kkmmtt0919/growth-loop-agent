import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { getDashboardStats } from "@/lib/service/stats";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 首页聚合：用户概览（等级/XP/streak）+ 今日任务 + 今日记录数 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const stats = await getDashboardStats(userId);
    return NextResponse.json(stats);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/dashboard]", error);
    return NextResponse.json({ error: "聚合失败" }, { status: 500 });
  }
}
