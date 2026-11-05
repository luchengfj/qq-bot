// Host-side bridge: expose this plugin's state and controls to the DSH Web UI.
//
// The plugin owns its own HTTP server for OneBot (port 6700 by default) and
// serves its standalone /setup console there. The DSH panel, however, is a
// Client module that runs inside the Web GUI origin, so it needs the data on
// the GUI's own server. Following the pattern used by dsh-free-search, we
// register routes on `ctx.webServer` under /api/qq-bot/* and let client.js
// fetch them same-origin.
//
// Every route is guarded: only same-origin, non-cross-site requests from a
// loopback caller are served (see isBridgeRequestAllowed).

import { askVision } from './vision.js';
import { askHarness } from './harness-llm.js';
import { probePort, probeWebUi } from './installer.js';

export const BRIDGE_PREFIX = '/api/qq-bot';

/** Fixed-size ring buffer of recent plugin log lines. */
export function createLogRing(limit = 200) {
  const items = [];
  return {
    push(message) {
      items.push({ at: Date.now(), message: String(message) });
      while (items.length > limit) items.shift();
    },
    list() {
      return items.slice();
    },
    clear() {
      items.length = 0;
    },
  };
}

/** Simple counters shown on the panel. */
export function createStats() {
  const stats = {
    received: 0,
    answered: 0,
    failed: 0,
    lastError: '',
    lastAt: 0,
    reset() {
      stats.received = 0;
      stats.answered = 0;
      stats.failed = 0;
      stats.lastError = '';
      stats.lastAt = 0;
    },
  };
  return stats;
}

/**
 * Build the route objects consumed by ctx.webServer.register().
 *
 * @param {object} deps - { cfg, bridge, setup, log, logRing, stats }
 * @returns {Array<{kind: string, path: string, handler: Function}>}
 */
export function makeBridgeRoutes(deps) {
  const { cfg, bridge, log, logRing, stats } = deps;
  const memory = deps.memory || null;
  const installer = deps.installer || null;

  // Logged once per plugin lifetime: proves the DSH panel actually rendered
  // and reached this route (the panel polls /status every few seconds).
  let panelSeen = false;

  const getSetup = () => deps.setup || bridge?.setup || null;

  const status = () => {
    const setup = getSetup();
    const base = setup && typeof setup.status === 'function' ? setup.status() : {};
    return {
      ok: true,
      plugin: '@local/qq-bot',
      started: Boolean(bridge?.started),
      endpoint: {
        host: cfg.host,
        port: cfg.port,
        path: cfg.path,
        replyVia: cfg.replyVia,
      },
      connections: bridge ? bridge.connections.size : 0,
      selfIds: bridge ? [...bridge.selfIds] : [],
      reverseUrl: base.reverseUrl || '',
      setupUrl: `http://127.0.0.1:${cfg.port}/setup`,
      napcat: base.napcat || { configured: false, baseUrl: null, hasToken: false },
      llm: base.llm || {
        mode: cfg.llm?.mode || 'harness',
        baseUrl: cfg.llm?.baseUrl || '',
        model: cfg.llm?.model || '',
        hasKey: Boolean(cfg.llm?.apiKey),
      },
      trigger: cfg.trigger,
      allow: cfg.allow,
      stats: {
        received: stats.received,
        answered: stats.answered,
        failed: stats.failed,
        lastError: stats.lastError,
        lastAt: stats.lastAt,
      },
      log: logRing.list().slice(-30),
      memory: memory ? memory.stats() : null,
      napcatRuntime: installer
        ? (() => {
            const s = installer.status();
            return { ...s, running: s.running };
          })()
        : null,
    };
  };

  const requireNapcat = (res) => {
    const setup = getSetup();
    if (!setup) {
      writeJson(res, 400, { ok: false, error: '插件初始化尚未完成，请稍后重试。' });
      return null;
    }
    // ensureReady() re-runs auto-discovery (webui.json / env / explicit token)
    // and throws a friendly, hint-carrying error when NapCat is not ready.
    // Both the DSH panel and the standalone console share this exact logic.
    if (typeof setup.ensureReady === 'function') {
      try {
        setup.ensureReady();
        return setup;
      } catch (err) {
        writeJson(res, err.status || 503, {
          ok: false, error: err.message, hints: err.hints || [],
        });
        return null;
      }
    }
    // Legacy fallback for older SetupConsole shapes.
    if (!setup.napcat || !setup.napcat.token) {
      writeJson(res, 503, { ok: false, error: '尚未发现 NapCat WebUI 令牌：请先启动 NapCat。', hints: [] });
      return null;
    }
    return setup;
  };

  /**
   * One-click self-check. Each check is independent so the panel can show a
   * readable green/red list instead of a single cryptic 502.
   * Shape matches the DSH panel's DiagnosePanel: { ok, checks, hints, at }.
   */
  const runDiagnose = async () => {
    const setup = getSetup();
    const nap = cfg.napcat || {};
    const port = Number(nap.webuiPort) || 6099;
    const checks = [];
    const hints = [];
    const push = (id, label, ok, detail, hint) => {
      checks.push({ id, label, ok: Boolean(ok), detail: String(detail ?? ''), hint: hint || '' });
      if (!ok && hint) hints.push(hint);
    };

    // 1. The plugin's own OneBot listener.
    push('bridge', 'OneBot 通道已启动', Boolean(bridge?.started),
      bridge?.started ? `监听 ${cfg.host}:${cfg.port}${cfg.path}` : '插件尚未启动监听',
      bridge?.started ? '' : '在插件设置里重新启用 @local/qq-bot。');

    // 2. Discovery pass (webui.json / env / explicit config).
    let discovery = setup && setup.discovery ? setup.discovery : null;
    if (setup && typeof setup.refreshDiscovery === 'function') {
      try { discovery = setup.refreshDiscovery(); } catch { /* keep old */ }
    }
    const token = setup && setup.napcat ? setup.napcat.token : '';
    push('token', '已获取 WebUI 令牌', Boolean(token),
      token
        ? `来源：${discovery?.tokenSource || 'config'}${discovery?.configPath ? ' · ' + discovery.configPath : ''}`
        : '未发现令牌（napcat.webuiToken 为空，且没有找到 webui.json）',
      token ? '' : '启动一次 NapCat 让它生成 webui.json，或在 cordis.patch.yml 填 napcat.webuiToken。');

    // 3. WebUI port reachable.
    const portOpen = await probePort(port, '127.0.0.1', 1500);
    push('port', `WebUI 端口 ${port} 可连接`, portOpen,
      portOpen ? 'TCP 连接成功' : '连接被拒绝 / 超时',
      portOpen ? '' : 'NapCat 没有运行：点「安装 NapCat」再点「启动 NapCat」；QQ 需先登录。');

    // 4. WebUI HTTP answer.
    const baseUrl = (setup && setup.napcat && setup.napcat.baseUrl) || `http://127.0.0.1:${port}`;
    const probe = await probeWebUi(baseUrl, 4000);
    push('webui', 'WebUI /api/test 正常', probe.ok,
      probe.ok ? `HTTP ${probe.status}` : (probe.error || `HTTP ${probe.status}`),
      probe.ok ? '' : '确认 NapCat 控制台没有报错、端口未被占用；WebUI 会在 QQ 登录前就启动。');

    // 5. Auth + QQ login status (only meaningful when the above pass).
    if (token && probe.ok && setup && setup.napcat) {
      try {
        const info = await setup.napcat.loginInfo();
        const logged = Boolean(info && info.isLogin);
        push('login', 'QQ 已登录', logged,
          logged ? `账号 ${info.uin || '?'}` : '等待扫码登录（二维码可在「接入」页获取）',
          logged ? '' : '先在「接入」页获取二维码，用手机 QQ 扫码并确认，再回来点「一键接入」。');
      } catch (err) {
        push('login', 'WebUI 鉴权 / 登录状态', false, err.message,
          '令牌可能已变化：重启 NapCat 后点「运行自检」重新发现 webui.json 里的令牌。');
      }
    } else {
      push('login', 'QQ 登录状态', false, '未检查（前置条件未满足）',
        '先让端口/令牌/WebUI 三项通过。');
    }

    // 6. Reverse-WS connection (the real "接入" signal).
    const connections = bridge ? bridge.connections.size : 0;
    push('reverse', 'NapCat 已连回本插件', connections > 0,
      connections > 0 ? `${connections} 个连接` : '暂无反向 WebSocket 连接',
      connections > 0 ? '' : 'QQ 登录后在「接入」页点「一键接入」写入反向 WS；或检查 NapCat 的 network.websocketClients。');

    if (!token) hints.unshift('最常见原因：NapCat 未启动或 webuiToken 为空。');
    return {
      ok: checks.every((c) => c.ok),
      checks,
      hints,
      at: Date.now(),
    };
  };

  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/status`,
      handler: async (req, res) => {
        const from = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '?';
        const host = req.headers.host || '?';
        const origin = req.headers.origin || '-';
        if (!panelSeen) {
          panelSeen = true;
          log(`DSH 面板已连接：收到第一个 /api/qq-bot/status 请求 (from=${from}, host=${host})`);
        }
        if (!guard(req, res, 'GET')) {
          log(`DSH 面板请求被守卫拒绝 (from=${from}, host=${host}, origin=${origin})`);
          return;
        }
        writeJson(res, 200, status());
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/diagnose`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          writeJson(res, 200, await runDiagnose());
        } catch (err) {
          writeJson(res, 200, { ok: false, checks: [], hints: [`自检异常：${err.message}`], at: Date.now() });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/log`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        writeJson(res, 200, { ok: true, lines: logRing.list() });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/qr.svg`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        const setup = getSetup();
        if (!setup || !setup.qr || !setup.qr.svg || setup.qr.expiresAt <= Date.now()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('二维码已过期，请刷新');
          return;
        }
        const body = setup.qr.svg;
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        res.end(body);
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/qr`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const setup = requireNapcat(res);
        if (!setup) return;
        try {
          writeJson(res, 200, await setup.newQr());
        } catch (err) {
          writeJson(res, 502, { ok: false, error: err.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/login-info`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const setup = requireNapcat(res);
        if (!setup) return;
        try {
          writeJson(res, 200, await setup.napcat.loginInfo());
        } catch (err) {
          writeJson(res, 502, { ok: false, error: err.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/link`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const setup = requireNapcat(res);
        if (!setup) return;
        try {
          const result = await setup.napcat.linkReverseWebSocket({
            url: setup.reverseUrl(),
            token: cfg.accessToken || '',
            name: 'dsh-qq-bot',
          });
          log(`面板：已写入 NapCat 反向 WebSocket ${result.url}（新增=${result.added}）`);
          writeJson(res, 200, { ok: true, ...result });
        } catch (err) {
          writeJson(res, 502, { ok: false, error: err.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/llm-test`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const started = Date.now();
        try {
          const llmCfg = { ...cfg.llm, maxImageBytes: cfg.maxImageBytes };
          const prompt = { text: '请只回复两个字：正常', images: [] };
          // Route the probe through whichever backend the bot actually uses,
          // otherwise the panel would test an endpoint that is switched off.
          const answer = llmCfg.mode === 'harness'
            ? await askHarness(
              { llm: deps.llm, agentDefaultModel: deps.agentDefaultModel, attachments: deps.attachments },
              llmCfg,
              prompt,
              (msg) => log(String(msg)),
            )
            : await askVision(llmCfg, prompt);
          writeJson(res, 200, { ok: true, ms: Date.now() - started, reply: String(answer).slice(0, 200) });
        } catch (err) {
          writeJson(res, 200, { ok: false, ms: Date.now() - started, error: err.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/send`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        if (!body) return writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        const params = buildOutgoingParams(body);
        if (!params) {
          return writeJson(res, 400, { ok: false, error: '需要 messageType=private|group 与对应的 user_id / group_id' });
        }
        try {
          const result = await bridge.callApi('send_msg', params);
          log(`面板：已发送测试消息到 ${params.message_type} ${params.user_id || params.group_id}`);
          writeJson(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
          writeJson(res, 502, { ok: false, error: err.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/stats-reset`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        stats.reset();
        writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/log-clear`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        logRing.clear();
        writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/memory`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        if (!memory) return writeJson(res, 200, { ok: true, enabled: false, senders: [] });
        writeJson(res, 200, { ok: true, ...memory.stats(), senders: memory.list(20) });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/memory-facts`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        const key = readQueryKey(req);
        if (!memory || !key) return writeJson(res, 200, { ok: true, facts: [] });
        writeJson(res, 200, { ok: true, key, facts: memory.facts(key) });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/memory-forget`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        if (!body || !memory) return writeJson(res, 400, { ok: false, error: '缺少参数' });
        const key = String(body.key || '');
        const scope = String(body.scope || 'sender');
        if (scope === 'all') {
          const n = memory.resetAll();
          log(`面板：已清空全部记忆（${n} 个会话）`);
          return writeJson(res, 200, { ok: true, cleared: n });
        }
        if (!key) return writeJson(res, 400, { ok: false, error: '缺少 key' });
        if (body.fact) {
          const n = memory.forget(key, String(body.fact));
          log(`面板：已删除 ${key} 的 ${n} 条记忆`);
          return writeJson(res, 200, { ok: true, removed: n });
        }
        const gone = memory.clear(key);
        log(`面板：已清除 ${key} 的记忆`);
        writeJson(res, 200, { ok: true, removed: gone ? 1 : 0 });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/memory-save`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        if (!memory) return writeJson(res, 400, { ok: false, error: '记忆未启用' });
        const ok = await memory.save();
        writeJson(res, 200, { ok, error: memory.lastError || undefined });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/memory-history`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        const key = readQueryKey(req);
        if (!memory || !key) return writeJson(res, 200, { ok: true, turns: [] });
        writeJson(res, 200, { ok: true, key, turns: memory.history(key) });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/memory-newtopic`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        if (!body || !memory) return writeJson(res, 400, { ok: false, error: '缺少参数' });
        const key = String(body.key || '');
        if (!key) return writeJson(res, 400, { ok: false, error: '缺少 key' });
        const dropped = memory.clearHistory(key);
        log(`面板：已重置 ${key} 的对话上下文`);
        writeJson(res, 200, { ok: true, reset: dropped });
      },
    },
    // --- NapCat runtime management (auto "一键接入") -----------------------
    // Without these the panel could only talk to a NapCat WebUI the user had
    // already installed by hand, which is what made it unusable in practice.
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/napcat-install`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        if (!installer) return writeJson(res, 400, { ok: false, error: '安装器未启用' });
        const started = await installer.startInstall();
        writeJson(res, 200, { ok: true, ...started });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/napcat-launch`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        if (!installer) return writeJson(res, 400, { ok: false, error: '安装器未启用' });
        const result = await installer.launch();
        if (result.ok) log(`面板：已启动 NapCat 运行时 (pid=${result.pid})`);
        else log(`面板：启动 NapCat 失败 ${result.error || ''}`);
        writeJson(res, 200, { ok: result.ok, ...result, error: result.error });
      },
    },
  ];
}

/** Read ?key=... from an incoming request URL (best effort, no deps). */
function readQueryKey(req) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    return url.searchParams.get('key') || '';
  } catch {
    return '';
  }
}

/** OneBot send_msg params for an outgoing (panel-initiated) message. */
export function buildOutgoingParams(body) {
  const text = String(body?.text ?? body?.message ?? '').trim();
  if (!text) return null;
  const type = String(body?.messageType ?? body?.message_type ?? '');
  if (type === 'private') {
    const userId = Number(body?.userId ?? body?.user_id);
    if (!Number.isFinite(userId)) return null;
    return { message_type: 'private', user_id: userId, message: text };
  }
  if (type === 'group') {
    const groupId = Number(body?.groupId ?? body?.group_id);
    if (!Number.isFinite(groupId)) return null;
    return { message_type: 'group', group_id: groupId, message: text };
  }
  return null;
}

function guard(req, res, method) {
  if (!isBridgeRequestAllowed(req)) {
    writeJson(res, 403, { ok: false, error: '只允许来自本机 Web 界面的同源请求' });
    return false;
  }
  if (req.method !== method) {
    writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` });
    return false;
  }
  return true;
}

export function isBridgeRequestAllowed(req) {
  // Reject confused-deputy requests from other sites.
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== parsed.host) return false;
    } catch {
      return false;
    }
  }
  if (!isLoopbackHostname(parsed.hostname)) return false;
  return isLoopbackAddress(req.socket && req.socket.remoteAddress);
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isLoopbackAddress(address) {
  const value = String(address || '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function writeJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 256 * 1024) return null;
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
