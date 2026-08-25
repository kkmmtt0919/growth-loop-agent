import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { decomposeGoal } from "@/lib/service/decompose";
import { ServiceError } from "@/lib/service/errors";
import { mapTaskToSeedTask } from "@/lib/service/seed";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * 目标拆解成行动（Agent Decompose V1）。
 * 无业务 body：上下文（目标 + 已有任务 + 步数范围）全部由服务端收集。
 * 返回 { count, source, createdTaskIds, tasks }；source 供统计 Agent 使用率/fallback 比例。
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(_request);
    const { id } = await params;
    const result = await decomposeGoal(userId, id);
    return NextResponse.json({
      success: true,
      count: result.count,
      source: result.source,
      createdTaskIds: result.createdTaskIds,
      tasks: result.tasks.map(mapTaskToSeedTask),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/goals/decompose]", error);
    return NextResponse.json({ error: "目标拆解失败，请稍后重试" }, { status: 500 });
  }
}
