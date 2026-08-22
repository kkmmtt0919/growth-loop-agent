#!/bin/bash
# 端到端闭环验证：注册→播种→保存→重登→数据还在→多用户隔离
API=http://127.0.0.1:3000
TS=$(date +%s)
UA="user-a-$TS@growthloop.local"
UB="user-b-$TS@growthloop.local"
PW="testpass123"

PY() { python -c "$1"; }

echo "=== 1. 注册用户 A ==="
RA=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\",\"displayName\":\"验证A\"}")
TA=$(echo "$RA" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
echo "token A length: ${#TA}"
[ -n "$TA" ] && echo "REGISTER A: OK" || { echo "REGISTER A: FAIL"; echo "$RA"; exit 1; }

echo "=== 2. 用户 A 加载工作台（首登播种） ==="
RD=$(curl -s -H "Authorization: Bearer $TA" $API/api/demo)
echo "$RD" | PY "
import sys,json
d=json.load(sys.stdin)
print('mode:', d['mode'])
data=d['data']
print('goals:', len(data['goals']), '| tasks:', len(data['tasks']), '| records:', len(data['learningLogs']), '| ledger:', len(data['ledger']))
print('user:', data['user']['displayName'], 'xp:', data['user']['xpBalance'], 'coin:', data['user']['coinBalance'])
"

echo "=== 3. 保存一条记录 ==="
REC=$(curl -s -X POST $API/api/agent -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"message":"今天学习了 Agent 的工具调用，理解了它和普通聊天的区别","conversationId":"e2e-a"}')
echo "$REC" | PY "
import sys,json
d=json.load(sys.stdin)
print('persisted:', d.get('persisted'), '| intent:', d.get('intent'), '| replySource:', d.get('replySource'))
r=d.get('record') or {}
print('record id:', r.get('id','NONE'), '| xp:', r.get('xp'), '| topic:', (r.get('topic') or '')[:20])
"

echo "=== 4. 再保存一条（第二条记录） ==="
REC2=$(curl -s -X POST $API/api/agent -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"message":"晚上散步 20 分钟，放松了一下","conversationId":"e2e-a"}')
echo "$REC2" | PY "
import sys,json
d=json.load(sys.stdin)
print('persisted:', d.get('persisted'), '| record id:', (d.get('record') or {}).get('id','NONE'))
"

echo "=== 5. 重新登录（模拟退出后重登） ==="
RL=$(curl -s -X POST $API/api/auth/login -H "Content-Type: application/json" -d "{\"email\":\"$UA\",\"password\":\"$PW\"}")
TL=$(echo "$RL" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
echo "token A(relogin) length: ${#TL}"
RD2=$(curl -s -H "Authorization: Bearer $TL" $API/api/demo)
echo "$RD2" | PY "
import sys,json
d=json.load(sys.stdin)
data=d['data']
print('重登后 records:', len(data['learningLogs']), '| xp:', data['user']['xpBalance'], '| coin:', data['user']['coinBalance'])
"

echo "=== 6. 多用户隔离：注册用户 B ==="
RB=$(curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$UB\",\"password\":\"$PW\",\"displayName\":\"验证B\"}")
TB=$(echo "$RB" | PY "import sys,json;print(json.load(sys.stdin)['token'])")
RD3=$(curl -s -H "Authorization: Bearer $TB" $API/api/demo)
echo "$RD3" | PY "
import sys,json
d=json.load(sys.stdin)
data=d['data']
print('用户 B 的 records:', len(data['learningLogs']), '（应为 3 = B 自己的 seed，不含 A 新增的 2 条）')
print('用户 B 的 xp:', data['user']['xpBalance'], '（应为 25 = B 自己的 seed 账本，非 A 累加值）')
"
echo "DONE"
