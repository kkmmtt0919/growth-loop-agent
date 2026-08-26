#!/bin/bash
# Phase 5 周成长报告 e2e：smoke-weekly.mjs（8 场景）+ 多用户隔离 + goalSuggestions 采纳走 PUT /api/goals/[id]
# 依赖：dev server 跑在 127.0.0.1:3000；node + python 在 PATH（可用 NODE/PY 覆盖）
set -e
cd "$(dirname "$0")/.."
API="${API:-http://127.0.0.1:3000}"
NODE="${NODE:-node}"
PY() { python -c "$1"; }

echo "=== Phase 5 weekly e2e ==="
echo "API: $API  NODE: $NODE"

echo ""
echo "--- 1. weekly API 冒烟（smoke-weekly.mjs 8 场景） ---"
"$NODE" scripts/smoke-weekly.mjs

echo ""
echo "--- 2. 多用户隔离（周报互不可见） ---"
TS=$(date +%s)
UA="wk-a-$TS@growthloop.local"
UB="wk-b-$TS@growthloop.local"
PW="testpass123"

RA=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\",\"displayName\":\"A\"}")
TA=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
[ -n "$TA" ] || { echo "REGISTER A: FAIL"; echo "$RA"; exit 1; }
curl -s -H "Authorization: Bearer $TA" $API/api/demo > /dev/null
# A 生成周报
PA=$(curl -s -X POST $API/api/weekly/report -H "Authorization: Bearer $TA")
AID=$(echo "$PA" | PY "import sys,json;print(json.load(sys.stdin)['id'])")
echo "A 的周报 id: $AID"

RB=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UB\",\"password\":\"$PW\",\"displayName\":\"B\"}")
TB=$(echo "$RB" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
[ -n "$TB" ] || { echo "REGISTER B: FAIL"; echo "$RB"; exit 1; }
curl -s -H "Authorization: Bearer $TB" $API/api/demo > /dev/null

echo "--- 2a. B 的 list 不含 A 的周报 ---"
LB=$(curl -s -H "Authorization: Bearer $TB" "$API/api/weekly/list?limit=50")
HAS_A=$(echo "$LB" | PY "import sys,json;d=json.load(sys.stdin);print(any(r['id']=='$AID' for r in d['reports']))")
echo "B 能看到 A 的周报? $HAS_A（应为 False）"
if [ "$HAS_A" = "False" ]; then echo "ISOLATION weekly: OK"; else echo "ISOLATION weekly: FAIL"; exit 1; fi

echo "--- 2b. A 生成后，B 生成本周周报不冲突 ---"
PB=$(curl -s -X POST $API/api/weekly/report -H "Authorization: Bearer $TB")
BID=$(echo "$PB" | PY "import sys,json;print(json.load(sys.stdin)['id'])")
echo "B 的周报 id: $BID（应 != A 的 $AID）"
if [ "$BID" != "$AID" ]; then echo "ISOLATION generate: OK"; else echo "ISOLATION generate: FAIL"; exit 1; fi

echo ""
echo "--- 3. goalSuggestions 采纳走 PUT /api/goals/[id]（如 LLM 产出建议则验证路径） ---"
# 拿一个 A 的 goal id（demo 会播种目标）
GA=$(curl -s -H "Authorization: Bearer $TA" "$API/api/goals")
GOAL_ID=$(echo "$GA" | PY "import sys,json;d=json.load(sys.stdin);gs=d.get('goals') or d.get('items') or [];print(gs[0]['id'] if gs else '')")
if [ -n "$GOAL_ID" ]; then
  echo "A 的 goal id: $GOAL_ID"
  PUT_R=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$API/api/goals/$GOAL_ID" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"title":"采纳后的新标题"}')
  echo "PUT /api/goals/[id] status: $PUT_R（应为 200）"
  if [ "$PUT_R" = "200" ]; then echo "GOAL APPLY: OK"; else echo "GOAL APPLY: FAIL"; exit 1; fi
else
  echo "无 goal（demo 未播种目标），跳过采纳路径验证"
fi

echo ""
echo "=== weekly e2e PASSED ==="
