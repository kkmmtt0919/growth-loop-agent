import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { listTodayRecords } from "@/lib/service/records";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 今日记录 + 今日任务完成统计（completionRate 沿用 Phase 2 口径） */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const result = await listTodayRecords(userId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/records/today]", error);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}
