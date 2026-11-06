# QQ 机器人通道插件（@local/qq-bot）

把 DeepSeek Harness 变成一个 **QQ 机器人通道**：接收文字 / 图片消息，调用模型生成回答，再把回答发回去。

**「零下载」重构后的定位**：

- 这是一个 **DSH 面板插件**，纯 Node 实现，**零 npm 依赖**、**零下载 / 零安装**——插件不会替你下载、安装或启动任何 QQ 客户端，也**不再自动下载 NapCat**。
- 启用即用的 **面板「① 直聊测试」**：不装任何东西，直接在面板里发消息，走完整的 BotLogic 收图 → 模型作答 → 记忆 → 分段回复流程。
- 默认 **`llm.mode='harness'`**：跟随 Harness 里当前选中的模型，**无需任何 API 密钥**；也可切到 `external` 走 OpenAI 兼容端点（此时才需要 key）。
- 可选的 **连接真实 QQ**：插件可以主动连出到一个「已经装好并正在运行」的 OneBot v11 正向 WebSocket，或接受任意已有 OneBot 实现的反向 WS / HTTP POST 接入。
- 新增 **本机 OneBot 端口自动探测 + 自动连接**：不用填任何地址，插件启动时自动扫描本机常见端口，发现正在运行的 OneBot 服务就自动连上，**手工配置的地址永远不会被覆盖**；面板可「立即扫描」或「开启 / 关闭」自动探测。
- 基于 **OneBot v11** 协议，适配 NapCatQQ、Lagrange.Core、LLOneBot、go-cqhttp 等**已装好**的实现端。

仓库：<https://github.com/luchengfj/qq-bot>

安装：把本目录挂到 Harness 的插件目录，或用 `cordis.patch.yml` 的 `insert` 行 `{ id: qq-bot, name: '@local/qq-bot' }` 指向本目录。

---

## 工作原理

```
① 面板「直聊测试」（零下载，默认路径）
   DSH 面板 ──输入文字/图片──▶ 直聊模拟器 ──▶ BotLogic 管线
        （收图 → 记忆/上下文 → 模型作答 → 分段回复） ──▶ 回到面板展示

② 可选：连接真实 QQ（插件不下载任何东西）
   ★ 自动探测本机常见 OneBot 端口 ──命中──▶ 自动连出（无需填地址，不覆盖手工配置）
   已有 OneBot v11 正向 WS 服务  ◀──插件主动连出（forward:）
   已有 OneBot 实现 ──反向 WS / HTTP POST──▶ ws://127.0.0.1:6700/onebot
        │
        ▼
   BotLogic 管线 ──▶ 通过同一连接（或 OneBot HTTP API）发回 QQ
```

模型后端二选一：`mode: harness` → Harness 当前选中模型（免密钥，图片经附件服务）；`mode: external` → OpenAI 兼容 `/chat/completions`（需 apiKey）。

---

## 1. 快速开始（零下载）

1. 在 DSH「插件」里**启用** `@local/qq-bot`。改过配置或代码后要**禁用 → 再启用**才会重新加载（本地链接安装的插件不会自动热更新文件）。
2. 打开侧边栏的「QQ 机器人」面板。
3. 在「**① 直聊测试**」输入框里直接打一句话（或贴一张图）发送。

**立即可用**：不需要 QQ 客户端、不需要 token、不需要 API key —— 默认走 Harness 原生模型。聊天里同样能用 `/help`、`/status`、`/new`、`/memory`、`/forget`，机器人记住的事实会出现在「④ 记忆与上下文」。

> 想连真实 QQ 的话看 §3；那是**完全可选**的。最省事的是插件会**自动探测本机常见的 OneBot 端口**（默认每 20 秒重扫一次），发现正在运行的实现端就自动连上、无需填地址；也可手工填正向 / 反向 WS 地址。插件依旧不会下载任何东西。

---

## 2. 面板的 5 个区块

面板每几秒自动刷新，按 5 个分组区块组织（响应式两栏、窄屏自动单栏）：

| 区块 | 内容 |
| --- | --- |
| **① 直聊测试** | 不装任何东西，立即验证收图、答题、记忆与分段回复；清空当前会话（`chat-clear`）。走的是真实 BotLogic 管线。 |
| **② 连接真实 QQ（可选）** | 新增「自动探测本机 OneBot 端口」卡片：点「立即扫描」强制扫描、用「开启 / 关闭」开关切换自动探测并查看候选结果列表；也可填一个已有 OneBot v11 正向 WS 地址（`forward-config`）/ 断开（`forward-disconnect`），或查看反向 WS 接入地址；连上后可发测试消息（`send`）。 |
| **③ 运行自检** | 「运行自检」逐项检查 6 项：OneBot 监听、模型后端、反向 WS 连接、正向 WS 连接、面板直聊可用、记忆功能；附模型连通性测试、统计清零、实时日志。 |
| **④ 记忆与上下文** | 查看每个会话记住了什么、删除单条 / 整个会话 / 全部记忆、给某个会话「换个话题」清上下文、立即写盘、查看最近对话上下文。 |
| **⑤ 配置与日志** | 当前配置（只读）、完整日志环、日志清空。改配置请编辑 `cordis.patch.yml` 后禁用 → 启用插件。 |

数据来自 Host 侧注册的 `/api/qq-bot/*` 路由（`lib/bridge.js`），只允许**本机同源**访问：`sec-fetch-site: cross-site`、Origin 与 Host 不一致、非 loopback 的 Host 或远端地址都会被拒绝（403）。

---

## 3. 连接真实 QQ 完全可选，且不下载任何东西

> **重要前提**：QQ 官方**没有**「免客户端」的 HTTP 机器人 API。所以「完全不装任何 QQ 端」只能做 **面板直聊测试**；要真实收发 QQ 消息，仍然需要一个**已经装好并正在运行**的 OneBot v11 实现端。区别在于：**插件本身不再自动下载 / 安装 / 启动它**，你用自己已有的即可。

插件提供与已有 OneBot 实现对接的**四种方式**：最省事的是自动探测（默认开启，且不会覆盖手工配置），其余三种手工方式任选其一：

- **自动探测（最省事）**：不用填任何地址。插件启动时自动扫描本机常见 OneBot 正向 WebSocket 端口（默认 `3001, 3000, 5700, 8080, 6099, 3333`）的 `/` 与 `/onebot` 路径，发送 OneBot `get_version` 探测（收到 `meta_event` / `lifecycle` 推送也算命中）；一旦发现可用服务就**自动连接**。**只有在尚未配置 / 连接正向 WS 地址时才启用**，手工填的地址永远不会被覆盖。插件自身的反向 WS 端口 `6700` **始终被排除**在探测之外。默认每 **20 秒**重新扫描一次。可在面板「② 连接真实 QQ（可选）」新增的「自动探测本机 OneBot 端口」卡片里点「**立即扫描**」强制扫描、用「**开启 / 关闭**」开关切换自动探测，并查看候选结果列表；对应接口 `POST /detect-scan` 与 `POST /detect-config`。
- **(A) 正向 WebSocket（插件主动连出）**：在面板「② 连接真实 QQ」里填一个**已经装好并正在运行**的 OneBot v11 正向 WS 地址（`ws://…`，可选 `accessToken`），或写进 `cordis.patch.yml` 的 `forward:` 块。面板填的配置会持久化到 `~/.dsh/qq-bot-forward.json`；`forward:` 块只是首次默认值。填好后用 `forward-config` 立即生效、`forward-disconnect` 断开。
- **(B) 反向 WebSocket（实现端连回插件）**：把任意已装好的 OneBot 实现的「反向 WebSocket 客户端」地址指向 `ws://127.0.0.1:6700/onebot`（设置了 `accessToken` 时加 `?access_token=你的token` 或 `Authorization: Bearer`）。NapCatQQ / Lagrange.Core / LLOneBot / go-cqhttp 等同理。
- **(C) HTTP POST 上报**：同一路径 `/onebot` 也接受 OneBot 的 HTTP POST 上报（可用 `secret` 做 HMAC-SHA1 签名）。这种单向连接发回复需要配合 `httpApiBase` 指向 OneBot 的 HTTP API；优先推荐 (A) / (B)。

连接参数（`host` / `port` / `path` / `accessToken` / `replyVia` / `httpApiBase` 等）见 §4。插件默认监听 `0.0.0.0:6700`，路径 `/onebot`；只在本机用可把 `host` 改成 `127.0.0.1`。

---

## 4. 配置表

改配置请编辑 `cordis.patch.yml`，然后**禁用 → 启用**插件。面板里的配置是只读的（正向 WS 例外，可在面板改并写盘）。

### 4.1 `forward:`（可选，连接已有正向 WS）

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `forward.enabled` | 是否主动连出到正向 WS | `false` |
| `forward.url` | 已运行的 OneBot v11 正向 WS 地址，如 `ws://127.0.0.1:3001` | 空 |
| `forward.accessToken` | 正向 WS 鉴权 token（可选） | 空 |
| `forward.reconnectMs` | 断线重连间隔（毫秒） | `5000` |

### 4.2 `detect:`（本机 OneBot 端口自动探测 + 自动连接）

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `detect.enabled` | 是否启用本机 OneBot 端口自动探测（也可在面板用「开启 / 关闭」切换） | `true` |
| `detect.host` | 探测目标主机 | `127.0.0.1` |
| `detect.ports` | 待扫描的常见正向 WS 端口列表 | `[3001,3000,5700,8080,6099,3333]` |
| `detect.paths` | 每个端口尝试的 WS 路径 | `[/,/onebot]` |
| `detect.intervalMs` | 自动重新扫描间隔（毫秒） | `20000` |
| `detect.timeoutMs` | 单次探测超时（毫秒） | `1500` |
| `detect.accessToken` | 探测 / 连接用的 OneBot 鉴权 token（可选） | 空 |
| `detect.excludePorts` | 额外排除的端口；插件自身端口 `6700` 始终自动排除，无需填写 | `[]` |

> 自动探测只会在**没有配置 / 连接正向 WS 地址**时启用；一旦手工填了地址，探测结果永不覆盖它。插件自身监听的 `6700` 端口始终排除在扫描之外。

### 4.3 `llm:`（模型）

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `llm.mode` | `harness`（**默认**：跟随 Harness 当前选中模型，免密钥）/ `external`（OpenAI 兼容端点，需 key） | `harness` |
| `llm.provider` / `llm.model` / `llm.reasoningEffort` | harness 模式下**留空**即跟随 Harness；填了则强制指定 | 空 |
| `llm.temperature` | 采样温度（harness 模式生效） | `0.4` |
| `llm.baseUrl` / `llm.apiKey` / `llm.model` | external 模式才用；默认 DashScope 兼容端点 | 见文件 |
| `llm.systemPrompt` / `llm.maxTokens` / `llm.timeoutMs` | 提示词 / 单次上限 / 超时 | 见文件 |
| `llm.maxReplyChars` / `llm.maxReplyParts` | 单条回复最大字数、最多拆几条（0 / 1 = 不拆） | `600` / `4` |
| `llm.allowPrivateImages` | 允许下载内网 / 本机地址的图片（默认拒绝，防 SSRF） | `false` |

external 端点可换成任何 OpenAI 兼容服务（OpenAI、DeepSeek、本地 Ollama / vLLM 等）。

### 4.4 `memory:`（长期记忆 + 对话上下文）

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `memory.enabled` | 是否启用记忆 | `true` |
| `memory.maxFacts` / `maxFactChars` / `maxReplies` | 每会话最多记多少条 / 单条长度 / 去重回复条数 | `60` / `120` / `30` |
| `memory.maxHistory` / `maxHistoryChars` / `historyTtlMinutes` | 最近多少轮上下文 / 单轮长度 / 静默多久当新话题 | `12` / `300` / `30` |
| `memory.ttlDays` | 多久没说话就遗忘长期记忆（天） | `30` |
| `memory.file` | 持久化文件路径；留空 = 仅内存（重启即失效） | 空 |
| `memory.autoSaveMs` | 有新记忆后延迟写盘（毫秒） | `15000` |

### 4.5 `trigger:` 与 `allow:`

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `trigger.privateAlways` | 私聊是否全部响应 | `true` |
| `trigger.groupRequiresAt` | 群消息是否需 @机器人 或前缀 | `true` |
| `trigger.prefix` | 群消息命令前缀，如 `/ai ` | 空 |
| `allow.groups` / `allow.users` | 白名单（空 = 不限制） | 空 |
| `allow.denyUsers` | 黑名单 | 空 |

### 4.6 连接 / 其它

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `host` / `port` / `path` | 监听地址 / 端口 / WS 与 HTTP POST 路径 | `0.0.0.0` / `6700` / `/onebot` |
| `accessToken` | 接入令牌（留空不校验） | 空 |
| `secret` | HTTP POST 上报签名密钥（HMAC-SHA1） | 空 |
| `replyVia` | `ws`（同连接回复）/ `http`（走 `httpApiBase`） | `ws` |
| `httpApiBase` / `httpApiToken` | 备用 OneBot HTTP API 地址 / Bearer token | 空 |
| `replyAtSender` | 群回复是否 @发送者 | `true` |
| `maxImageBytes` | 单图下载上限 | `8388608`（8MB） |

---

## 5. 内置指令与长期记忆

在 QQ 里（或面板直聊里）直接发，也支持中文别名；指令只在消息**开头**才生效：

| 指令 | 作用 |
| --- | --- |
| `/help`、`/帮助` | 显示帮助 |
| `/status`、`/状态` | 查看模型、记忆与上下文的运行状态 |
| `/new`、`/换话题` | 换个话题，清空对话上下文（长期记忆保留） |
| `/memory`、`/我的记忆` | 查看机器人记住了什么 |
| `/forget`、`/忘记我` | 清空关于你的长期记忆 |

### 长期记忆（记住「你是谁」）

机器人会**自动记住**用户说过的关键信息（「我叫小明」「我住在杭州，我喜欢喝咖啡」「以后叫我老王」），之后的对话自然带上这些背景。规则：

- **私聊与群聊完全隔离**；同主题覆盖（再说「我叫…」会替换旧名字，不堆积）；
- 只记**陈述句**，疑问句不记；每会话最多 `memory.maxFacts` 条、单条最长 `maxFactChars` 字；
- 超过 `memory.ttlDays`（默认 30 天）没说话自动遗忘；
- 默认只在内存里，设 `memory.file` 后写盘（合并延迟写，插件卸载时强制同步一次）。

### 对话上下文（记住「刚才聊了什么」）

与长期记忆分开：保留最近 `memory.maxHistory` 轮真实问答并注入模型，让机器人接住「那它呢？」这类指代；静默超过 `historyTtlMinutes` 自动清空，发 `/new` 可立即清空，长期记忆不受影响。上下文**不会**被当成长期知识。

### 回复质量

每次模型返回后做本地清洗（`lib/reply.js`，不额外调用模型）：去开场白、折叠空行；超过 `maxReplyChars` 时按段落 → 句子 → 空格拆成多条并标 `(1/4)`，不再直接截断；记住自己最近说过的话，重复时要求换角度；模型回复为空时给兜底答复。

---

## 6. 面板接口（/api/qq-bot/*）

全部经 `ctx.webServer` 注册、仅本机同源可访问。面板共 **19 个 `/api/qq-bot/*` 路由**；加上插件自身 HTTP 服务上的 `/health` 健康检查，后端合计 **20 个接口**。**读接口用 GET，写接口用 POST**，别用错方法导致 405。

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/qq-bot/status` | GET | 插件状态、监听端点、连接模式、正向 WS 信息、模型来源、统计、最近日志、直聊历史、记忆概况，以及自动探测状态 `detect`（`enabled/running/scanning/status/lastScanAt/lastFound/candidates/ports/excludedPorts/intervalMs/timeoutMs/host`） |
| `/api/qq-bot/diagnose` | POST | **运行自检**：6 项检查（OneBot 监听 / 模型后端 / 反向 WS / 正向 WS / 面板直聊 / 记忆），返回 `{ok,checks,hints,at}` |
| `/api/qq-bot/log` | GET | 完整日志环（默认 200 条） |
| `/api/qq-bot/chat` | POST | **面板直聊**：发一条消息走完整 BotLogic 管线（`{text,image}`），返回回复与历史 |
| `/api/qq-bot/chat-clear` | POST | 清空直聊会话历史 |
| `/api/qq-bot/forward-config` | POST | 设置 / 更新正向 WS 地址并连接（持久化到 `~/.dsh/qq-bot-forward.json`） |
| `/api/qq-bot/forward-disconnect` | POST | 断开正向 WS 连接 |
| `/api/qq-bot/detect-scan` | POST | **立即扫描**：触发一次本机 OneBot 端口自动探测，返回 `{ok,detect,hits}` |
| `/api/qq-bot/detect-config` | POST | **开关自动探测**：body `{enabled:true\|false}`，返回 `{ok,detect,enabled}` |
| `/api/qq-bot/llm-test` | POST | 测试当前模型后端连通性 |
| `/api/qq-bot/send` | POST | 经真实连接发送测试消息（`{messageType,userId\|groupId,text}`） |
| `/api/qq-bot/stats-reset` | POST | 清空消息统计 |
| `/api/qq-bot/log-clear` | POST | 清空日志 |
| `/api/qq-bot/memory` | GET | 记忆概况 + 最近会话列表 |
| `/api/qq-bot/memory-facts` | GET | 某会话记住的条目（`?key=private:12345`） |
| `/api/qq-bot/memory-history` | GET | 某会话最近对话上下文（`?key=private:12345`） |
| `/api/qq-bot/memory-forget` | POST | 删除记忆（`{key,fact}` / `{key}` / `{scope:'all'}`） |
| `/api/qq-bot/memory-save` | POST | 立即把记忆写入磁盘 |
| `/api/qq-bot/memory-newtopic` | POST | 清空某会话的对话上下文（`{key}`，长期记忆保留） |

> GET 读接口：`status` / `log` / `memory` / `memory-facts` / `memory-history`；其余均为 POST 写接口。

---

## 7. 验证与排错

- **健康检查**：插件启动后在日志打印监听地址，浏览器 / curl 访问 `http://127.0.0.1:6700/health`，返回 `{ok,plugin,started,connections,selfIds,replyVia,path}`。`started:true` 即监听正常；`connections` / `selfIds` 有值表示已有 OneBot 端连回。
- **运行自检**：面板「③ 运行自检」的「运行自检」按钮跑 6 项检查，只检查插件自己能控制的东西（不再探测任何外部客户端的登录状态），失败项给出中文提示。当前没连真实 QQ 时会提示「独立测试模式：直接在面板 ① 直聊测试发消息即可」。
- **不需要 token / key**：默认 `llm.mode='harness'` 跟随 Harness 模型，直聊测试无需任何令牌；`accessToken` 留空即不校验。
- **别被 405 绕晕**：读接口是 **GET**（`status` / `log` / `memory` / `memory-facts` / `memory-history`），写接口是 **POST**（`diagnose` / `chat` / `chat-clear` / `forward-config` / `forward-disconnect` / `detect-scan` / `detect-config` / `llm-test` / `send` / `stats-reset` / `log-clear` / `memory-forget` / `memory-save` / `memory-newtopic`）。方法用错会返回 405。
- **改配置不生效**：编辑 `cordis.patch.yml` 后必须**禁用 → 启用**插件（或重启 Harness）；禁用会关闭监听端口，重新启用后用新配置重新监听。
- **面板接口 403**：`/api/qq-bot/*` 只接受本机同源请求，跨站 / Origin 与 Host 不一致 / 非 loopback 会被拒绝。

---

## 安全提示

- 默认监听 `0.0.0.0`。只在本地使用建议把 `host` 改为 `127.0.0.1`，或设置 `accessToken` 防止他人接入。
- API Key 只写在本地插件配置里，不会外传。
- 图片下载有 8MB 上限与超时保护。
- **SSRF 防护**：默认只下载公网 `http(s)` 图片，逐跳校验并拒绝 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（云元数据）、IPv6 本地地址与 IPv4-mapped 写法；跳转后重新校验。确需局域网图床才把 `llm.allowPrivateImages` 设为 `true`。
- `file://` 图片引用一律忽略（插件是服务端，不读取本机任意文件）。
- 面板接口 `/api/qq-bot/*` 只接受本机同源请求：拒绝 `sec-fetch-site: cross-site`、Origin 与 Host 不一致的跨站调用、非 loopback 的 Host 头与非 loopback 的 TCP 对端地址。
