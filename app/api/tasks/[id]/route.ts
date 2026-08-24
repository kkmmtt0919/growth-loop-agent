import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { deleteTaskForUser, updateTaskForUser } from "@/lib/service/tasks";
import { mapTaskToSeedTask } from "@/lib/service/seed";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** 编辑任务元数据（只改元数据；status/xp/coin 被 Service 层拒绝，状态变更走 PATCH /api/tasks） */
export async function PUT(request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(request);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    const task = await updateTaskForUser(userId, id, body);
    return NextResponse.json({ task: mapTaskToSeedTask(task) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/tasks] PUT", error);
    return NextResponse.json({ error: "任务更新失败" }, { status: 500 });
  }
}

/** 删除任务（不冲正账本：产品设计 §6.5「删除任务不扣分」） */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(_request);
    const { id } = await params;
    await deleteTaskForUser(userId, id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/tasks] DELETE", error);
    return NextResponse.json({ error: "任务删除失败" }, { status: 500 });
  }
}
