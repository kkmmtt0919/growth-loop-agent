#!/bin/bash
# Agent Decompose V1 端到端验收：拆解（多步/验收标准/类别映射/增量/撤销/越权）
# 前置：本地服务运行中（已执行 migration 006）
# 注意：请求体使用 ASCII（Windows Git Bash 下 curl -d 中文会 GBK 乱码）
API=http://127.0.0.1:3000
TS=$(date +%s)
UA="deco-a-$TS@growthloop.local"
UB="deco-b-$TS@growthloop.local"
PW="testpass123"

PY() { python -c "$1"; }

PASS=0
FAIL=0
check() { # $1=名称 $2=条件(0=成功)
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}

echo "=== 1. 注册用户 A ==="
RA=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\",\"displayName\":\"Deco-A\"}")
TA=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin).get('token',''))")
check "注册 A 拿到 token" $([ -n "$TA" ]; echo $?)

echo "=== 2. 建目标（有描述 + end_date 30 天后 → 档位 3-4 步）==="
END=$(TZ=Asia/Shanghai date -d "+30 days" "+%Y-%m-%d")
G=$(curl -s -X POST $API/api/goals -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "{\"title\":\"Learn SQL basics in 30 days\",\"description\":\"query and schema design\",\"endDate\":\"$END\",\"horizon\":\"1 month goal\"}")
GID=$(echo "$G" | PY "import sys,json;print(json.load(sys.stdin)['goal']['id'])")
check "创建目标" $([ -n "$GID" ]; echo $?)

echo "=== 3. 拆解：多步 + 结构合法 ==="
D=$(curl -s -w "\n%{http_code}" -X POST $API/api/goals/$GID/decompose -H "Authorization: Bearer $TA")
DCODE=$(echo "$D" | tail -1); DBODY=$(echo "$D" | head -n -1)
check "decompose 200" $([ "$DCODE" = "200" ]; echo $?)
echo "$DBODY" | PY "
import sys,json
d=json.load(sys.stdin)
print('count:', d.get('count'), '| source:', d.get('source'))
assert d.get('success') is True
assert 2 <= d.get('count',0) <= 8, '步数应在档位范围内'
assert d.get('source') in ('llm','rules'), 'source 应为 llm 或 rules'
assert len(d.get('createdTaskIds',[])) == d['count']
for t in d.get('tasks',[]):
    assert t['kind'] in ('focus','learn','exercise','life','rest'), f\"kind 不合法: {t['kind']}\"
    assert t['acceptance'], 'acceptance 不能为空'
    assert t['status'] == 'upcoming'
    assert t['duration'] != '—', 'duration 应有值'
print('tasks kinds:', [t['kind'] for t in d['tasks']])
print('acceptance sample:', d['tasks'][0]['acceptance'][:30])
"
check "拆解结构与验收标准合法" $?

echo "=== 4. 增量拆：第二次与第一次标题不重复 ==="
D2=$(curl -s -X POST $API/api/goals/$GID/decompose -H "Authorization: Bearer $TA")
echo "$D2" | PY "
import sys,json
d=json.load(sys.stdin)
print('second count:', d.get('count'), '| source:', d.get('source'))
assert d.get('success') is True
"
TITLES1=$(echo "$DBODY" | PY "import sys,json;d=json.load(sys.stdin);print('\n'.join(t['title'] for t in d['tasks']))")
TITLES2=$(echo "$D2" | PY "import sys,json;d=json.load(sys.stdin);print('\n'.join(t['title'] for t in d['tasks']))")
DUP=$(python - "$TITLES1" "$TITLES2" <<'EOF'
import sys
a=set(sys.argv[1].splitlines()); b=set(sys.argv[2].splitlines())
overlap=a&b
print(len(overlap))
EOF
)
check "增量拆无重复标题（重叠=$DUP）" $([ "$DUP" = "0" ]; echo $?)

echo "=== 5. 撤销：batch 删除 → 任务消失 ==="
IDS=$(echo "$D2" | PY "import sys,json;d=json.load(sys.stdin);print(','.join(d['createdTaskIds']))")
echo "$D2" | PY "
import sys,json
d=json.load(sys.stdin)
ids=d.get('createdTaskIds',[])
print('deleting', len(ids), 'tasks')
"
IDS_JSON=$(echo "$D2" | PY "import sys,json;d=json.load(sys.stdin);print(json.dumps({'ids':d['createdTaskIds']}))")
DEL=$(curl -s -X DELETE $API/api/tasks/batch -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d "$IDS_JSON")
echo "$DEL" | PY "import sys,json;d=json.load(sys.stdin);print('deleted:', d.get('deleted'));assert d.get('deleted',0) > 0"
check "batch 删除成功" $?
TL=$(curl -s -H "Authorization: Bearer $TA" "$API/api/tasks?goalId=$GID")
echo "$TL" | PY "
import sys,json
ts=json.load(sys.stdin)['tasks']
ids='$IDS'.split(',')
left=[t for t in ts if t['id'] in ids]
print('撤销后残留:', len(left))
assert len(left)==0, '撤销后任务应消失'
"
check "撤销后任务消失" $?

echo "=== 6. 空描述目标仍可拆 ==="
G2=$(curl -s -X POST $API/api/goals -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"title":"No description goal"}')
G2ID=$(echo "$G2" | PY "import sys,json;print(json.load(sys.stdin)['goal']['id'])")
D3=$(curl -s -w "\n%{http_code}" -X POST $API/api/goals/$G2ID/decompose -H "Authorization: Bearer $TA")
D3CODE=$(echo "$D3" | tail -1)
check "空描述目标拆解 200" $([ "$D3CODE" = "200" ]; echo $?)
echo "$D3" | head -n -1 | PY "import sys,json;d=json.load(sys.stdin);print('count:', d.get('count'));assert d.get('count',0) >= 1"
check "空描述目标至少 1 步" $?

echo "=== 7. 越权：B 拆 A 的目标 → 404 ==="
RB=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UB\",\"password\":\"$PW\",\"displayName\":\"Deco-B\"}")
TB=$(echo "$RB" | PY "import sys,json;print(json.load(sys.stdin).get('token',''))")
C1=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/api/goals/$GID/decompose -H "Authorization: Bearer $TB")
check "B 越权拆解 → 404" $([ "$C1" = "404" ]; echo $?)

echo ""
echo "==================== 结果汇总 ===================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = "0" ] && echo "e2e-decompose: ALL PASSED" || echo "e2e-decompose: HAS FAILURES"
exit $FAIL
