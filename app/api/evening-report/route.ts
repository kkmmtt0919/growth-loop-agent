import { NextResponse } from "next/server";
import { resolveAuth, AuthError } from "@/lib/auth/middleware";
import { generateEveningReport } from "@/lib/service/evening";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/**
 * 生成今日晚报（幂等：当天已存在则覆盖更新，created=false）。
 * 双模式：
 * - 用户会话：Authorization: Bearer <JWT> —— 生成自己的晚报
 * - 系统（平台 Cron）：Authorization: Bearer <CRON_SECRET> + Body { userId } —— 生成指定用户
 * 返回完整报告，前端无需二次 GET。
 */
export async function POST(request: Request) {
  try {
    const auth = await resolveAuth(request);

    let userId: string;
    if (auth.type === "user") {
      userId = auth.userId;
    } else {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const target = body?.userId;
      if (typeof target !== "string" || !target.trim()) {
        return NextResponse.json({ error: "系统模式需要 Body.userId" }, { status: 400 });
      }
      userId = target.trim();
    }

    const { report, created } = await generateEveningReport(userId);
    return NextResponse.json({
      id: report.id,
      date: report.report_date,
      created,
      report: {
        summary: report.summary,
        questions: report.questions,
        sourceCount: report.source_count,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/evening-report]", error);
    return NextResponse.json({ error: "晚报生成失败" }, { status: 500 });
  }
}
