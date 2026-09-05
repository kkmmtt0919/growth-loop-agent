import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { listAgentRunsForUser } from "@/lib/service/agent-runs";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/**
 * Agent 运行记录（Smart Planner Step 7c，只读最小）。
 * GET /api/agent-runs?limit=20 → { success, runs }
 * runs 元素仅含 id/agentType/promptVersion/success/latencyMs/createdAt——
 * 不暴露 input_context/output_json/error_message（隐私与体积口径，同 015）。
 * 用户隔离；未登录 401。
 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const sp = new URL(request.url).searchParams;
    const limit = sp.get("limit") ? Number(sp.get("limit")) : undefined;
    const runs = await listAgentRunsForUser(userId, limit);
    return NextResponse.json({ success: true, runs });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/agent-runs GET]", error);
    return NextResponse.json({ error: "运行记录读取失败，请稍后重试" }, { status: 500 });
  }
}
