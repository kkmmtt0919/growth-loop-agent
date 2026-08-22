import { Pool } from "pg";

/**
 * pg 连接池（唯一数据库入口）。
 * DATABASE_URL 兼容任意 PG 托管：Supabase pooler 串 / 腾讯云 PG 串 / 本地 PG。
 * 迁移 = 换这个环境变量，代码零改动。
 *
 * SSL 处理（实测结论 2026-08-21）：
 * - Supabase pooler (aws-0-*.pooler.supabase.com:6543) 接受裸 pg 明文连接，
 *   显式传 ssl 反而报 wrong version number（连接串里的 sslmode=require 会被
 *   pg 解析成 verify-full 强校验，导致自签名链失败）。
 * - 因此统一剥离 sslmode 参数且不主动启用 ssl。
 * - 若将来目标 PG 强制 SSL：把下方 ssl 设为 { rejectUnauthorized: false }
 *   （或按需配 CA），连接串保留 sslmode=require 即可。
 */
const connectionString = process.env.DATABASE_URL ?? "";

/** 数据库是否已配置（未配置时 API 走 demo 回退，原型保持可用） */
export const isDatabaseConfigured = Boolean(connectionString);

function normalize(connectionString: string): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  // 剥离 sslmode，避免 pg-connection-string 将其解析为 verify-full
  const clean = connectionString.replace(/[?&]sslmode=[^&]*/g, "");
  return { connectionString: clean, ssl: undefined };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const { connectionString: clean, ssl } = normalize(connectionString);
    pool = new Pool({
      connectionString: clean,
      max: 10,
      idleTimeoutMillis: 30_000,
      ssl,
    });
  }
  return pool;
}

/** 供测试/热重载重置单例 */
export function __resetPool() {
  pool = null;
}
