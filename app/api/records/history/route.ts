import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { listHistoryRecords } from "@/lib/service/records";
import { ServiceError } from "@/lib/service/errors";
import type { Mood } from "@/lib/repo/types";

export const runtime = "nodejs";

/** 历史记录分页 + 筛选（无 kind 参数；from/to/mood/limit/offset 全可选） */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const sp = new URL(request.url).searchParams;
    const from = sp.get("from") ?? undefined;
    const to = sp.get("to") ?? undefined;
    const moodParam = sp.get("mood");
    const mood = moodParam ? (moodParam as Mood) : undefined;
    const limit = sp.get("limit") ? Number(sp.get("limit")) : undefined;
    const offset = sp.get("offset") ? Number(sp.get("offset")) : undefined;
    const result = await listHistoryRecords(userId, { from, to, mood, limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/records/history]", error);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}
