import { NextResponse } from "next/server";
import { register, toPublicProfile } from "@/lib/service/auth";
import { seedForUser } from "@/lib/service/workspace";
import { ServiceError } from "@/lib/service/errors";
import { isDatabaseConfigured } from "@/lib/repo/pool";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: "数据库未配置，注册不可用" }, { status: 503 });
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
    const result = await register({
      email: input.email,
      password: input.password,
      displayName: typeof input.displayName === "string" ? input.displayName : undefined,
    });
    // 首登播种：仅开发/演示环境（ENABLE_DEMO_SEED !== "false" 时默认开启）；
    // 生产置 false 后新用户为空数据，走 onboarding 引导（失败不阻塞注册）
    if (process.env.ENABLE_DEMO_SEED !== "false") {
      try {
        await seedForUser(result.profile.id);
      } catch (error) {
        console.error("[api/auth/register] seed failed", error);
      }
    }
    return NextResponse.json({ token: result.token, profile: toPublicProfile(result.profile) });
  } catch (error) {
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/auth/register]", error);
    return NextResponse.json({ error: "注册失败，请稍后重试" }, { status: 500 });
  }
}
