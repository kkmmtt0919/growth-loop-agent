import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { deleteGoalForUser, updateGoalForUser } from "@/lib/service/goals";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** 编辑目标元数据（status 白名单；不接受 progress 字段） */
export async function PUT(request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(request);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    if (body.progress !== undefined) {
      return NextResponse.json({ error: "progress 为派生字段，不允许直接修改" }, { status: 400 });
    }
    const goal = await updateGoalForUser(userId, id, {
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      horizon: typeof body.horizon === "string" ? body.horizon : undefined,
      status: typeof body.status === "string" ? (body.status as never) : undefined,
      startDate: body.startDate === undefined || body.startDate === null ? undefined : String(body.startDate),
      endDate: body.endDate === undefined || body.endDate === null ? undefined : String(body.endDate),
    });
    return NextResponse.json({ goal });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals] PUT", error);
    return NextResponse.json({ error: "目标更新失败" }, { status: 500 });
  }
}

/** 删除目标：事务内先置空关联任务 goal_id（历史任务保留），再删目标 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(_request);
    const { id } = await params;
    await deleteGoalForUser(userId, id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals] DELETE", error);
    return NextResponse.json({ error: "目标删除失败" }, { status: 500 });
  }
}
