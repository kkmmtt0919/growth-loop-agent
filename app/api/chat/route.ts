import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { ServiceError } from "@/lib/service/errors";
import { getChatHistory, sendChatMessage, MAX_MESSAGE_LENGTH } from "@/lib/service/chat";

export const runtime = "nodejs";

function errorResponse(error: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** 打开面板时拉历史：GET /api/chat?conversationId=uuid（不传则取/创建该用户唯一会话） */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId")?.trim() || null;
    const result = await getChatHistory(userId, conversationId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.message, error.status);
    if (error instanceof ServiceError) return errorResponse(error.message, error.status);
    console.error("[api/chat] GET failed", error);
    return errorResponse("chat unavailable", 500);
  }
}

/** 发一条消息：POST /api/chat */
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
    return errorResponse("消息不能为空");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return errorResponse(`消息不能超过 ${MAX_MESSAGE_LENGTH} 字`);
  }
  if (input.conversationId !== undefined && typeof input.conversationId !== "string") {
    return errorResponse("conversationId must be a string");
  }
  if (input.clientMsgId !== undefined && typeof input.clientMsgId !== "string") {
    return errorResponse("clientMsgId must be a string");
  }
  if (input.clientMsgId !== undefined && input.clientMsgId.trim().length > 64) {
    return errorResponse("clientMsgId too long");
  }

  try {
    const { userId } = await authenticate(request);
    const result = await sendChatMessage({
      userId,
      message,
      conversationId: typeof input.conversationId === "string" && input.conversationId.trim() ? input.conversationId.trim() : null,
      clientMsgId: typeof input.clientMsgId === "string" && input.clientMsgId.trim() ? input.clientMsgId.trim() : null,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.message, error.status);
    if (error instanceof ServiceError) {
      // 限流命中 429：带 rateLimited 标记，前端据此提示"发送太频繁"
      const rateLimited = error.status === 429;
      return errorResponse(error.message, error.status, rateLimited ? { rateLimited: true } : {});
    }
    console.error("[api/chat] POST failed", error);
    return errorResponse("chat unavailable", 500);
  }
}
