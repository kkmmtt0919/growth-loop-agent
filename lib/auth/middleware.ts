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
