#!/bin/bash
# Phase 2+3 端到端验收：Agent Context + 结构化晚报 + 幂等 + completed_at
# 前置：本地服务运行中（已执行 migration 005）
# 注意：请求体使用 ASCII（Windows Git Bash 下 curl -d 中文会 GBK 乱码）
API=http://127.0.0.1:3000
TS=$(date +%s)
UA="evening-a-$TS@growthloop.local"
PW="testpass123"

PY() { python -c "$1"; }

PASS=0
FAIL=0
check() { # $1=名称 $2=条件(0=成功)
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}

echo "=== 1. 注册用户 A ==="
RA=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\",\"displayName\":\"Evening-A\"}")
TA=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin).get('token',''))")
check "注册 A 拿到 token" $([ -n "$TA" ]; echo $?)

echo "=== 2. 记录 3 条今日行动（Agent 落库） ==="
for MSG in "Studied Agent tool calling for 45 minutes" "Went swimming 20 minutes this afternoon" "Reviewed English vocabulary before bed"; do
  R=$(curl -s -X POST $API/api/agent -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "{\"message\":\"$MSG\",\"conversationId\":\"e2e-evening\"}")
  echo "$R" | PY "
import sys,json
d=json.load(sys.stdin)
print('persisted:', d.get('persisted'), '| intent:', d.get('intent'))
assert d.get('persisted') is True, '记录应持久化'
"
  check "保存记录成功" $?
done

echo "=== 3. 完成任务（记录 completed_at） ==="
TASKS=$(curl -s -H "Authorization: Bearer $TA" $API/api/tasks)
TID=$(echo "$TASKS" | PY "
import sys,json
ts=json.load(sys.stdin)['tasks']
print(next((t['id'] for t in ts if t['status']=='upcoming'), ''))
")
if [ -n "$TID" ]; then
  curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "{\"taskId\":\"$TID\",\"done\":true}" > /dev/null
  TC=$(curl -s -H "Authorization: Bearer $TA" $API/api/tasks)
  echo "$TC" | PY "
import sys,json
ts=json.load(sys.stdin)['tasks']
t=[x for x in ts if x['id']=='$TID'][0]
print('status:', t['status'], '| completedAt:', t.get('completedAt'))
assert t['status']=='done' and t.get('completedAt'), '完成任务后应记录 completed_at'
"
  check "completedAt 已记录" $?
else
  echo "SKIP: 没有可完成的任务（用户无 seed 任务？）"
fi

echo "=== 4. 生成今日晚报（结构化 content） ==="
GEN=$(curl -s -w "\n%{http_code}" -X POST $API/api/evening-report -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{}')
GENCODE=$(echo "$GEN" | tail -1); GENBODY=$(echo "$GEN" | head -n -1)
check "生成晚报 200/201" $([ "$GENCODE" = "200" ] || [ "$GENCODE" = "201" ]; echo $?)
echo "$GENBODY" | PY "
import sys,json
d=json.load(sys.stdin)
r=d.get('report') or {}
c=r.get('content') or {}
print('created:', d.get('created'), '| summary:', (r.get('summary') or '')[:40])
print('content keys:', sorted(c.keys()))
assert isinstance(c.get('summary'), str) and c['summary'], 'content.summary 应为非空字符串'
for k in ('achievement','problem','suggestion'):
    assert isinstance(c.get(k), list) and all(isinstance(x,str) for x in c[k]), f'content.{k} 应为字符串数组'
assert isinstance(c.get('evaluation'), str), 'content.evaluation 应为字符串'
assert 'score' not in c, 'score 不应参与业务输出'
"
check "content 结构正确（无 score）" $?

echo "=== 5. 幂等：再次生成 created=false ==="
GEN2=$(curl -s -X POST $API/api/evening-report -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{}')
echo "$GEN2" | PY "
import sys,json
d=json.load(sys.stdin)
print('created:', d.get('created'))
assert d.get('created') is False, '重复生成应 created=false（幂等覆盖）'
"
check "重复生成幂等" $?

echo "=== 6. 今日查询接口返回 content ==="
TODAY=$(curl -s -H "Authorization: Bearer $TA" $API/api/evening-report/today)
echo "$TODAY" | PY "
import sys,json
d=json.load(sys.stdin)
r=d.get('report') or {}
print('today report:', 'YES' if r else 'NO', '| content:', 'YES' if r.get('content') else 'NO')
assert r and r.get('content'), 'today 接口应返回结构化 content'
"
check "today 接口返回 content" $?

echo ""
echo "==================== 结果汇总 ===================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = "0" ] && echo "e2e-evening-context: ALL PASSED" || echo "e2e-evening-context: HAS FAILURES"
exit $FAIL
