/**
 * 在现有数据库上执行一条 migration 文件（本地快速迁移工具）。
 * 用法：node scripts/run-migration.mjs supabase/migrations/002_add_task_version.sql
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  console.error("用法: node scripts/run-migration.mjs <sql 文件路径>");
  process.exit(1);
}

const envText = readFileSync(path.join(root, ".env.local"), "utf8");
const url = envText.split("\n").find((l) => l.startsWith("DATABASE_URL="))?.slice(13).trim();
const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, "");
const pool = new pg.Pool({ connectionString: cleanUrl });

try {
  const sql = readFileSync(path.join(root, target), "utf8");
  await pool.query(sql);
  console.log("migration 执行成功:", target);
} catch (error) {
  console.error("migration 执行失败:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
