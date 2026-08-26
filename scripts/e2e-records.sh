#!/bin/bash
# Phase 4 记录查询 e2e：复用 smoke-records.mjs（11 场景）+ 多用户隔离越权 + 回归
# 依赖：dev server 跑在 127.0.0.1:3000；node + python 在 PATH（或用 NODE/PY 环境变量覆盖）
set -e
cd "$(dirname "$0")/.."
API="${API:-http://127.0.0.1:3000}"
NODE="${NODE:-node}"
PY() { python -c "$1"; }

echo "=== Phase 4 records e2e ==="
echo "API: $API  NODE: $NODE"

echo ""
echo "--- 1. records API 冒烟（smoke-records.mjs 11 场景） ---"
"$NODE" scripts/smoke-records.mjs

echo ""
echo "--- 2. 多用户隔离（越权） ---"
TS=$(date +%s)
UA="rec-a-$TS@growthloop.local"
UB="rec-b-$TS@growthloop.local"
PW="testpass123"

RA=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\",\"displayName\":\"A\"}")
TA=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
[ -n "$TA" ] || { echo "REGISTER A: FAIL"; echo "$RA"; exit 1; }
# A 播种
curl -s -H "Authorization: Bearer $TA" $API/api/demo > /dev/null
# A 拿一个 record id
HA=$(curl -s -H "Authorization: Bearer $TA" "$API/api/records/history?limit=1")
RID=$(echo "$HA" | PY "import sys,json;print(json.load(sys.stdin)['items'][0]['id'])")
echo "A 的 record id: $RID"

# 注册 B + 播种
RB=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UB\",\"password\":\"$PW\",\"displayName\":\"B\"}")
TB=$(echo "$RB" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
[ -n "$TB" ] || { echo "REGISTER B: FAIL"; echo "$RB"; exit 1; }
curl -s -H "Authorization: Bearer $TB" $API/api/demo > /dev/null

echo ""
echo "--- 2a. B 的 history 不含 A 的记录 ---"
HB=$(curl -s -H "Authorization: Bearer $TB" "$API/api/records/history?limit=200")
HAS_A=$(echo "$HB" | PY "import sys,json;d=json.load(sys.stdin);print(any(i['id']=='$RID' for i in d['items']))")
echo "B 能看到 A 的记录? $HAS_A（应为 False）"
if [ "$HAS_A" = "False" ]; then echo "ISOLATION history: OK"; else echo "ISOLATION history: FAIL"; exit 1; fi

echo "--- 2b. B PATCH A 的 record → 404 ---"
PB=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/api/records/$RID" -H "Authorization: Bearer $TB" -H "Content-Type: application/json" -d '{"mood":"good"}')
echo "B PATCH A 的 record status: $PB（应为 404）"
if [ "$PB" = "404" ]; then echo "ISOLATION patch: OK"; else echo "ISOLATION patch: FAIL"; exit 1; fi

echo "--- 2c. B 的 recent 不含 A 的记录 ---"
RB2=$(curl -s -H "Authorization: Bearer $TB" "$API/api/records/recent?days=7")
REC_A_IN_B=$(echo "$RB2" | PY "import sys,json;d=json.load(sys.stdin);print(any(r['id']=='$RID' for day in d['days'] for r in day['records']))")
echo "B 的 recent 含 A 的记录? $REC_A_IN_B（应为 False）"
if [ "$REC_A_IN_B" = "False" ]; then echo "ISOLATION recent: OK"; else echo "ISOLATION recent: FAIL"; exit 1; fi

echo "--- 2d. A 仍能操作自己的 record ---"
PA=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/api/records/$RID" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"mood":"great"}')
echo "A PATCH 自己 record status: $PA（应为 200）"
if [ "$PA" = "200" ]; then echo "OWNER patch: OK"; else echo "OWNER patch: FAIL"; exit 1; fi

echo ""
echo "=== records e2e PASSED ==="
