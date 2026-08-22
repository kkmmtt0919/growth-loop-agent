import { NextResponse } from "next/server";
import { login, toPublicProfile } from "@/lib/service/auth";
import { ServiceError } from "@/lib/service/errors";
import { isDatabaseConfigured } from "@/lib/repo/pool";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: "数据库未配置，登录不可用" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.email !== "string" || typeof input.password !== "string") {
    return NextResponse.json({ error: "email 和 password 必填" }, { status: 400 });
  }

  try {
    const result = await login({ email: input.email, password: input.password });
    return NextResponse.json({ token: result.token, profile: toPublicProfile(result.profile) });
  } catch (error) {
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/auth/login]", error);
    return NextResponse.json({ error: "登录失败，请稍后重试" }, { status: 500 });
  }
}
