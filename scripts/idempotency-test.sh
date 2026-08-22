#!/bin/bash
# 账本幂等验证：任务 toggle 重复执行不重复入账
API=http://127.0.0.1:3000
TS=$(date +%s)
EMAIL="idem-$TS@growthloop.local"
PW="testpass123"
PY() { python -c "$1"; }

R=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
T=$(echo "$R" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
echo "注册用户 C: OK"

# 取第一个任务的 id 和 xp
D=$(curl -s -H "Authorization: Bearer $T" $API/api/demo)
TASK_ID=$(echo "$D" | PY "import sys,json;d=json.load(sys.stdin)['data'];print(d['tasks'][0]['id'])")
TASK_XP=$(echo "$D" | PY "import sys,json;d=json.load(sys.stdin)['data'];print(d['tasks'][0]['xp'])")
XP0=$(echo "$D" | PY "import sys,json;print(json.load(sys.stdin)['data']['user']['xpBalance'])")
echo "任务 id: ${TASK_ID:0:8}... xp=$TASK_XP | 初始 xp=$XP0"

XP() { curl -s -H "Authorization: Bearer $T" $API/api/demo | PY "import sys,json;print(json.load(sys.stdin)['data']['user']['xpBalance'])"; }

echo "--- 1. 完成任务（应 +$TASK_XP） ---"
curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"taskId\":\"$TASK_ID\",\"done\":true}" > /dev/null
echo "xp 现在: $(XP)"

echo "--- 2. 再次完成（已 done，应不重复入账） ---"
curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"taskId\":\"$TASK_ID\",\"done\":true}" > /dev/null
echo "xp 现在: $(XP)"

echo "--- 3. 撤销（应 -$TASK_XP 冲正） ---"
curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"taskId\":\"$TASK_ID\",\"done\":false}" > /dev/null
echo "xp 现在: $(XP)"

echo "--- 4. 再完成（应 +$TASK_XP，undo key 不冲突） ---"
curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"taskId\":\"$TASK_ID\",\"done\":true}" > /dev/null
echo "xp 现在: $(XP)"

echo "--- 5. 撤销再完成一次（总账应只净 +$TASK_XP 或按操作次数正确） ---"
curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"taskId\":\"$TASK_ID\",\"done\":false}" > /dev/null
curl -s -X PATCH $API/api/tasks -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"taskId\":\"$TASK_ID\",\"done\":true}" > /dev/null
echo "xp 现在: $(XP)"
echo "DONE"
