# QQ 机器人通道插件（@local/qq-bot）

把当前 DeepSeek Harness 变成一个 **QQ 机器人通道**：接收 QQ 消息（含图片），
通过一个 **OpenAI 兼容的视觉/对话接口** 生成回答，再把回答发回 QQ。

基于 **OneBot v11** 协议，可用 NapCatQQ、Lagrange.Core、LLOneBot、go-cqhttp 等接入。
插件完全自包含，只用 Node 内置模块，**不需要额外安装任何 npm 依赖**。

---

## 工作原理

```
QQ 客户端
  │  (发消息 / 图片)
  ▼
NapCat / Lagrange / ... (OneBot v11 实现)
  │  反向 WebSocket 客户端  →  ws://127.0.0.1:6700/onebot
  ▼
本插件 (在 Harness 内运行 HTTP + WebSocket 服务端)
  │  解析消息段 (CQ 码 / 数组)，提取图片 URL
  ▼
OpenAI 兼容 /chat/completions (默认 DashScope qwen-vl-max-latest)
  │  文字 + 图片(base64 data URI) → 回答
  ▼
回复通过同一 WebSocket（或 OneBot HTTP API）发回 QQ
```

---

## 1. 配置插件

打开插件目录下的 `cordis.patch.yml`，找到 `llm` 段，**至少填写 `apiKey`**：

```yaml
llm:
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  apiKey: 'sk-你的密钥'          # ★必填★
  model: 'qwen-vl-max-latest'
```

默认用阿里云百炼（DashScope）的 OpenAI 兼容模式 + 通义千问视觉模型。
换成任何 OpenAI 兼容端点都可以，例如：

- **OpenAI**：`baseUrl: 'https://api.openai.com/v1'`，`model: 'gpt-4o-mini'`
- **DeepSeek**：`baseUrl: 'https://api.deepseek.com'`，`model: 'deepseek-chat'`（纯文本，无视觉）
- **本地网关**（Ollama / vLLM / LM Studio）：`baseUrl: 'http://127.0.0.1:11434/v1'`，
  `model: 'llava'` 之类，`apiKey` 可留空（本地无需鉴权时不校验）

其它常用项：

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `host` / `port` | 监听地址 / 端口 | `0.0.0.0` / `6700` |
| `path` | WS 与 HTTP POST 路径 | `/onebot` |
| `accessToken` | 接入令牌（留空不校验） | 空 |
| `replyVia` | `ws`（默认，原连接回复）/ `http`（走 httpApiBase） | `ws` |
| `httpApiBase` | 备用 OneBot HTTP API，如 `http://127.0.0.1:3000` | 空 |
| `replyAtSender` | 群回复是否 @发送者 | `true` |
| `trigger.privateAlways` | 私聊是否全部响应 | `true` |
| `trigger.groupRequiresAt` | 群消息是否需 @机器人 | `true` |
| `trigger.prefix` | 群消息命令前缀，如 `/ai ` | 空 |
| `allow.groups/users` | 白名单（空=不限制） | 空 |
| `allow.denyUsers` | 黑名单 | 空 |
| `maxImageBytes` | 单图下载上限 | 8MB |
| `llm.allowPrivateImages` | 允许下载内网/本机地址的图片（默认拒绝，防 SSRF） | `false` |

改完配置或修改代码后，**必须重新加载插件** 才会生效（本地链接安装的插件不会自动热更新文件）：

- 方式 A：在插件管理里把 `@local/qq-bot` **禁用 → 再启用**（`plugin_manager` 的
  `set_plugin`，target 为 `include:qq-bot`，先 `enabled:false` 再 `enabled:true`）；
- 方式 B：**重启 Harness**。

每次禁用插件会关闭监听端口（`/health` 会连接拒绝），重新启用后会用新代码重新监听。

---

## 2. 扫码登录 + 一键接入（推荐，内置控制台）

插件自带一个控制台页面，**不用手改 NapCat 配置**：

1. 先安装并启动 NapCat（需要已安装 QQNT），记下它启动时在终端 / 日志里打印的
   **WebUI 登录 token**；
2. 在 `cordis.patch.yml` 里填写：

   ```yaml
   napcat:
     enabled: true
     baseUrl: 'http://127.0.0.1:6099'   # NapCat WebUI 地址
     webuiToken: '那串token'             # ★ NapCat 的 WebUI 令牌
   ```

3. 重新加载插件（禁用 → 启用），浏览器打开 **`http://127.0.0.1:6700/setup`**；
4. 点 **「获取二维码」** → 用手机 QQ 扫码登录；页面会每 3 秒轮询登录状态，
   二维码过期点「刷新二维码」；
5. 点 **「一键接入」** → 插件会把反向 WS 地址写进 NapCat 的
   `onebot11.json`（`network.websocketClients`），NapCat 随后自动连回来，
   页面上的「连接状态」变成「OneBot 已连接」。

控制台接口（同源，均为 JSON）：

| 接口 | 说明 |
| --- | --- |
| `GET /setup` | 控制台页面 |
| `GET /api/status` | 插件 + NapCat + 模型配置状态 |
| `POST /api/qr` | 取一个新登录二维码（返回 url 与有效期） |
| `GET /api/qr.svg` | 当前二维码的 SVG 图 |
| `POST /api/login-info` | 查询当前登录状态 / QQ 号 |
| `POST /api/link` | 一键写入 NapCat 反向 WS |

二维码由插件内置的 QR 编码器生成（`lib/qr.js`，纯 Node 实现，无第三方依赖），
不调用任何外部二维码服务。

若插件设置了 `accessToken`，控制台页面与 `/api/*` 需要带
`?token=...` 或 `Authorization: Bearer ...`；未设置时只允许本机访问。

> 「一键接入」只新增/更新指向本插件的那一条 WebSocket 客户端配置，不会改动
> 你已有的 HTTP / 正向 WS 等其他配置；同一地址重复点会更新而不是重复添加。

---

## 3. 手动配置 OneBot 实现端（以 NapCatQQ 为例）

在 NapCat 的「网络配置」里添加一个 **反向 WebSocket 客户端**：

- **URL**：`ws://127.0.0.1:6700/onebot`
  - 若插件设置了 `accessToken`，改为 `ws://127.0.0.1:6700/onebot?access_token=你的token`
- **消息上报格式**（`message_post_format`）：`string` 或 `array` 都支持（插件两种都解析）
- 启用并保存

Lagrange.Core / LLOneBot / go-cqhttp 同理，填反向 WS 地址即可（go-cqhttp 用
`ws-reverse` 配置段）。确保 OneBot 端与 Harness 在同一台机器，或把 `host` 改成
`0.0.0.0` 并开放防火墙端口后填实际 IP。

> HTTP POST 方式：插件也接受 OneBot 的 HTTP 上报（POST 到 `/onebot`），但回复这种
> 模式必须配置 `httpApiBase`（OneBot 的 HTTP API 地址），因为 POST 连接不能反向发消息。
> 推荐优先用反向 WebSocket。

---

## 4. 验证

插件启动后会在日志打印监听地址。可用浏览器或 curl 访问健康检查：

```
http://127.0.0.1:6700/health
```

返回示例：

```json
{
  "ok": true,
  "plugin": "@local/qq-bot",
  "started": true,
  "connections": 1,
  "selfIds": ["123456789"],
  "replyVia": "ws",
  "path": "/onebot"
}
```

`connections: 1` 且 `selfIds` 有值，说明 OneBot 端已连上。之后在 QQ 里：

- **私聊**机器人：直接发文字或图片，机器人会回复
- **群聊**：需要 `@机器人`（或命中 `trigger.prefix` 前缀）才会响应
- 发**图片**时，机器人会描述图片并针对内容作答

---

## 5. 触发逻辑小结

- 只处理 `post_type === 'message'` 且 `message_type` 为 `private`/`group` 的事件
- 按 `message_id` 去重，避免重复回复
- 群消息默认需 `@机器人` 或前缀；私聊默认全回
- 支持白名单 / 黑名单
- 图片从 `[CQ:image,url=...]` 或数组段的 `image` 中提取并下载（带大小限制）
- 视觉接口失败时，会把简短错误信息回复到聊天，不会让插件崩溃

---

## 安全提示

- 默认监听 `0.0.0.0`。若只在本地使用，建议把 `host` 改为 `127.0.0.1`，
  或设置 `accessToken` 防止他人接入。
- API Key 只写在本地插件配置里，不会外传。
- 图片下载有 8MB 上限与超时保护。
- **SSRF 防护**：图片地址来自聊天内容，插件默认只下载公网 `http(s)` 图片，
  会先解析域名并逐跳校验，拒绝 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、
  `169.254/16`（云元数据）、IPv6 本地地址与 IPv4-mapped 写法；跳转后的地址会
  重新校验，防止公网域名把请求引回内网。若你的图片确实来自局域网图床，
  把 `llm.allowPrivateImages` 设为 `true` 才会放行。
- `file://` 图片引用一律忽略（插件是服务端，不读取本机任意文件）。
- `/setup` 控制台在未设置 `accessToken` 时只允许本机访问。
