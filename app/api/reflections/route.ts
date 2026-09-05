import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { addReflection, listReflectionsForUser } from "@/lib/service/reflection";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/**
 * 用户反馈（Smart Planner Step 6a Reflection）。
 * POST /api/reflections { goalId?, actionId?, source, content, rating? } → 创建
 * GET  /api/reflections?goal_id=&limit= → 列表（created_at 倒序，limit ≤20）
 * 只记录 + 查询（D1：不自动影响 Planner）；不进 XP/coin。
 */
export async function POST(request: Request) {
  try {
    const { userId } = await authenticate(request);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const reflection = await addReflection(userId, {
      goalId: typeof body.goalId === "string" ? body.goalId : null,
      actionId: typeof body.actionId === "string" ? body.actionId : null,
      source: typeof body.source === "string" ? body.source : "",
      content: typeof body.content === "string" ? body.content : "",
      rating: typeof body.rating === "string" ? body.rating : null,
    });
    return NextResponse.json({ success: true, reflection }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/reflections POST]", error);
    return NextResponse.json({ error: "反馈保存失败，请稍后重试" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const url = new URL(request.url);
    const goalId = url.searchParams.get("goal_id") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const reflections = await listReflectionsForUser(userId, { goalId, limit });
    return NextResponse.json({ success: true, reflections });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/reflections GET]", error);
    return NextResponse.json({ error: "反馈读取失败，请稍后重试" }, { status: 500 });
  }
}
