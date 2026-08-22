# 成长回路开发者与 AI 手册

这份手册面向第一次接手仓库的开发者、自动化 Agent 和后续维护者。目标是让一个新环境在不猜测项目结构的情况下完成：本地启动、LLM 配置、API 回归、微信接入理解、Android 模拟器调试和发布前检查。

## 1. 先读什么

按下面顺序阅读：

1. `README.md`：项目范围、快速启动和入口索引。
2. `AGENTS.md`：当前 Next.js 版本的仓库约束。
3. `.project-to-act/PROJECT_OVERVIEW.md`：目标、范围和当前焦点。
4. 本手册：实施、测试和交付流程。
5. 如果是新环境，先按 `docs/WEB_SERVICE_SETUP.md` 配好 Web 服务；不要把仓库当成纯静态网页。
6. 按任务打开 `docs/WECHAT_INTEGRATION.md`、`docs/ANDROID_BUILD.md` 或 `docs/ANDROID_APK_DEBUG_AI.md`。

项目台账是长期事实源。修改产品范围、功能、版本、验收或发布状态时，要同步对应的 `.project-to-act` 文件，并用 `init_project_management.py --validate` 检查。

## 2. 项目结构

```text
app/
  page.tsx                    桌面 Web 工作台和业务状态编排
  mobile-shell.tsx            Android/窄屏独立移动壳 v4
  globals.css                 桌面与移动视觉样式
  api/agent/route.ts          Agent 对话 API
  api/quiz/route.ts           出题与评分 API
  api/demo/route.ts           确定性 demo 数据 API
  api/wechat/route.ts         微信签名、XML 回调和回复
  api/wechat/status/route.ts  非敏感配置状态
lib/
  demo-data.ts                目标、任务、记录和账本 seed
  agent/provider.ts           LLM 配置、规则解析、回退和 Agent 会话
  agent/understanding.ts      意图、类别和 AI Agent 路线解析
  agent/session.ts            本机原型会话状态
  agent/quiz.ts               出题、JSON 解析、LLM/规则评分
  wechat/adapter.ts           微信 XML 与 SHA-1 签名工具
android/                      Capacitor Android 工程
artifacts/android/            已提交的 debug APK
scripts/                      Android 构建、模拟器和 WebView CDP 检查
docs/                         产品、微信、Android 和交接文档
.project-to-act/              项目目标、进度、功能、版本和验收证据
```

## 3. 本地启动

> Web 入口必须由 Next.js 服务提供。首页的 HTML 可以被预渲染，但 `/api/*` 和客户端交互不能通过 `file://`、GitHub Pages 或 `out/index.html` 工作。完整的跨机器配置步骤见 [网页服务配置手册](WEB_SERVICE_SETUP.md)。

### 3.1 安装依赖

```powershell
Set-Location F:\Codex\自我成长AI
npm.cmd install
Copy-Item -LiteralPath .env.example -Destination .env.local -Force
```

`.env.local` 可以保持 demo 配置。它只在本机使用，不要提交。

### 3.2 开发模式

```powershell
npm.cmd run dev
```

浏览器访问 `http://127.0.0.1:3000/`。需要模拟器回归时，建议另开终端使用生产构建：

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000
```

### 3.3 基础检查

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

失败时先修复命令自身报告的问题，再继续 Android 或远程发布。不要用“页面看起来能打开”代替构建和类型检查。

### 3.4 服务验收

至少确认以下三个请求都能返回：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/
Invoke-RestMethod http://127.0.0.1:3000/api/demo
Invoke-RestMethod http://127.0.0.1:3000/api/agent
```

没有 LLM 配置时，`/api/agent` 返回 `mode=demo` 和规则回复是预期结果，不是服务故障。静态文件能打开但这些 API 失败，说明启动方式不正确或反向代理没有转发 `/api/*`。

## 4. Agent 与 LLM

### 4.1 调用链

```text
用户消息
  -> parseAction（意图、类别、主题、时长、缺失字段）
  -> buildActionReply（规则底稿）
  -> 可选 /chat/completions（短中文回复）
  -> 校验回复是否可用
  -> 不可用或超时时返回规则底稿
```

`lib/agent/provider.ts` 中的规则结果是事实底稿。模型不能自行改写类别、XP、积分或数据库状态；它只负责解释、建议和结构化引导。`conversationId` 目前用于本机原型会话，不等于生产用户账户。

### 4.2 配置方式

默认值：

```dotenv
LLM_PROVIDER=demo
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

当 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 三项都有值时，服务端会调用 `${LLM_BASE_URL}/chat/completions`。也可以使用 provider 专属变量：

```text
OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY / DEEPSEEK_MODEL
GLM_BASE_URL / GLM_API_KEY / GLM_MODEL
```

不要在 README、源码、日志、截图或 Git 提交中出现真实密钥。部署时使用平台 Secret；本机可用受管配置工具注入。

### 4.3 回退语义

- 未配置模型：`mode=demo`、`replySource=rules`。
- 模型 HTTP 非 2xx、超时或返回空/不符合目标时：继续返回规则回复。
- 微信文本回调使用 3.8 秒超时，避免微信请求无限等待。
- `/api/agent` 的 GET 和 `/api/wechat/status` 只返回非敏感状态。

## 5. API 回归手册

### 5.1 Agent

状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/agent
```

请求：

```powershell
$body = @{
  message = '今天学习了 Agent 的工具调用，并写了一个最小例子'
  conversationId = 'manual-user'
  output = '能说出工具调用的输入、执行和结果三个阶段'
  context = '学习路线：学习 Agent 并开发自己的 Agent'
} | ConvertTo-Json

$result = Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3000/api/agent `
  -ContentType 'application/json' `
  -Body $body
$result | ConvertTo-Json -Depth 8
```

必填字段只有 `message`。如果传 `output`，解析结果会把它作为成果证据；如果传 `context`，模型可以用它完成晚报或路线引导。

### 5.2 生成理解题

```powershell
$body = @{
  action = 'generate'
  topic = 'Agent 工具调用'
  content = 'Agent 会理解目标、选择工具、读取结果并继续行动。'
  output = '我能解释工具调用和普通聊天的区别。'
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3000/api/quiz `
  -ContentType 'application/json' `
  -Body $body | ConvertTo-Json -Depth 8
```

接口返回 2–3 道开放题。题目应该检查概念、迁移和教回，而不是考记忆细节。

### 5.3 提交评分

评分请求需要 `action=grade`、`topic`、`source`、`questions` 和 `answers`。题目对象至少包含 `id`、`prompt`；回答按题目 id 放在 `answers` 中。LLM 评分必须返回合法 JSON，否则自动使用规则评分，并明确 `gradedBy=rules`。

### 5.4 Demo 和微信状态

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/demo | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:3000/api/wechat/status | ConvertTo-Json
```

## 6. 微信接入流程

### 6.1 本地代码边界

`GET /api/wechat`：校验 `signature`、`timestamp`、`nonce`，成功后原样返回 `echostr`。

`POST /api/wechat`：校验签名、解析 XML、只处理文字消息，调用 Agent 后返回 XML 文本；非文字消息返回提示语。

`GET /api/wechat/status`：返回 AppId、Token、AES Key 是否配置，不返回具体值。

### 6.2 公众平台配置

生产接入前需要：

1. 公网 HTTPS（微信服务器不能访问本机 `127.0.0.1`）。
2. 在部署平台注入 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_TOKEN`。
3. 服务器 URL 使用 `https://域名/api/wechat`。
4. MVP 选择明文模式，完成首次签名验证。
5. 用真实文本消息做成功、超时、模型回退和异常签名回归。

当前没有启用 `WECHAT_ENCODING_AES_KEY` 对应的密文解密流程。若切换到安全/兼容模式，应先补齐加密解析、重放保护、限流、幂等和审计，再进入生产。

## 7. Android 电脑模拟器

### 7.1 地址规则

| 场景 | 地址 |
|---|---|
| Windows 浏览器 | `http://127.0.0.1:3000/` |
| Android Emulator WebView | `http://10.0.2.2:3000/` |
| 生产/部署 | `CAPACITOR_SERVER_URL` 指向 HTTPS |

不要把 `10.0.2.2` 填到电脑浏览器；它只是在 Android Emulator 内映射到电脑 localhost。

### 7.2 构建和启动

```powershell
# 另一个终端先启动服务
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000

# 当前项目已配置的电脑模拟器链路
npm.cmd run android:debug
```

`android:debug` 会执行 Next build、Capacitor sync、Gradle debug 构建、复制 APK、启动 `GrowthLoopDesktop`、安装并拉起应用。需要更换 SDK 或 AVD 时设置：

```powershell
$env:GROWTH_LOOP_ANDROID_SDK = 'D:\Android\sdk'
$env:GROWTH_LOOP_ANDROID_AVD = 'D:\Android\avd'
```

### 7.3 AI/自动化调试顺序

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action doctor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action run -Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action smoke
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action logs
```

验收重点：

- `doctor`：APK 存在、后端 HTTP 200、ADB 设备为 `device`。
- `smoke`：`ok=true`、视口 412×867、body/document 宽度等于视口、`hasHomeV4=true`、`homeScrollFits=true`，四个 Tab、记录抽屉和成长页可见。
- `logs`：关注 `FATAL EXCEPTION`、`Uncaught`、`TypeError`、`ReferenceError`；WebView 的 variations seed、DNS、Fenced Frames 等系统 warning 不等同于应用崩溃。

清空本机原型数据并重启：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action run -ClearData
```

### 7.4 Android 发布边界

仓库里的 APK 是 debug 签名，并默认连接模拟器后端。正式发布前必须重新配置 HTTPS、release keystore、AAB、隐私声明、通知权限、断网恢复、真机尺寸和微信生产回调。

## 8. 变更、测试和提交

### 8.1 修改代码

先看当前台账和对应实现，再修改最小范围。UI 修改要检查窄屏首页是否仍然一屏；API 修改要补输入校验和回退行为；涉及密钥、微信或 LLM 配置时不能把值写入源码。

### 8.2 推荐验证矩阵

| 变更类型 | 必跑命令 |
|---|---|
| 普通 TypeScript/React | `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build` |
| Agent/LLM | 上述三项 + `/api/agent` 状态/正常/空输入/回退请求 |
| 测验 | `/api/quiz` generate + grade，确认 `gradedBy` 与反馈结构 |
| 微信 | `/api/wechat/status`、签名正反例、明文 XML 文本回调 |
| Android/UI | `npm.cmd run android:debug`、`doctor`、`smoke`、`logs`、截图视觉复核 |
| 发布 | `git diff --check`、敏感路径检查、GitHub 远程文件与 commit 核对 |

### 8.3 Git 发布

```powershell
git status -sb
git diff --stat
git diff --check
git add <明确的文件列表>
git commit -m 'Describe the change'
git push -u origin $(git branch --show-current)
```

如果需要更新 `main`，确认工作区没有无关改动，并在推送后核对：

```powershell
gh repo view redmaplewww/growth-loop-agent --json nameWithOwner,isPrivate,defaultBranchRef,url
git ls-remote --heads origin main
```

不要用 `git add -A` 掩盖未审查的文件；不要把 `.env.local`、SDK、AVD、build 和日志带入 public 仓库。

## 9. 故障排查

### 页面打不开

先执行：

```powershell
Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action doctor
```

电脑浏览器 200 但 APK 空白时，优先检查 APK 是否能访问 `10.0.2.2:3000`、Next 进程是否仍在、应用是否需要重新启动。这个 APK 是远程页面壳，重新构建 APK 不会自动替代正在运行的 Next 服务。

### LLM 不工作

检查 `/api/agent` 返回的 `mode`、`modelConfigured`、`endpointConfigured`。若是 `demo`，说明没有完整模型配置，这是预期回退；若是 `llm` 但模型失败，先看服务端网络、base URL 是否包含 `/v1`、模型名和部署平台 Secret，再用相同输入验证规则回退是否正常。

### GitHub 推送失败

```powershell
gh auth status
git remote -v
git branch -vv
git ls-remote --heads origin
```

先确认账号有仓库写权限、远程地址正确、分支没有被保护规则拒绝。不要为了绕过保护规则强推或覆盖他人的提交。

## 10. 已知限制与下一阶段

- 当前数据层是确定性 seed + 浏览器 localStorage，尚未接入真实数据库和多用户隔离。
- 21:30 晚报目前是客户端偏好和手动入口，尚未接入可靠的后台定时任务、通知授权和失败重试。
- 微信仅实现明文文本回调；生产需要安全模式、加密、幂等、限流和审计。
- 规则引擎和 LLM 评分已经有原型闭环，但还需要题库、评测集、低分复习策略和长期行为验证。
- Android 仍是 debug 壳；正式 release、AAB、签名、商店合规、真机适配和离线策略待后续。

这些限制不是隐藏错误。修改范围或发布状态时，要在 `.project-to-act/PROJECT_ACCEPTANCE.md` 中补充证据，而不是把原型状态写成生产完成。

## 11. 交接模板

接手新任务时，先记录：

```text
目标：
影响范围：Web / Agent / Quiz / 微信 / Android / 文档
当前分支：
相关证据：
计划修改文件：
验证命令：
已知边界：
```

完成后汇报：改了什么、为什么改、跑了哪些命令、结果是什么、哪些生产条件仍未满足，以及对应的 commit/远程分支。
