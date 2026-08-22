import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { toggleTask } from "@/lib/service/workspace";
import { ServiceError } from "@/lib/service/errors";
import { mapTaskToSeedTask } from "@/lib/service/seed";

export const runtime = "nodejs";

/**
 * 任务状态切换（完成/撤销）+ 事务内幂等入账/冲正。
 * 任务列表由 /api/demo 提供，这里只处理写操作。
 */
export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.taskId !== "string" || typeof input.done !== "boolean") {
    return NextResponse.json({ error: "taskId 和 done 必填" }, { status: 400 });
  }

  try {
    const { userId } = await authenticate(request);
    const task = await toggleTask(userId, input.taskId, input.done);
    return NextResponse.json({ task: mapTaskToSeedTask(task) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/tasks]", error);
    return NextResponse.json({ error: "任务更新失败" }, { status: 500 });
  }
}
