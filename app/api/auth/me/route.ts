import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { getProfileById, toPublicProfile } from "@/lib/service/auth";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 校验当前登录态并返回用户信息（前端启动恢复会话用） */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const profile = await getProfileById(userId);
    return NextResponse.json({ profile: toPublicProfile(profile) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/auth/me]", error);
    return NextResponse.json({ error: "服务不可用" }, { status: 500 });
  }
}
