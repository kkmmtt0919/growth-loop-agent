/**
 * 一键应用全部数据库迁移（Step 7a）。
 * 用法：
 *   node scripts/setup-db.mjs                 # 读 .env.local（本地，兼容现有 run-migration）
 *   DATABASE_URL=... node scripts/setup-db.mjs # 或直接环境变量（Docker/CI 注入）
 *
 * 行为：
 *   - 扫描 supabase/migrations/*.sql，按文件名顺序执行
 *   - 维护 public.schema_migrations 表记录已应用文件 → 幂等可重跑（跳过已应用）
 *   - 每个文件包在单个事务里：失败回滚该文件，不污染其他
 *   - 与 run-migration.mjs 兼容：同一 DATABASE_URL 读取逻辑、同样剥离 sslmode
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");

/** 从 .env.local 提取键值（与 run-migration.mjs 相同逻辑） */
function envFromFile(filename) {
  try {
    const text = readFileSync(path.join(root, filename), "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.trim().startsWith("#")) {
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
      }
    }
    return out;
  } catch {
    return {};
  }
}

function resolveDatabaseUrl() {
  // 优先级：环境变量 > .env.local（本地惯例）
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  return envFromFile(".env.local").DATABASE_URL ?? "";
}

const url = resolveDatabaseUrl();
if (!url) {
  console.error("DATABASE_URL 未配置：请设置环境变量或 .env.local");
  process.exit(1);
}

// 与 lib/repo/pool.ts 一致：剥离 sslmode，避免 pg 解析为 verify-full
const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, "");
const pool = new pg.Pool({
  connectionString: cleanUrl,
  connectionTimeoutMillis: 10_000,
});

const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

async function main() {
  // 确保记录表存在
  await pool.query(`create table if not exists public.schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const { rows } = await pool.query(`select name from public.schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));
  const pending = files.filter((f) => !applied.has(f));

  // 保护分支：库已初始化（有业务表）但无迁移记录 → 说明此前是手工迁移（run-migration/SQL Editor）。
  // 此时盲目重放 001-015 会因表已存在而失败；让用户显式选择，避免误伤现有库。
  if (pending.length === files.length) {
    const hasData = await pool.query(
      `select to_regclass('public.profiles') is not null as has_profiles,
              to_regclass('public.schema_migrations') is not null as has_migrations`,
    );
    const legacy = hasData.rows[0]?.has_profiles === true;
    if (legacy) {
      console.error(
        "检测到库已包含业务表（profiles 已存在）但无 schema_migrations 记录：",
        "\n  这通常是历史手工迁移（run-migration / SQL Editor）的结果。",
        "\n  为避免重复应用破坏现有数据，请选择：",
        "\n    1) 手动把已应用的迁移文件名插入记录表，然后重跑本脚本；",
        "\n    2) 或对全新库使用本脚本（推荐流程）。",
        "\n  跳过执行，未做任何修改。",
      );
      process.exitCode = 1;
      await pool.end();
      return;
    }
  }

  if (pending.length === 0) {
    console.log(`migrations 已全部应用（${files.length}/${files.length}），无需执行`);
    await pool.end();
    return;
  }

  let ok = 0;
  for (const file of pending) {
    const client = await pool.connect();
    try {
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("begin");
      await client.query(sql);
      await client.query(`insert into public.schema_migrations (name) values ($1)`, [file]);
      await client.query("commit");
      console.log(`applied  ${file}`);
      ok += 1;
    } catch (error) {
      await client.query("rollback");
      console.error(`FAILED   ${file}: ${error.message}`);
      process.exitCode = 1;
      break; // 遇到失败停止，避免半套状态
    } finally {
      client.release();
    }
  }
  console.log(`setup-db 完成：本次应用 ${ok}/${pending.length}（跳过已应用 ${files.length - pending.length}）`);
  await pool.end();
}

main().catch(async (error) => {
  console.error("setup-db 异常:", error.message);
  process.exitCode = 1;
  await pool.end();
});
