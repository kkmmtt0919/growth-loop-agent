import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { listRecentRecords } from "@/lib/service/records";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 近 N 天滚动窗口（默认 7，可 ?days=30）按日分组 + 汇总；weeklyCompletionRate 用新口径 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const daysParam = new URL(request.url).searchParams.get("days");
    const days = daysParam ? Number(daysParam) : 7;
    const result = await listRecentRecords(userId, days);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/records/recent]", error);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}
