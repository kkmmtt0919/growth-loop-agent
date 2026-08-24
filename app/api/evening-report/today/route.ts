import { NextResponse } from "next/server";
import { resolveAuth, AuthError } from "@/lib/auth/middleware";
import { getTodayEveningReport } from "@/lib/service/evening";

export const runtime = "nodejs";

/** 查询今日晚报；未生成返回 { report: null }（前端据此进入 no-report/generating 态） */
export async function GET(request: Request) {
  try {
    const auth = await resolveAuth(request);
    if (auth.type === "system") {
      return NextResponse.json({ error: "该接口仅支持用户会话" }, { status: 400 });
    }

    const report = await getTodayEveningReport(auth.userId);
    if (!report) {
      return NextResponse.json({ report: null });
    }
    return NextResponse.json({
      report: {
        id: report.id,
        date: report.report_date,
        summary: report.summary,
        questions: report.questions,
        sourceCount: report.source_count,
        content: report.content,
        generatedAt: report.generated_at,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/evening-report/today]", error);
    return NextResponse.json({ error: "查询晚报失败" }, { status: 500 });
  }
}
