import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { getGrowthStats } from "@/lib/service/stats";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 成长页聚合：近 7 天投入 / 掌握证据分布 / 有效行动日 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const stats = await getGrowthStats(userId);
    return NextResponse.json(stats);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/growth/stats]", error);
    return NextResponse.json({ error: "聚合失败" }, { status: 500 });
  }
}
