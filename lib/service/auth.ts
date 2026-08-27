import { createUser, deleteUser, findByEmail, findById, PG_UNIQUE_VIOLATION } from "@/lib/repo/users";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { signToken } from "@/lib/auth/jwt";
import type { DbProfile } from "@/lib/repo/types";
import { ServiceError } from "./errors";

/**
 * 认证业务服务：注册 / 登录 / 当前用户。
 * 只做业务规则与权限决策，不碰 JWT 签名验证（那是 Auth Middleware 的职责）。
 */

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const MIN_PASSWORD_LENGTH = 8;

export type AuthResult = {
  profile: DbProfile;
  token: string;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function register(input: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) {
    throw new ServiceError("邮箱格式不正确");
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new ServiceError(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }

  const passwordHash = await hashPassword(input.password);
  let profile: DbProfile;
  try {
    profile = await createUser({ email, passwordHash, displayName: input.displayName });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      throw new ServiceError("该邮箱已注册，请直接登录", 409);
    }
    throw error;
  }

  const token = await signToken({ userId: profile.id });
  return { profile, token };
}

export async function login(input: { email: string; password: string }): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const profile = await findByEmail(email);
  // 统一错误文案，避免暴露"邮箱是否存在"（防用户枚举）
  if (!profile) {
    throw new ServiceError("邮箱或密码错误", 401);
  }
  const ok = await verifyPassword(input.password, profile.password_hash);
  if (!ok) {
    throw new ServiceError("邮箱或密码错误", 401);
  }
  const token = await signToken({ userId: profile.id });
  return { profile, token };
}

export async function getProfileById(userId: string): Promise<DbProfile> {
  const profile = await findById(userId);
  if (!profile) {
    throw new ServiceError("用户不存在", 404);
  }
  return profile;
}

/** 返回给前端的用户信息（绝不包含 password_hash） */
export function toPublicProfile(profile: DbProfile) {
  const { password_hash, ...safe } = profile;
  void password_hash;
  return safe;
}

/** 删除账号：级联清空业务数据。userId 必须来自 authenticate 的 JWT。 */
export async function deleteAccount(userId: string): Promise<void> {
  const deleted = await deleteUser(userId);
  if (!deleted) {
    throw new ServiceError("用户不存在", 404);
  }
}
