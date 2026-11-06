# 发布到 DSH 插件市场

本仓库提供两种让 `@local/qq-bot` 出现在 DSH 插件市场的方式：

- **方式 A（自己可控，立即可用）**：仓库自带一份单条目索引 [market/dsh-index.json](market/dsh-index.json)，把它作为「自定义插件市场源」添加到 DSH 即可。
- **方式 B（社区收录）**：按 awesome-dsh-plugin 的规则提交一个 YAML 文件 PR；合并后由第三方市场自动收录。

两种方式互不依赖，建议先做 A，再按需做 B。

> 本插件是「零下载」的 DSH 面板插件：纯 Node、零 npm 依赖、不下载不安装任何 QQ 客户端。
> 启用后即可在面板「① 直聊测试」里直接走完整 BotLogic 流程；如需连接真实 QQ，
> 支持「自动探测本机 OneBot 端口」——自动扫描本机常见端口并自动连接（无需填地址、不覆盖手工配置），
> 也可选填一个**已经装好并正在运行**的 OneBot v11 正向 / 反向 WebSocket 地址，
> 插件本身不会自动下载任何东西。

---

## 方式 A：自建市场源（推荐）

### 1. 索引地址

索引随本仓库 `main` 分支发布，经 jsDelivr 提供 HTTPS 访问：

```
https://cdn.jsdelivr.net/gh/luchengfj/qq-bot@main/market/dsh-index.json
```

内容用仓库里的生成器重建（零依赖，只用 Node 内置模块）：

```sh
cd C:\ai\qq-bot
node scripts/make-market-index.mjs
# 可用 QQ_MARKET_COMMIT=<40位提交号> 指定要发布的版本提交
```

`market/plugin.json` 是条目元数据的唯一来源（名称、标题、描述、图标、分类、关键词、标签）。`scripts/make-icon.py` 用 Pillow 生成 `assets/icon-180.png` 图标。索引格式遵循 DSH 内置的「plugin market index format 1」校验器；`market/dsh-index.json` 已通过该校验器验证，安装目标为：

```
git+https://github.com/luchengfj/qq-bot.git#<40-hex-commit>
```

### 2. 在 DSH 中添加该源

> ⚠️ 只有用户本人能在 DSH 设置里增删市场源；插件代码/本仓库无权改写当前 profile 的
> `cordis.patch.yml`。请在图形界面里操作，不要手改 profile 配置文件。

1. 打开 DSH 设置 → **插件 / 插件市场（Plugin Market / Discover）**。
2. 找到「自定义插件市场 / Custom Plugin Market」的索引源（indexes）列表。
3. 新增一条索引 URL，填入上面的 jsDelivr 地址。
4. 保存后刷新 Discover：会出现「QQ 机器人通道 / @local/qq-bot」条目，带图标、描述与分类。
5. 点「安装」即可把本仓库按索引里固定的提交号装入当前 profile。

> 现有的社区索引
> `https://cdn.jsdelivr.net/gh/realguan/dsh-plugin-market@dist/dsh-index.json`
> 可保留，两者会同时出现在来源下拉里；自建索引只含本插件一个条目，加载很快。

### 3. 发布新版本时

1. 提交并推送插件代码，记下新的 40 位提交号。
2. 运行 `QQ_MARKET_COMMIT=<新提交号> node scripts/make-market-index.mjs`（或先提交市场文件再让脚本读取当前 HEAD）。
3. 提交 `market/dsh-index.json` 并推送；jsDelivr 的 `@main` 会在缓存过期后更新（可在 URL 用 `@<commit>` 强制即时生效）。

---

## 方式 B：提交到社区市场（awesome-dsh-plugin）

社区索引由第三方 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的
`data/plugins/*.yml` 生成，**本仓库无法直接写入**，需要由你用自己的 GitHub 账号开一个 PR。

### 1. 待提交文件

已准备好 [market/submit/luchengfj__qq-bot.yml](market/submit/luchengfj__qq-bot.yml)，内容符合其规则：
`url` 与仓库完全一致、`category: identity`、英文描述以句号结尾、中文描述可选、
`icon` 指向 GitHub 托管的 180×180 位图、描述中含 `: ` 已加引号。

### 2. 提交步骤

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`。
2. 在你的 fork 里新建文件 `data/plugins/luchengfj__qq-bot.yml`，内容复制自上面的文件。
3. 确保 PR 只新增这一个文件（不要改动别人的条目、不要改生成的 README）。
4. 开 PR 等待 CI（校验 `dsh.bundle`、仓库年龄≥1 天、YAML 合法、README 可重新生成）与维护者人工审核。

### 3. 已满足的收录要求

- `package.json` 声明了 `dsh.bundle.patch`，`cordis.patch.yml` 含 `insert` 行 `{ id: qq-bot, name: '@local/qq-bot' }`。
- 仓库有真实可运行代码（OneBot v11 反向 / 正向 WS 与 HTTP POST 桥接、视觉问答、面板直聊测试、记忆等），非占位/纯依赖包。
- 仓库创建于 2026-10-30，已超过 1 天。
- 仓库已添加 `dsh-plugin` topic（另含 `qq-bot`、`onebot-v11`、`zero-download`、`direct-chat`、`deepseek-harness`）。
- 描述与代码一致，无夸大营销词；分类选了最贴近的 `identity`（QQ 通道/身份通信）。
- 含 MIT `LICENSE`。

> 审核由第三方维护者完成，是否收录、何时出现在社区索引由对方决定，本仓库无法保证。
> 因此方式 A 是确定可用的路径：它完全由本仓库与用户的 DSH 设置控制。
