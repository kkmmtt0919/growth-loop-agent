import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { patchRecord } from "@/lib/service/records";
import { ServiceError } from "@/lib/service/errors";
import type { RecordPatch } from "@/lib/repo/records";
import type { Mood } from "@/lib/repo/types";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** 回写 mood/remark（白名单锁死：body 其他字段一律忽略；id+user_id 双条件防越权） */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { userId } = await authenticate(request);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

    const patch: RecordPatch = {};
    if ("mood" in body) {
      const m = body.mood;
      if (m === null || typeof m === "string") {
        patch.mood = m === null ? null : (m as Mood);
      }
    }
    if ("remark" in body) {
      const r = body.remark;
      if (r === null || typeof r === "string") {
        patch.remark = r as string | null;
      }
    }

    const item = await patchRecord(userId, id, patch);
    return NextResponse.json(item);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/records PATCH]", error);
    return NextResponse.json({ error: "记录更新失败" }, { status: 500 });
  }
}
