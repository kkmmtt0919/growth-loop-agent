import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { deleteAccount } from "@/lib/service/auth";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/** 删除当前登录账号：硬删除 profiles，业务数据依赖 FK CASCADE 一并清空 */
export async function DELETE(request: Request) {
  try {
    const { userId } = await authenticate(request);
    await deleteAccount(userId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/auth/delete]", error);
    return NextResponse.json({ error: "服务不可用" }, { status: 500 });
  }
}
