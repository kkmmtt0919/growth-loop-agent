/**
 * 数据库连接诊断（临时工具，也可长期保留）。
 * 用法：node scripts/db-check.mjs
 * 读取 .env.local 的 DATABASE_URL，测试连接并列出 public schema 表。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env.local");
const envText = readFileSync(envPath, "utf8");
const url = envText.split("\n").find((line) => line.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length).trim();

if (!url) {
  console.error("DATABASE_URL 未在 .env.local 中配置");
  process.exit(1);
}

// 实测：Supabase pooler 接受明文；显式 ssl 反而失败，故剥离 sslmode 且不传 ssl
const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, "");
const pool = new pg.Pool({
  connectionString: cleanUrl,
  connectionTimeoutMillis: 10_000,
});

try {
  const { rows } = await pool.query("select 1 as ok");
  console.log("CONNECT OK:", rows[0]);
  const tables = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`,
  );
  console.log("TABLES:", tables.rows.map((r) => r.table_name).join(", ") || "(empty)");
} catch (error) {
  console.error("CONNECT FAIL:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
