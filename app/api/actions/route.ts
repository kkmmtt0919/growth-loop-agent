import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { listActionViews, removeActions } from "@/lib/service/action-decompose";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/**
 * 行动路线资源入口（Smart Planner Step 2c）。
 * GET  /api/actions?goal_ids=id1,id2  回显行动路线（缺省 = 当前用户全部；goal_ids 逗号分隔预留过滤）
 * DELETE /api/actions { actionIds }   整批撤销（「制定行动路线」undo，幂等，依赖级联清理）
 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const goalParam = new URL(request.url).searchParams.get("goal_ids");
    const goalIds = goalParam ? goalParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const actions = await listActionViews(userId, goalIds);
    return NextResponse.json({ success: true, actions });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/actions GET]", error);
    return NextResponse.json({ error: "行动路线读取失败，请稍后重试" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { userId } = await authenticate(request);
    let body: { actionIds?: unknown };
    try {
      body = (await request.json()) as { actionIds?: unknown };
    } catch {
      body = {};
    }
    const ids = Array.isArray(body.actionIds) ? body.actionIds.filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) {
      throw new ServiceError("actionIds 必填且为字符串数组", 400);
    }
    if (ids.length > 100) {
      throw new ServiceError("一次最多撤销 100 个行动阶段", 400);
    }
    const removed = await removeActions(userId, ids);
    return NextResponse.json({ success: true, removed });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/actions DELETE]", error);
    return NextResponse.json({ error: "撤销失败，请稍后重试" }, { status: 500 });
  }
}
