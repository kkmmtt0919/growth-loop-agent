#!/bin/bash
# Phase 1 端到端验收：目标/任务 CRUD + 派生进度 + 防重复 + 隔离 + 账本保护
# 前置：本地服务运行中（npm run dev / npm run start），数据库已执行 migration 004
# 注意：curl 请求体使用 ASCII 标题（Windows Git Bash 下 curl -d 中文会因 GBK 编码乱码，
#       浏览器 fetch 走 UTF-8 不受影响；中文标题的正确性由手动页面验收覆盖）
API=http://127.0.0.1:3000
TS=$(date +%s)
UA="goals-a-$TS@growthloop.local"
UB="goals-b-$TS@growthloop.local"
PW="testpass123"

PY() { python -c "$1"; }

PASS=0
FAIL=0
check() { # $1=名称 $2=条件(0=成功)
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}

echo "=== 1. 注册用户 A ==="
RA=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\",\"displayName\":\"Goal-A\"}")
TA=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin).get('token',''))")
check "注册 A 拿到 token" $([ -n "$TA" ]; echo $?)

echo "=== 2. A 创建目标 ==="
G=$(curl -s -w "\n%{http_code}" -X POST $API/api/goals -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"title":"English in 6 months","description":"vocab and listening","startDate":"2026-08-24","endDate":"2027-02-24","horizon":"half year"}')
GCODE=$(echo "$G" | tail -1); GBODY=$(echo "$G" | head -n -1)
GID=$(echo "$GBODY" | PY "import sys,json;print(json.load(sys.stdin)['goal']['id'])")
check "创建目标 201" $([ "$GCODE" = "201" ]; echo $?)

echo "=== 3. A 为目标拆两个任务 ==="
T1=$(curl -s -w "\n%{http_code}" -X POST $API/api/tasks -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "{\"title\":\"30 words daily\",\"goalId\":\"$GID\",\"frequency\":\"daily\",\"kind\":\"learn\",\"durationMinutes\":25}")
T1CODE=$(echo "$T1" | tail -1); T1BODY=$(echo "$T1" | head -n -1)
T1ID=$(echo "$T1BODY" | PY "import sys,json;print(json.load(sys.stdin)['task']['id'])")
check "创建任务1 201" $([ "$T1CODE" = "201" ]; echo $?)

T2=$(curl -s -w "\n%{http_code}" -X POST $API/api/tasks -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "{\"title\":\"weekly quiz\",\"goalId\":\"$GID\",\"frequency\":\"weekly\",\"kind\":\"learn\",\"durationMinutes\":40}")
T2CODE=$(echo "$T2" | tail -1)
T2ID=$(echo "$T2" | head -n -1 | PY "import sys,json;print(json.load(sys.stdin)['task']['id'])")
check "创建任务2 201" $([ "$T2CODE" = "201" ]; echo $?)

echo "=== 4. 防重复：同目标同标题再次创建 → 409 ==="
TDUP=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/api/tasks -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "{\"title\":\"30 words daily\",\"goalId\":\"$GID\"}")
check "重复任务 409" $([ "$TDUP" = "409" ]; echo $?)

echo "=== 5. 派生进度：初始 0/2，完成后 1/2=50 ==="
GL1=$(curl -s -H "Authorization: Bearer $TA" $API/api/goals)
echo "$GL1" | PY "
import sys,json
gs=json.load(sys.stdin)['goals']
g=[x for x in gs if x['id']=='$GID'][0]
print('progress:', g['progress'], '| taskCount:', g['taskCount'], '| doneCount:', g['doneCount'])
assert g['taskCount']==2 and g['doneCount']==0 and g['progress']==0, '初始派生不正确'
"
check "初始派生 progress=0 taskCount=2" $?

curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "{\"taskId\":\"$T1ID\",\"done\":true}" > /dev/null
GL2=$(curl -s -H "Authorization: Bearer $TA" $API/api/goals)
echo "$GL2" | PY "
import sys,json
g=[x for x in json.load(sys.stdin)['goals'] if x['id']=='$GID'][0]
print('progress:', g['progress'], '| doneCount:', g['doneCount'])
assert g['doneCount']==1 and g['progress']==50, '完成 1 个任务后派生应为 50'
"
check "完成 1 任务后 progress=50" $?

echo "=== 6. PUT 目标编辑：改标题；PUT 带 progress 被拒 ==="
PUT1=$(curl -s -w "\n%{http_code}" -X PUT $API/api/goals/$GID -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"title":"English in 6 months (revised)"}')
PUT1CODE=$(echo "$PUT1" | tail -1)
check "PUT 目标 200" $([ "$PUT1CODE" = "200" ]; echo $?)

GL3=$(curl -s -H "Authorization: Bearer $TA" $API/api/goals)
echo "$GL3" | PY "
import sys,json
g=[x for x in json.load(sys.stdin)['goals'] if x['id']=='$GID'][0]
assert g['title']=='English in 6 months (revised)', '标题未更新'
"
check "目标标题已更新" $?

PUTG1=$(curl -s -o /dev/null -w "%{http_code}" -X PUT $API/api/goals/$GID -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"progress":99}')
check "PUT goal 带 progress → 400" $([ "$PUTG1" = "400" ]; echo $?)

echo "=== 7. PUT 任务拒绝 status/xp/coin（账本保护）==="
PUTT1=$(curl -s -o /dev/null -w "%{http_code}" -X PUT $API/api/tasks/$T2ID -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"title":"weekly quiz (edited)","xp":999}')
check "PUT task 带 xp → 400" $([ "$PUTT1" = "400" ]; echo $?)

PUTT2=$(curl -s -o /dev/null -w "%{http_code}" -X PUT $API/api/tasks/$T2ID -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"status":"done"}')
check "PUT task 带 status → 400" $([ "$PUTT2" = "400" ]; echo $?)

echo "=== 8. DELETE 任务（不冲正账本）与 DELETE 目标（任务保留）==="
curl -s -o /dev/null -w "" -X DELETE $API/api/tasks/$T2ID -H "Authorization: Bearer $TA"
GL4=$(curl -s -H "Authorization: Bearer $TA" $API/api/goals)
echo "$GL4" | PY "
import sys,json
g=[x for x in json.load(sys.stdin)['goals'] if x['id']=='$GID'][0]
print('删除任务后 taskCount:', g['taskCount'])
assert g['taskCount']==1, '删除任务后 taskCount 应为 1'
"
check "删除任务后 taskCount=1" $?

curl -s -o /dev/null -w "" -X DELETE $API/api/goals/$GID -H "Authorization: Bearer $TA"
TL1=$(curl -s -H "Authorization: Bearer $TA" $API/api/tasks)
echo "$TL1" | PY "
import sys,json
ts=json.load(sys.stdin)['tasks']
kept=[t for t in ts if t['title']=='30 words daily']
print('删除目标后任务总数:', len(ts), '| 保留的拆解任务:', len(kept))
assert len(kept)==1, '目标删除后其拆解任务应保留（goal_id 置空）'
"
check "删除目标后拆解任务保留" $?

echo "=== 9. 多用户隔离：B 看不到 A 的目标，越权操作 404 ==="
RB=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UB\",\"password\":\"$PW\",\"displayName\":\"Goal-B\"}")
TB=$(echo "$RB" | PY "import sys,json;print(json.load(sys.stdin).get('token',''))")
GB=$(curl -s -H "Authorization: Bearer $TB" $API/api/goals)
echo "$GB" | PY "
import sys,json
gs=json.load(sys.stdin)['goals']
ids=[g['id'] for g in gs]
print('用户 B goals 数:', len(gs), '（2 = B 自己的 seed，不含 A 的目标）')
assert '$GID' not in ids, 'B 不应看到 A 的目标'
"
check "B 的目标不含 A 的 id" $?

if [ -n "$GID" ]; then
  C1=$(curl -s -o /dev/null -w "%{http_code}" -X PUT $API/api/goals/$GID -H "Authorization: Bearer $TB" -H "Content-Type: application/json" -d '{"title":"hack"}')
  check "B 越权 PUT A 的目标 → 404" $([ "$C1" = "404" ]; echo $?)
  C2=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE $API/api/goals/$GID -H "Authorization: Bearer $TB")
  check "B 越权 DELETE A 的目标 → 404" $([ "$C2" = "404" ]; echo $?)
fi

echo ""
echo "==================== 结果汇总 ===================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = "0" ] && echo "e2e-goals: ALL PASSED" || echo "e2e-goals: HAS FAILURES"
exit $FAIL
