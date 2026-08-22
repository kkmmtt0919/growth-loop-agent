import { timingSafeEqual } from "node:crypto";
import { verifyToken } from "./jwt";
import { isDatabaseConfigured } from "@/lib/repo/pool";

/**
 * Auth Middleware（职责链唯一负责 JWT 签名/有效期验证的地方）。
 * 用法：API route 入口调用 `authenticate(request)` 拿到已验证的 userId，
 * 之后传给 Service —— Service 永远不接触原始 token。
 */

export class AuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
    this.name = "AuthError";
  }
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/** 验证请求携带的 JWT，返回 { userId }；失败抛 AuthError（401/503） */
export async function authenticate(request: Request): Promise<{ userId: string }> {
  if (!isDatabaseConfigured) {
    throw new AuthError("数据库未配置", 503);
  }
  const token = extractBearerToken(request);
  if (!token) {
    throw new AuthError("缺少登录凭证", 401);
  }
  const payload = await verifyToken(token);
  if (!payload) {
    throw new AuthError("登录凭证无效或已过期", 401);
  }
  return payload;
}

/** 定时任务系统凭据：CRON_SECRET 环境变量（Bearer 形式携带） */
export const CRON_SECRET_ENV = "CRON_SECRET";

/** 常量时间比较，避免时序侧信道（CRON_SECRET 比对专用） */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 双模式鉴权（晚报/定时任务入口用）：
 * - `Authorization: Bearer <CRON_SECRET>` → { type: "system" }（平台 Cron 调用）
 * - 否则按用户 JWT 验证 → { type: "user", userId }
 * 判断集中在 Service 层，controller 不分支。
 */
export type AuthContext = { type: "user"; userId: string } | { type: "system" };

export async function resolveAuth(request: Request): Promise<AuthContext> {
  if (!isDatabaseConfigured) {
    throw new AuthError("数据库未配置", 503);
  }
  const token = extractBearerToken(request);
  if (!token) {
    throw new AuthError("缺少登录凭证", 401);
  }
  const cronSecret = process.env[CRON_SECRET_ENV];
  if (cronSecret && safeEqual(token, cronSecret)) {
    return { type: "system" };
  }
  const payload = await verifyToken(token);
  if (!payload) {
    throw new AuthError("登录凭证无效或已过期", 401);
  }
  return { type: "user", userId: payload.userId };
}
