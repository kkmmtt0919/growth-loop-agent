import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { listWeeklyReportsForUser } from "@/lib/service/weekly";

export const runtime = "nodejs";

/**
 * 历史周报分页（倒序，含 content）。
 * 查询参数：?limit=10&offset=0（limit 上限 50，缺省 10）。
 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "10") || 10;
    const offset = Number(url.searchParams.get("offset") ?? "0") || 0;
    const { total, reports } = await listWeeklyReportsForUser(userId, limit, offset);
    return NextResponse.json({ total, limit, offset, reports });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/weekly/list]", error);
    return NextResponse.json({ error: "查询周报列表失败" }, { status: 500 });
  }
}
