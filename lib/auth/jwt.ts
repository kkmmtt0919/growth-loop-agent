import { jwtVerify, SignJWT } from "jose";

/**
 * JWT 签发与验证（HS256）。
 * 只负责签名/有效期，不负责业务逻辑 —— 身份提取后由 Service 使用。
 * JWT_SECRET 来自环境变量，生产环境必须强随机且保密。
 */
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "");

export const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天

export async function signToken(payload: { userId: string }): Promise<string> {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET 未配置");
  }
  return new SignJWT({ userId: payload.userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(secret);
}

/** 验证 JWT 签名与有效期；无效返回 null */
export async function verifyToken(token: string): Promise<{ userId: string } | null> {
  if (!process.env.JWT_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    const userId = payload.userId;
    return typeof userId === "string" && userId ? { userId } : null;
  } catch {
    return null;
  }
}
