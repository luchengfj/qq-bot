# QQ 机器人通道插件（@local/qq-bot）

把当前 DeepSeek Harness 变成一个 **QQ 机器人通道**：接收 QQ 消息（含图片），
通过一个 **OpenAI 兼容的视觉/对话接口** 生成回答，再把回答发回 QQ。

基于 **OneBot v11** 协议，可用 NapCatQQ、Lagrange.Core、LLOneBot、go-cqhttp 等接入。
插件完全自包含，只用 Node 内置模块，**不需要额外安装任何 npm 依赖**。

仓库：<https://github.com/luchengfj/qq-bot>

安装：把本目录挂到 Harness 的插件目录，或在 `cordis.patch.yml` 里
`insert` 一行 `{id: qq-bot, name: '@local/qq-bot'}` 指向本目录。

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

## 2. DSH 内置面板（推荐）

安装启用插件后，面板直接长在 DSH 里，不用记端口：

- **插件页**：打开「插件」→ 找到 `@local/qq-bot` → 配置页（列表行也会显示一行
  「QQ 机器人 · 已连接/未连接 · 已登录/未登录」摘要）；
- **侧边栏**：全局面板区会出现「QQ 机器人」图标，点开即完整面板。

面板每 4 秒自动刷新，包含 6 块：

| 区块 | 内容 |
| --- | --- |
| 状态 | 连接数、登录 QQ、模型密钥、本插件端点、反向 WS 地址、NapCat 地址、消息统计（收到/已回复/失败）|
| 扫码登录 + 一键接入 | 获取/刷新二维码、一键接入，二维码直接在面板里渲染 |
| 发送测试消息 | 选群聊/私聊 + 填号 + 内容，立刻调用 `send_msg` |
| 长期记忆 | 查看每个会话记住了什么、删除单条/整个会话/全部记忆、给某个会话「换个话题」清上下文、立即写盘 |
| 诊断 | 测试模型接口连通性、清空统计、实时日志（最近 30 条）|
| 当前配置（只读） | 私聊/群触发规则、白名单与黑名单 |

数据来自 Host 侧注册的 `/api/qq-bot/*` 路由（`lib/bridge.js`），只允许
**本机同源**访问：`sec-fetch-site: cross-site`、Origin 与 Host 不一致、
非 loopback 的 Host 或远端地址都会被拒绝（403）。

> 面板内的配置是**只读**的：改配置请编辑 `cordis.patch.yml`，然后
> 禁用 → 启用插件。

---

## 3. 扫码登录 + 一键接入（独立控制台 /setup）

除了上面的 DSH 面板，插件还自带一个独立的控制台页面，**不用手改 NapCat 配置**：

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

## 4. 手动配置 OneBot 实现端（以 NapCatQQ 为例）

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

## 5. 验证

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

面板接口（DSH 面板用，同源 + 仅本机）：

```bash
curl http://127.0.0.1:57126/api/qq-bot/status    # 需带浏览器同源头，见「安全提示」
```

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/qq-bot/status` | GET | 插件状态、NapCat/模型配置、统计、最近日志 |
| `/api/qq-bot/log` | GET | 完整日志环（默认 200 条）|
| `/api/qq-bot/qr` | POST | 生成登录二维码 |
| `/api/qq-bot/qr.svg` | GET | 当前二维码 SVG |
| `/api/qq-bot/login-info` | POST | 登录状态 / QQ 号 |
| `/api/qq-bot/link` | POST | 一键写入 NapCat 反向 WS |
| `/api/qq-bot/llm-test` | POST | 测试模型接口连通性 |
| `/api/qq-bot/send` | POST | 发送测试消息（`{messageType,userId|groupId,text}`）|
| `/api/qq-bot/stats-reset` | POST | 清空统计 |
| `/api/qq-bot/log-clear` | POST | 清空日志 |
| `/api/qq-bot/memory` | GET | 记忆概况 + 最近会话列表 |
| `/api/qq-bot/memory-facts` | GET | 某个会话记住的条目（`?key=private:12345`）|
| `/api/qq-bot/memory-forget` | POST | 删除记忆（`{key,fact}` / `{key}` / `{scope:'all'}`）|
| `/api/qq-bot/memory-save` | POST | 立即把记忆写入磁盘 |
| `/api/qq-bot/memory-history` | GET | 某个会话的最近对话上下文（`?key=private:12345`）|
| `/api/qq-bot/memory-newtopic` | POST | 清空某个会话的对话上下文（`{key}`，长期记忆保留）|

---

## 6. 上下文记忆与回复质量

### 6.1 长期记忆（记住"你是谁"）

机器人会**自动记住**用户说过的关键信息，之后的对话自然带上这些背景，
不用每次重新介绍自己：

| 用户说 | 机器人记住 |
| --- | --- |
| 我叫小明 | 我叫小明 |
| 我住在杭州，我喜欢喝咖啡 | 我住在杭州 / 我喜欢喝咖啡 |
| 以后叫我老王 | 以后叫我老王 |

在 QQ 里直接发：

- **「我的记忆」** → 机器人列出它记住的关于你的信息
- **「忘记我」** → 清除关于你的全部记忆

规则：

- **私聊与群聊完全隔离**：私聊里说的话不会出现在群里，反之亦然；
- **同主题覆盖**：再说一次「我叫…」会替换旧的名字，不会堆积；
- 只记**陈述句**，疑问句（「我叫什么？」）不记；
- 每条最长 `memory.maxFactChars`（默认 120 字），每人最多 `memory.maxFacts` 条（默认 60）；
- 超过 `memory.ttlDays`（默认 30 天）没说话会自动遗忘。

**持久化**：默认只在内存里，插件重载就没了。把 `cordis.patch.yml` 的
`memory.file` 设成一个路径即可写入磁盘：

```yaml
memory:
  enabled: true
  file: 'C:/Users/你的用户名/.dsh/qq-bot-memory.json'
```

写盘是**合并延迟写**（默认 15 秒），插件卸载时会强制同步一次。

### 6.2 对话上下文（记住"刚才聊了什么"）

长期记忆记的是「你是谁」，对话上下文记的是「刚才说了什么」——两者分开。
有了它，机器人才能接住指代和追问：

```
用户：Python 里怎么读文件？
机器人：用 open()…
用户：那写呢？            ← 没有上下文就答非所问
```

规则：

- 每个会话保留最近 `memory.maxHistory` 轮（默认 12），并注入模型；
- 静默超过 `memory.historyTtlMinutes`（默认 30 分钟）自动清空，当作新话题；
- 发 **`/new`**（或「换话题」）可立即清空，长期记忆不受影响；
- 上下文**不会**被当成长期知识，也不写进"我的记忆"。

### 6.3 回复质量

每次模型返回后都会做一遍清洗（`lib/reply.js`，纯本地、不额外调用模型）：

- 去掉「作为一个人工智能助手，」这类开场白；
- 折叠连续空行；
- 超过 `llm.maxReplyChars`（默认 600 字）时**自动拆成多条发送**（默认最多
  `llm.maxReplyParts`=4 条），按段落 → 句子 → 空格的优先级切分并标上
  `(1/4)`，不再直接截断丢内容；确实放不下的部分会以「…（略）」标注；
- 记住自己最近说过的话，如果判断在重复，会要求模型换角度重新回答；
- 模型回复为空时给一个兜底答复，不会静默不回。

### 6.4 内置指令

在 QQ 里直接发（也支持中文别名）：

| 指令 | 作用 |
| --- | --- |
| `/help`、`/帮助` | 显示这条帮助 |
| `/status`、`/状态` | 查看模型、记忆与上下文的运行状态 |
| `/new`、`/换话题` | 换个话题，清空对话上下文（长期记忆保留） |
| `/memory`、`/我的记忆` | 查看机器人记住了什么 |
| `/forget`、`/忘记我` | 清空关于你的长期记忆 |

指令只在消息**开头**才生效，句子中间提到 `/help` 不会被当成指令。

---

## 7. 触发逻辑小结

- 只处理 `post_type === 'message'` 且 `message_type` 为 `private`/`group` 的事件
- 按 `message_id` 去重，避免重复回复
- 群消息默认需 `@机器人` 或前缀；私聊默认全回
- 以 `/` 开头的消息先走内置指令（`/help`、`/status`、`/new`、`/memory`、`/forget`）
- 支持白名单 / 黑名单（缺少 `user_id`/`group_id` 的事件在启用白名单时会被拒绝）
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
- **面板接口** `/api/qq-bot/*` 同样只接受本机同源请求：拒绝
  `sec-fetch-site: cross-site`、Origin 与 Host 不一致的跨站调用，
  非 loopback 的 Host 头，以及非 loopback 的 TCP 对端地址。
