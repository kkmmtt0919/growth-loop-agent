import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { batchDeleteTasks } from "@/lib/repo/tasks";

export const runtime = "nodejs";

/** 批量删除任务（Agent Decompose 撤销用；事务 + id/user_id 双条件；不冲正账本） */
export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    return NextResponse.json({ error: "ids 必填且非空" }, { status: 400 });
  }
  const ids = input.ids.filter((x): x is string => typeof x === "string");
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids 必须为字符串数组" }, { status: 400 });
  }

  try {
    const { userId } = await authenticate(request);
    const deleted = await batchDeleteTasks(userId, ids);
    return NextResponse.json({ deleted });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/tasks/batch]", error);
    return NextResponse.json({ error: "批量删除失败" }, { status: 500 });
  }
}
