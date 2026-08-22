# 网页服务配置手册

这份手册给第一次拿到仓库的人使用。目标是：从一个干净 clone 开始，在本机或一台 Node.js 服务器上把网页和 API 一起跑起来。

先记住一件事：成长回路不是“下载后双击 HTML 就能运行”的静态网页。首页虽然会被 Next.js 预渲染，但按钮、记录、测验和 AI 对话都需要浏览器连接正在运行的 Next.js 服务。

## 1. 地址和运行方式

| 场景 | 正确入口 | 说明 |
|---|---|---|
| 电脑浏览器 | `http://127.0.0.1:3000/` | 本机 Next.js 服务 |
| Android Emulator | `http://10.0.2.2:3000/` | 只在模拟器 WebView 内使用 |
| 局域网设备 | `http://电脑局域网 IP:3000/` | 仅适合开发调试，需把服务绑定到 `0.0.0.0` |
| 生产环境 | `https://你的域名/` | 由 Node.js 服务提供，前面可接 HTTPS 反向代理 |

以下方式不受支持：

- 直接双击 `index.html` 或 `out/index.html`；
- 把仓库当成 GitHub Pages 这类纯静态站点部署；
- 只执行 `next build`，然后把某个目录当作静态网站上传。

当前 API 路由需要 Node.js 服务端：`/api/agent`、`/api/quiz`、`/api/demo`、`/api/wechat` 和 `/api/wechat/status`。

## 2. 环境要求

- Node.js 22 或更高版本；
- npm；
- Windows 推荐使用 PowerShell，macOS/Linux 使用终端；
- 如果要接收微信公众号回调，还需要公网 HTTPS 域名；
- 如果只看本地 demo，不需要 LLM API Key、微信账号或 Android SDK。

查看版本：

```powershell
node --version
npm --version
```

## 3. 从干净 clone 启动本地网页

### Windows PowerShell

```powershell
git clone https://github.com/redmaplewww/growth-loop-agent.git
Set-Location growth-loop-agent
npm.cmd ci
Copy-Item -LiteralPath .env.example -Destination .env.local
npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
```

### macOS/Linux

```bash
git clone https://github.com/redmaplewww/growth-loop-agent.git
cd growth-loop-agent
npm ci
cp .env.example .env.local
npm run dev -- --hostname 127.0.0.1 --port 3000
```

启动完成后，用电脑浏览器打开：

```text
http://127.0.0.1:3000/
```

不要关闭运行 `next dev` 的终端。关闭终端后，页面可能还能显示已经加载的 HTML，但新的 API 请求会失败。

## 4. 配置文件和 LLM

`.env.local` 只放在本机或部署平台 Secret 中，不能提交到 GitHub。

刚复制出来的 `.env.local` 使用 demo 模式：

```dotenv
LLM_PROVIDER=demo
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

这种配置已经可以使用首页、计划、记录、测验和规则回退，不依赖外部 LLM。需要真实模型时，再填写完整的 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`，或使用对应 provider 的变量，例如 `OPENAI_*`、`DEEPSEEK_*`、`GLM_*`。

检查当前服务状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/agent
```

返回 `mode=demo` 不代表网页坏了，只表示没有配置完整的模型连接；此时 Agent 会使用本地规则回复。

## 5. 启动后的最小验收

在另一个 PowerShell 窗口执行：

```powershell
$root = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/
$demo = Invoke-RestMethod http://127.0.0.1:3000/api/demo
$agent = Invoke-RestMethod http://127.0.0.1:3000/api/agent

"ROOT: $($root.StatusCode)"
"DEMO: $($demo.mode) / $($demo.seedVersion)"
"AGENT: $($agent.mode) / $($agent.provider)"
```

预期结果：

- `ROOT` 为 `200`；
- `DEMO` 为 `seeded-demo`，并带有 seed 版本；
- `AGENT` 在没有 LLM 配置时为 `demo / demo`。

再做一次不依赖 LLM 的对话请求：

```powershell
$body = @{
  message = '今天学习了 Agent 的工具调用'
  conversationId = 'setup-check'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/api/agent `
  -ContentType 'application/json' `
  -Body $body | ConvertTo-Json -Depth 8
```

只要返回 `reply`、`intent` 和 `mode`，网页服务就已经跑通；`replySource=rules` 是没有 LLM 时的正常结果。

## 6. 生产式本地运行

开发模式适合改代码，生产式本地运行用于确认构建产物和服务启动流程：

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000
```

在 Linux/macOS 上把 `npm.cmd` 换成 `npm`。

`npm run build` 生成的是 Next.js 的服务端构建结果，主要位于 `.next/`。它不会生成一个可直接双击的 `out/index.html`，也不能把 API 自动变成纯静态接口。不要用文件管理器打开构建目录来判断服务是否可用。

## 7. 让局域网或设备访问

开发调试时可以让 Next.js 监听所有网卡：

```powershell
npm.cmd run dev -- --hostname 0.0.0.0 --port 3000
```

然后让同一局域网的设备访问电脑 IP，例如：

```text
http://192.168.1.20:3000/
```

需要同时确认：

1. Windows 防火墙允许开发端口 3000；
2. 设备和电脑在同一个局域网；
3. 电脑浏览器先能访问 `127.0.0.1:3000`；
4. 不要把开发服务直接暴露到公网。

Android Emulator 不使用电脑的局域网 IP，默认使用 `10.0.2.2:3000`。Android 的完整构建和模拟器流程见 [Android 构建说明](ANDROID_BUILD.md)。

## 8. 部署到 Node.js 服务器

部署平台需要提供一个长期运行的 Node.js 服务，而不是只上传 HTML 文件。通用配置如下：

| 项目 | 配置 |
|---|---|
| 安装命令 | `npm ci` |
| 构建命令 | `npm run build` |
| 启动命令 | `npm run start -- --hostname 0.0.0.0 --port 3000` |
| 健康检查 | `GET /`、`GET /api/demo`、`GET /api/agent` |
| 必需 Secret | 无（demo 模式） |
| 可选 Secret | LLM 变量、微信变量 |

如果前面接 Nginx、Caddy 或云平台反向代理，必须把 `/` 和所有 `/api/*` 都转发到同一个 Next.js 进程。不要只缓存或托管首页 HTML。

生产部署至少要补齐：

- HTTPS 和域名；
- 进程自动重启、日志和健康检查；
- 数据库、多用户隔离和备份；
- LLM/微信 Secret 的平台托管；
- 微信回调的加密模式、重放保护、限流和审计；
- release Android 签名和真机回归。

当前仓库仍是原型，不能把本地 demo 数据当成生产数据层。

## 9. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面只有静态文字，点击没有反应 | 打开了 HTML 文件或静态托管页面 | 在项目根目录启动 `npm run dev`/ `npm run start`，再访问 `http://127.0.0.1:3000/` |
| 页面显示“正在连接成长回路…” | 打开了 Capacitor 的占位 `out/index.html` | 不要打开 `out`；先启动 Next.js 服务。Android 还要确认 `10.0.2.2:3000` 可达 |
| 首页 200，但记录/测验失败 | `/api/*` 没有被转发到 Next.js | 检查浏览器开发者工具和反向代理，确保所有 `/api/*` 与首页走同一服务 |
| `ECONNREFUSED 127.0.0.1:3000` | Next.js 服务没有运行或端口不同 | 重新执行启动命令，确认终端显示 `Ready` |
| `mode=demo` | 没有完整配置 LLM | 这是正常回退；网页和本地 Agent 仍可使用 |
| 电脑能开，APK 打不开 | APK 使用的是模拟器专用地址 | 电脑启动服务后，用 `http://10.0.2.2:3000/`；执行 `doctor` 检查 |
| `npx cap sync android` 找不到 `out` 或 assets | Android 构建依赖本机生成目录，不能只靠静态 clone | 先按 Android 手册准备工程和服务；不要把该错误当成 Web API 或 LLM 错误 |

## 10. 交接清单

把服务交给别人时，至少说明：

1. 仓库 commit 或分支；
2. Node.js 版本；
3. 实际访问地址和端口；
4. 使用 `dev` 还是 `start`；
5. 是否配置 LLM，是否预期 `mode=demo`；
6. `/api/demo` 和 `/api/agent` 的验收结果；
7. 如果是 Android，电脑服务地址、模拟器地址和 APK 版本；
8. 未完成的生产边界，不要把本地原型描述成已上线服务。

相关文档：[开发者与 AI 手册](DEVELOPER_HANDBOOK.md)、[微信公众号接入](WECHAT_INTEGRATION.md)、[Android 构建说明](ANDROID_BUILD.md)、[Android APK 调试](ANDROID_APK_DEBUG_AI.md)。
