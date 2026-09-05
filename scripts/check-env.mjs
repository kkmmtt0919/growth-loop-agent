/**
 * 环境变量启动前校验（Step 7a）。
 * 用法：node scripts/check-env.mjs [dev|prod]   （默认 dev）
 *
 * dev 模式：可选数据库（缺省时走 demo 回退），但 JWT_SECRET 缺失会警告。
 * prod 模式：DATABASE_URL / JWT_SECRET / CRON_SECRET 必填；LLM 配置缺失仅警告（规则回退仍可用）。
 * 退出码：0 = 可启动；1 = 阻断。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "dev";

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

// 读取顺序：进程 env > .env.local > .env.example 默认值（仅用于展示缺省说明）
const local = envFromFile(".env.local");
const example = envFromFile(".env.example");
const get = (key) => process.env[key] ?? local[key] ?? "";

const problems = [];
const warnings = [];

const db = get("DATABASE_URL");
const jwt = get("JWT_SECRET");
const cron = get("CRON_SECRET");

if (mode === "prod") {
  if (!db) problems.push("DATABASE_URL 必填（prod）");
  if (!jwt) problems.push("JWT_SECRET 必填（prod），用 node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\" 生成");
  if (!cron) problems.push("CRON_SECRET 必填（prod）：外部 Cron 调 POST /api/evening-report 需要");
  const llmKey = get("LLM_API_KEY");
  if (!llmKey) warnings.push("LLM_API_KEY 未配置：Agent 将退化为规则回退（对话/排程仍可用，效果降级）");
} else {
  // dev：无 DATABASE_URL = demo 回退（合法）；有 DB 但无 JWT 会登录/注册失败
  if (!db) {
    warnings.push("DATABASE_URL 未配置：运行在 demo 模式（页面数据不持久化，登录不可用）");
  } else if (!jwt) {
    problems.push("已配置 DATABASE_URL 但缺 JWT_SECRET：注册/登录会失败");
  }
}

const missing = [];
for (const key of ["DATABASE_URL", "JWT_SECRET", "CRON_SECRET"]) {
  if (!get(key) && !example[key]) missing.push(key);
}

for (const p of problems) console.error(`[check-env] ERROR  ${p}`);
for (const w of warnings) console.warn(`[check-env] warn   ${w}`);

if (problems.length > 0) {
  console.error(`[check-env] 校验未通过：${problems.length} 个阻断项（mode=${mode}）`);
  process.exit(1);
}
console.log(`[check-env] OK（mode=${mode}，${warnings.length} 条警告）`);
process.exit(0);
