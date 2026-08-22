import { demoSeed } from "@/lib/demo-data";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { getWorkspaceData } from "@/lib/service/workspace";
import { ServiceError } from "@/lib/service/errors";
import { isDatabaseConfigured } from "@/lib/repo/pool";
import {
  mapProfileToSeedUser,
  mapRecordToLearningLog,
  mapTaskToSeedTask,
} from "@/lib/service/seed";

export const runtime = "nodejs";

/**
 * 工作台数据聚合接口。
 * - 数据库已配置：验证登录态后读当前用户的目标/任务/记录/账本（Service 层隔离）。
 * - 数据库未配置：返回 demo seed（原型模式，页面保持可跑）。
 */
export async function GET(request: Request) {
  if (!isDatabaseConfigured) {
    return Response.json({
      mode: "seeded-demo",
      seedVersion: demoSeed.seedVersion,
      data: demoSeed,
    });
  }

  try {
    const { userId } = await authenticate(request);
    const data = await getWorkspaceData(userId);

    return Response.json({
      mode: "database",
      seedVersion: demoSeed.seedVersion,
      data: {
        user: mapProfileToSeedUser(data.profile),
        goals: data.goals,
        tasks: data.tasks.map(mapTaskToSeedTask),
        learningLogs: data.records.map(mapRecordToLearningLog),
        ledger: data.ledger.map((entry) => ({
          id: entry.id,
          account: entry.account,
          amount: entry.amount,
          reason: entry.reason,
          occurredAt: entry.occurred_at,
        })),
        weeklyBars: demoSeed.weeklyBars,
        insight: demoSeed.insight,
        quote: demoSeed.quote,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/demo]", error);
    return Response.json({ error: "demo unavailable" }, { status: 500 });
  }
}
