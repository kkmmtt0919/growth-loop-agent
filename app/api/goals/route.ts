import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { createGoalForUser, listGoalsForUser } from "@/lib/service/goals";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 创建目标（业务路径不写 progress 列，默认 0；派生进度由返回装配） */
export async function POST(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.title !== "string") {
      return NextResponse.json({ error: "title 必填" }, { status: 400 });
    }
    const goal = await createGoalForUser(userId, {
      title: body.title,
      description: typeof body.description === "string" ? body.description : undefined,
      startDate: body.startDate === undefined || body.startDate === null ? null : String(body.startDate),
      endDate: body.endDate === undefined || body.endDate === null ? null : String(body.endDate),
      horizon: typeof body.horizon === "string" ? body.horizon : undefined,
    });
    return NextResponse.json({ goal }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals] POST", error);
    return NextResponse.json({ error: "目标创建失败" }, { status: 500 });
  }
}

/** 目标列表（可选 ?status= 过滤；每项含派生 progress/taskCount/doneCount） */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    const goals = await listGoalsForUser(userId, status ? { status: status as never } : {});
    return NextResponse.json({ goals });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals] GET", error);
    return NextResponse.json({ error: "目标列表获取失败" }, { status: 500 });
  }
}
