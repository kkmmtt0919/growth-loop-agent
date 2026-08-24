import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { toggleTask } from "@/lib/service/workspace";
import { createTaskForUser, listTasksForUser } from "@/lib/service/tasks";
import { ServiceError } from "@/lib/service/errors";
import { mapTaskToSeedTask } from "@/lib/service/seed";

export const runtime = "nodejs";

/**
 * 任务状态切换（完成/撤销）+ 事务内幂等入账/冲正。
 * 这是状态变更的唯一通道；元数据修改走 PUT /api/tasks/[id]。
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

/** 创建任务（status 默认 upcoming；同 goalId+title 重复 → 409） */
export async function POST(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.title !== "string") {
      return NextResponse.json({ error: "title 必填" }, { status: 400 });
    }
    const task = await createTaskForUser(userId, {
      title: body.title,
      goalId: typeof body.goalId === "string" ? body.goalId : null,
      subtitle: typeof body.subtitle === "string" ? body.subtitle : undefined,
      scheduledTime: typeof body.scheduledTime === "string" ? body.scheduledTime : undefined,
      durationMinutes: typeof body.durationMinutes === "number" ? body.durationMinutes : undefined,
      deadline: body.deadline === undefined || body.deadline === null ? null : String(body.deadline),
      frequency: typeof body.frequency === "string" ? body.frequency : undefined,
      kind: typeof body.kind === "string" ? (body.kind as never) : undefined,
      xp: typeof body.xp === "number" ? body.xp : undefined,
      coin: typeof body.coin === "number" ? body.coin : undefined,
    });
    return NextResponse.json({ task: mapTaskToSeedTask(task) }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/tasks] POST", error);
    return NextResponse.json({ error: "任务创建失败" }, { status: 500 });
  }
}

/** 任务列表（可选 ?goalId= / ?status= 过滤） */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const search = new URL(request.url).searchParams;
    const goalId = search.get("goalId");
    const status = search.get("status");
    const tasks = await listTasksForUser(userId, {
      goalId: goalId ? goalId : undefined,
      status: status ? (status as never) : undefined,
    });
    return NextResponse.json({ tasks: tasks.map(mapTaskToSeedTask) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/tasks] GET", error);
    return NextResponse.json({ error: "任务列表获取失败" }, { status: 500 });
  }
}
