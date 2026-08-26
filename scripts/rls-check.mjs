/**
 * 只读诊断：检查 public schema 所有表的 RLS 状态与策略数量。
 * 用法：node scripts/rls-check.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envText = readFileSync(path.join(root, ".env.local"), "utf8");
const url = envText.split("\n").find((l) => l.startsWith("DATABASE_URL="))?.slice(13).trim();
const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, "");
const pool = new pg.Pool({ connectionString: cleanUrl, connectionTimeoutMillis: 10000 });

try {
  const c = await pool.query("select 1 as ok");
  console.log("CONNECT:", c.rows[0].ok === 1 ? "OK" : "FAIL");

  const u = await pool.query("select current_user, current_database()");
  console.log("USER:", u.rows[0].current_user, "| DB:", u.rows[0].current_database);

  const r = await pool.query(
    "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
  );
  console.log("ROLE FLAGS:", JSON.stringify(r.rows[0]));

  const t = await pool.query(`
    select c.relname as table_name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  `);
  console.log("TABLE RLS STATUS:");
  for (const row of t.rows) {
    const flag = row.rls_enabled ? "ON" : "OFF";
    console.log("  " + row.table_name.padEnd(20) + " rls=" + flag);
  }

  const p = await pool.query(`
    select c.relname, count(pol.polname) as policy_count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policy pol on pol.polrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    group by c.relname order by c.relname
  `);
  console.log("POLICIES:", p.rows.map((x) => x.relname + "=" + x.policy_count).join(", "));
} catch (e) {
  console.error("ERR:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
