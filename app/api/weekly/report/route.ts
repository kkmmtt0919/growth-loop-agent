import { NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { generateWeeklyReport, getThisWeekReport } from "@/lib/service/weekly";
import { ServiceError } from "@/lib/service/errors";

export const runtime = "nodejs";

/**
 * 查询本周周报（幂等根基 period_start = weekStartOf(today)）。
 * 不生成：未生成返回 { report: null }，前端据此进入 generating 态。
 * 仅用户模式（周报无系统调度，不需要 resolveAuth 双模式）。
 */
export async function GET(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const report = await getThisWeekReport(userId);
    if (!report) {
      return NextResponse.json({ report: null });
    }
    return NextResponse.json({ report });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/weekly/report] GET", error);
    return NextResponse.json({ error: "查询周报失败" }, { status: 500 });
  }
}

/**
 * 生成/刷新本周周报（幂等：本周已存在则覆盖更新，created=false）。
 * 返回完整报告，前端无需二次 GET。
 */
export async function POST(request: Request) {
  try {
    const { userId } = await authenticate(request);
    const { report, created } = await generateWeeklyReport(userId);
    return NextResponse.json({
      id: report.id,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      created,
      report: {
        summary: report.summary,
        sourceCount: report.sourceCount,
        content: report.content,
        generatedAt: report.generatedAt,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/weekly/report] POST", error);
    return NextResponse.json({ error: "周报生成失败" }, { status: 500 });
  }
}
