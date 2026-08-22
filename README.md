# 成长回路（Growth Loop）

一个把“今天做了什么”变成下一步行动的自我提升 Agent。用户可以直接和 AI 对话，记录学习、运动、生活和休息；Agent 负责整理、安排、复盘，并把可验证的行动记入成长轨迹。

> 当前版本是可运行的本地原型，不是生产 SaaS。项目已经包含 Next.js Web、Capacitor Android 工程、确定性 demo 数据、OpenAI-compatible LLM 接口、微信公众号明文回调、理解测验和电脑 Android Emulator 调试链路。

## 现在能做什么

| 能力 | 当前实现 | 入口 |
|---|---|---|
| AI 今日对话 | 记录事实、识别意图、给出下一步；无模型配置时使用规则回退 | `/api/agent`、首页 |
| 学习闭环 | 学习记录 → 生成 2–3 道理解题 → LLM 或规则评分 → XP 回写 | `/api/quiz`、记录页 |
| 今日行动 | 计划、待办、学习/运动/生活/休息分类、XP 与积分 demo | `/api/demo`、首页/计划 |
| 晚间回顾 | 统一总结当天记录，并依次追问最重要行动、真正理解和明日一步 | 首页晚报入口、Agent `review` 意图 |
| 微信入口 | 微信公众号首次验证、明文 XML 文本回调、签名校验、LLM 超时回退 | `/api/wechat` |
| Android App | 独立移动壳 v4；首页一屏 AI 会面，不堆功能、不产生首页纵向滚动 | `android/`、APK |
| 可复现调试 | doctor、build、install、run、smoke、logs；面向人和 AI | `scripts/debug-apk.ps1` |

## 产品形态

首页只做一件事：让用户马上告诉 AI 今天发生了什么。首页默认只显示 AI 状态、一个下一步行动、一个记录框和晚报状态；路线、记录、成长和完整测验放在二级入口，由 AI 在需要时引导用户进入。

```mermaid
flowchart LR
  User[用户] --> Home[今日首页 / 微信对话]
  Home --> Agent[/api/agent]
  Agent --> Parse[规则解析与会话状态]
  Agent --> Model[可选 OpenAI-compatible LLM]
  Home --> Quiz[/api/quiz]
  Quiz --> Model
  WeChat[微信公众号] --> WechatAPI[/api/wechat]
  WechatAPI --> Agent
  Home --> Demo[/api/demo]
  Demo --> Seed[确定性 demo 数据]
```

## 快速开始

### 环境要求

- Node.js 22 或更高版本（Android WebView CDP smoke 需要 Node 22 的 `WebSocket` 全局对象）
- npm
- Windows PowerShell（Android 电脑模拟器脚本按 Windows 环境编写）
- Android 调试需要本机 Android SDK、AVD 和 Java 21；详见 [Android 构建说明](docs/ANDROID_BUILD.md)

### 本地 Web

```powershell
git clone https://github.com/redmaplewww/growth-loop-agent.git
Set-Location growth-loop-agent
npm.cmd install
Copy-Item -LiteralPath .env.example -Destination .env.local
npm.cmd run dev
```

打开 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)。默认 `LLM_PROVIDER=demo`，不需要 API Key；页面会加载内置确定性测试数据。生产式本地回归可以使用：

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000
```

网页必须通过 Next.js 服务访问，不能直接双击 HTML 或部署到纯静态托管。第一次在另一台电脑配置服务，请先看 [网页服务配置手册](docs/WEB_SERVICE_SETUP.md)。

### 检查项目

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

## 配置 LLM

服务端通过 OpenAI-compatible `/chat/completions` 调用模型。没有完整配置时，Agent 和测验会自动回退到本地规则，不会因为模型不可用阻塞页面或微信文本回复。

复制 `.env.example` 为 `.env.local` 后，按实际供应商填写以下变量：

```dotenv
LLM_PROVIDER=demo
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

也支持按 provider 读取对应变量，例如 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，以及 `OPENAI_*`、`GLM_*`。密钥只放在本机环境变量、部署平台 Secret 或受管配置工具中，不能提交到 GitHub。

服务状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/agent
```

返回值只包含模式、供应商和是否配置 endpoint/model 等非敏感状态，不返回 API Key。

## API 速查

### Agent 对话

```powershell
$body = @{
  message = '今天学习了 Agent 的工具调用，终于理解它和普通聊天的区别'
  conversationId = 'demo-user'
  context = '当前路线：学习 Agent 并开发自己的 Agent'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/api/agent `
  -ContentType 'application/json' `
  -Body $body
```

`POST /api/agent` 接收 `message`（必填）、`conversationId`、`output`、`context`。返回 `reply`、`intent`、`extracted`、`mode`、`provider` 和 `replySource`。`GET /api/agent` 返回当前非敏感配置状态。

### 理解测验

生成题目：

```powershell
$body = @{
  action = 'generate'
  topic = 'Agent 工具调用'
  content = 'Agent 会先理解目标，再选择工具并根据结果继续行动。'
  output = '我理解了工具调用是让模型连接外部能力的桥梁。'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/quiz -ContentType 'application/json' -Body $body
```

评分时提交 `action=grade`、原题目、学习底稿和 `answers`。如果模型已配置，返回 `gradedBy=llm`；否则返回 `gradedBy=rules`，并明确给出回看建议。

### Demo 数据

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/demo
```

该接口提供目标、任务、记录和账本的确定性 seed，只用于原型验收，不代表真实用户数据层。

## 微信公众号接入

当前实现的是“服务端回调 + 明文文本模式”，不是小程序登录或微信支付。配置步骤：

1. 准备公网 HTTPS 域名和可访问的 Next.js 部署。
2. 在部署 Secret 中配置 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_TOKEN`。
3. 微信公众平台服务器地址填写 `https://你的域名/api/wechat`。
4. 选择明文模式，完成首次 GET 签名验证。
5. 用文本消息 POST 回归；模型超时会自动使用本地回退话术。

详细签名规则、XML 字段、状态接口和当前边界见 [微信公众号接入说明](docs/WECHAT_INTEGRATION.md)。当前 MVP 未启用安全模式/兼容模式的密文解密，正式上线前必须补齐加密回调、重放保护、限流和生产监控。

## Android APK

当前仓库已包含 Android 工程和 debug APK：

- 工程：[android/](android/)
- APK：[artifacts/android/growth-loop-debug.apk](artifacts/android/growth-loop-debug.apk)
- 电脑浏览器：`http://127.0.0.1:3000/`
- Android Emulator：`http://10.0.2.2:3000/`

启动本地服务后，在项目根目录执行：

```powershell
npm.cmd run android:debug   # build + sync + Gradle + install + launch
npm.cmd run android:run     # 使用现有 APK 安装并启动
npm.cmd run android:status
npm.cmd run android:stop
```

面向 AI 的完整调试顺序：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action doctor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action run -Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action smoke
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action logs
```

详见 [Android APK 调试手册](docs/ANDROID_APK_DEBUG_AI.md) 和 [Android 移动端产品设计](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md)。APK 是 debug 签名，并默认从电脑模拟器读取远程 Next.js 服务；正式发布还需要 HTTPS、release keystore、AAB、真机回归和隐私合规。

## 文档地图

| 文档 | 内容 |
|---|---|
| [开发者与 AI 手册](docs/DEVELOPER_HANDBOOK.md) | 从 clone、配置、开发、测试到发布的完整交接手册 |
| [网页服务配置](docs/WEB_SERVICE_SETUP.md) | 从干净 clone、环境变量到 Web/Node 服务验收；解释静态托管、API 和 Android 地址边界 |
| [产品设计方案](docs/PRODUCT_DESIGN_V1.md) | 产品目标、用户闭环、Agent、游戏化和微信路线 |
| [微信公众号接入](docs/WECHAT_INTEGRATION.md) | 微信服务器配置、签名校验和文本回调 |
| [Android 构建](docs/ANDROID_BUILD.md) | SDK、AVD、Capacitor 和 Android Studio |
| [Android APK 调试](docs/ANDROID_APK_DEBUG_AI.md) | doctor/build/install/run/smoke/logs 调试链路 |
| [移动端产品设计](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md) | 一屏 AI 首页、底部导航和移动交互约束 |
| [.project-to-act](.project-to-act/PROJECT_OVERVIEW.md) | 项目目标、范围、进度、版本和验收证据 |

## 数据、安全与发布边界

- demo 数据来自 `lib/demo-data.ts`，浏览器记录原型使用 localStorage；当前没有真实数据库、多用户隔离、后台定时任务或数据导出链路。
- LLM 只负责理解、建议、出题和评分；任务、XP、积分等写操作应继续由规则和受控服务端处理。
- 不要提交 `.env.local`、API Key、微信 Token、`android/local.properties`、Android build 目录、模拟器镜像或本机 SDK 路径。
- 微信回调当前只支持明文文本；不要在未补齐加密、重放保护、限流和审计前接收生产敏感消息。
- 仓库目前没有单独的开源许可证文件；如需对外允许复用，请先补充许可证和第三方依赖声明。

## 常见问题

| 现象 | 处理 |
|---|---|
| 电脑能打开，APK 打不开 | 确认 Next 服务监听 `127.0.0.1:3000`，APK 使用的是 `10.0.2.2:3000`；先跑 `doctor` |
| 页面显示旧版本 | 重启 `next start` 或重新执行 `npm.cmd run dev`，再重新打开 APK；当前 APK 默认加载远程页面 |
| `smoke` 找不到页面 | 确认应用已启动、ADB 设备为 `device`，然后重新执行 `run` 再 `smoke` |
| LLM 没有返回 | 查看 `/api/agent` 状态和环境变量；没有完整配置时预期会走 demo/rules 回退 |
| 微信首次验证失败 | 检查公网 HTTPS、`WECHAT_TOKEN`、服务器 URL 和服务器时间；不要把 token 写进源码 |
| Android ADB `offline` | `npm.cmd run android:stop` 后重新 `npm.cmd run android:debug`，必要时重启 adb server |

## 贡献与提交

1. 从 `main` 创建短分支，修改前先阅读 `AGENTS.md` 和相关 `.project-to-act` 文档。
2. 只提交本次任务范围内的文件，避免把密钥、构建产物和模拟器缓存带入提交。
3. 至少运行 `typecheck`、`lint`、`build`；涉及 Android 时再运行 `android:debug`、`doctor`、`smoke`、`logs`。
4. 提交信息说明意图，PR 描述列出变更、验证命令和已知边界。

## 当前版本

`0.2.0-prototype` · Android 移动壳 v4 · public GitHub 源码与 debug APK 已交付。生产数据库、后台调度、微信加密模式、release 签名和真实用户验收属于后续版本范围。
