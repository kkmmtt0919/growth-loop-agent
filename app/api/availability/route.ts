import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { getAvailability, saveAvailability, type AvailabilityItem } from "@/lib/service/availability";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/**
 * 每周可用时间模板（Smart Planner Step 3）。
 * GET  /api/availability → { items }（回显）
 * PUT  /api/availability { items } → 整组替换保存（title='' 可排空档 / title≠'' 固定块）
 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const items = await getAvailability(userId);
    return NextResponse.json({ success: true, items });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/availability GET]", error);
    return NextResponse.json({ error: "可用时间读取失败，请稍后重试" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const { userId } = await authenticate(request);
    let body: { items?: unknown };
    try {
      body = (await request.json()) as { items?: unknown };
    } catch {
      body = {};
    }
    if (!Array.isArray(body.items)) {
      throw new ServiceError("items 必填且为数组", 400);
    }
    const items = await saveAvailability(userId, body.items as AvailabilityItem[]);
    return NextResponse.json({ success: true, items });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/availability PUT]", error);
    return NextResponse.json({ error: "可用时间保存失败，请稍后重试" }, { status: 500 });
  }
}
