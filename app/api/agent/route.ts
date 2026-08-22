import { NextResponse } from "next/server";
import { getAgentStatus, runAgent } from "@/lib/agent/provider";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { createRecordWithReward, updateRecord } from "@/lib/service/workspace";
import { ServiceError } from "@/lib/service/errors";
import { isDatabaseConfigured } from "@/lib/repo/pool";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getAgentStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid JSON body");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("request body must be an object");
  }

  const input = body as Record<string, unknown>;
  if (typeof input.message !== "string") {
    return errorResponse("message must be a string");
  }

  const message = input.message.trim();
  if (!message) {
    return errorResponse("message is required");
  }

  if (input.output !== undefined && typeof input.output !== "string") {
    return errorResponse("output must be a string");
  }

  if (input.minutes !== undefined && (typeof input.minutes !== "number" || input.minutes < 0 || input.minutes > 1440)) {
    return errorResponse("minutes must be a number between 0 and 1440");
  }

  if (input.context !== undefined && typeof input.context !== "string") {
    return errorResponse("context must be a string");
  }

  const headerSession = request.headers.get("x-agent-session")?.trim();
  const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : headerSession;

  // 数据库模式：Auth Middleware 验证 JWT 拿 userId；未配置数据库时跳过（原型回退）
  let userId: string | null = null;
  if (isDatabaseConfigured) {
    try {
      const auth = await authenticate(request);
      userId = auth.userId;
    } catch (error) {
      if (error instanceof AuthError) {
        return errorResponse(error.message, error.status);
      }
      return errorResponse("agent unavailable", 500);
    }
  }

  try {
    const result = await runAgent(message, {
      conversationId,
      output: typeof input.output === "string" ? input.output.trim() : undefined,
      context: typeof input.context === "string" ? input.context.trim() : undefined,
    });

    // 数据库模式：记录持久化 + 幂等入账；失败不阻塞回复（persisted:false，前端可回退）
    // 时长/产出优先级：用户显式填写 > Agent 文本提取 > 默认（0 / null）
    const explicitMinutes = typeof input.minutes === "number" ? input.minutes : undefined;
    const explicitOutput = typeof input.output === "string" && input.output.trim() ? input.output.trim() : undefined;
    let record: unknown = null;
    if (userId) {
      try {
        record = await createRecordWithReward(userId, {
          text: message,
          topic: result.extracted?.topic || message.slice(0, 60) || "学习记录",
          kind: result.extracted?.kind,
          minutes: explicitMinutes ?? result.extracted?.minutes ?? 0,
          output: explicitOutput ?? result.extracted?.output ?? null,
          intent: result.intent,
          mode: result.mode,
        });
      } catch (error) {
        console.error("[api/agent] persist record failed", error);
        record = null;
      }
    }

    return NextResponse.json(
      { ...result, record, persisted: Boolean(record), conversationId: conversationId || "anonymous" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return errorResponse("agent unavailable", 500);
  }
}

/** Agent 结构化提取回写记录（topic/kind/minutes/output/intent） */
export async function PATCH(request: Request) {
  if (!isDatabaseConfigured) {
    return errorResponse("database not configured", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid JSON body");
  }

  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.recordId !== "string" || typeof input.patch !== "object" || input.patch === null) {
    return errorResponse("recordId and patch are required");
  }

  try {
    const { userId } = await authenticate(request);
    const patch = input.patch as Record<string, unknown>;
    const updated = await updateRecord(userId, input.recordId, {
      topic: typeof patch.topic === "string" ? patch.topic : undefined,
      kind: (["focus", "learn", "exercise", "life", "rest"] as const).includes(patch.kind as never)
        ? (patch.kind as "focus" | "learn" | "exercise" | "life" | "rest")
        : undefined,
      minutes: typeof patch.minutes === "number" ? patch.minutes : undefined,
      output: typeof patch.output === "string" ? patch.output : undefined,
      intent: (["quick_log", "plan_today", "review"] as const).includes(patch.intent as never)
        ? (patch.intent as "quick_log" | "plan_today" | "review")
        : undefined,
      mode: typeof patch.mode === "string" ? (patch.mode as "llm" | "demo" | "pending") : undefined,
    });
    return NextResponse.json({ record: updated }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }
    if (error instanceof ServiceError) {
      return errorResponse(error.message, error.status);
    }
    return errorResponse("agent unavailable", 500);
  }
}
