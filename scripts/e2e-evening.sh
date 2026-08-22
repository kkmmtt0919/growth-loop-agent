#!/bin/bash
# 晚间晚报闭环验证：用户模式 / 系统模式 / 幂等 / 并发唯一
API=http://127.0.0.1:3000
TS=$(date +%s)
UA="evening-a-$TS@growthloop.local"
UB="evening-b-$TS@growthloop.local"
PW="testpass123"
CRON=$(cat /tmp/cron-secret.txt)
PY() { python -c "$1"; }

echo "=== 1. 注册用户 A ==="
RA=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\"}")
TA=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
AID=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin)['profile']['id'])")
echo "A id: ${AID:0:8}... token len ${#TA}"

echo "=== 2. 用户模式生成今日晚报 ==="
R1=$(curl -s -X POST $API/api/evening-report -H "Authorization: Bearer $TA")
echo "$R1" | PY "
import sys,json
d=json.load(sys.stdin)
print('created:', d.get('created'), '| date:', d.get('date'))
r=d.get('report') or {}
print('summary 前 60 字:', (r.get('summary') or '')[:60])
print('questions 数:', len(r.get('questions') or []), '| sourceCount:', r.get('sourceCount'))
"
CREATED1=$(echo "$R1" | PY "import sys,json;print(json.load(sys.stdin).get('created'))")

echo "=== 3. 二次 POST（应 created=false，幂等） ==="
R2=$(curl -s -X POST $API/api/evening-report -H "Authorization: Bearer $TA")
CREATED2=$(echo "$R2" | PY "import sys,json;print(json.load(sys.stdin).get('created'))")
echo "created 第二次: $CREATED2（应为 False）"

echo "=== 4. GET today（应返回报告） ==="
G=$(curl -s $API/api/evening-report/today -H "Authorization: Bearer $TA")
echo "$G" | PY "
import sys,json
d=json.load(sys.stdin)
r=d.get('report')
print('report:', '存在' if r else 'null', '| date:', (r or {}).get('date'), '| summary 长度:', len((r or {}).get('summary') or ''))
"

echo "=== 5. 系统模式（CRON_SECRET + userId）生成用户 B ==="
RB=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UB\",\"password\":\"$PW\"}")
BID=$(echo "$RB" | PY "import sys,json;print(json.load(sys.stdin)['profile']['id'])")
RS=$(curl -s -X POST $API/api/evening-report -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" -d "{\"userId\":\"$BID\"}")
echo "$RS" | PY "
import sys,json
d=json.load(sys.stdin)
print('系统模式 created:', d.get('created'), '| 有 report:', 'report' in d)
"
echo "--- 系统模式缺 userId（应 400） ---"
curl -s -w " HTTP %{http_code}\n" -X POST $API/api/evening-report -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" -d '{}' | head -c 120

echo "=== 6. 并发双 POST（用户 A，应只有一行） ==="
curl -s -X POST $API/api/evening-report -H "Authorization: Bearer $TA" > /tmp/evening-conc-a.json &
curl -s -X POST $API/api/evening-report -H "Authorization: Bearer $TA" > /tmp/evening-conc-b.json &
wait
echo "--- 并发响应 created ---"
cat /tmp/evening-conc-a.json | PY "import sys,json;print('A:', json.load(sys.stdin).get('created'))"
cat /tmp/evening-conc-b.json | PY "import sys,json;print('B:', json.load(sys.stdin).get('created'))"

echo "=== 7. 查库确认当天唯一 ==="
cd "D:/122/Growth-loop/growth-loop-agent" && node -e "
import('node:fs').then(async (fs) => {
  const env = fs.readFileSync('.env.local','utf8');
  const url = env.split('\n').find(l=>l.startsWith('DATABASE_URL='))?.slice(13).trim().replace(/[?&]sslmode=[^&]*/g,'');
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: url });
  const { rows } = await pool.query(
    \"select user_id, report_date, count(*)::int as c from evening_reports where report_date = (now() at time zone 'Asia/Shanghai')::date group by user_id, report_date order by c desc\"
  );
  console.log('今日各用户晚报行数:', JSON.stringify(rows));
  const dup = rows.filter(r => r.c > 1);
  console.log(dup.length === 0 ? '✅ 无重复（幂等正确）' : '❌ 存在重复！');
  await pool.end();
}).catch(e => { console.error(e.message); process.exit(1); });
"
echo "DONE"
