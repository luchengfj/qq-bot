// Host-side bridge: expose this plugin's state and controls to the DSH Web UI.
//
// The plugin owns its own HTTP server for OneBot (port 6700 by default). The
// DSH panel is a Client module running inside the Web GUI origin, so we
// register routes on `ctx.webServer` under /api/qq-bot/* and let client.js
// fetch them same-origin.
//
// Every route is guarded: only same-origin, non-cross-site requests from a
// loopback caller are served (see isBridgeRequestAllowed).
//
// 「零下载」API surface:
//   status / diagnose / log / log-clear / stats-reset
//   chat / chat-clear                -> in-panel direct chat (no install needed)
//   forward-config / forward-disconnect -> connect to an existing OneBot server
//   send                            -> send via a live real-QQ connection
//   llm-test + memory/*             -> diagnostics
// No NapCat download / QR / one-click-link endpoints remain.

import { askVision } from './vision.js';
import { askHarness } from './harness-llm.js';

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
 * @param {object} deps - { cfg, bridge, log, logRing, stats, memory, forward,
 *   simulator, llm, agentDefaultModel, attachments }
 * @returns {Array<{kind: string, path: string, handler: Function}>}
 */
export function makeBridgeRoutes(deps) {
  const { cfg, bridge, log, logRing, stats } = deps;
  const memory = deps.memory || null;
  const forward = deps.forward || null;
  const simulator = deps.simulator || null;

  // Logged once per plugin lifetime: proves the DSH panel actually rendered
  // and reached this route (the panel polls /status every few seconds).
  let panelSeen = false;

  const status = () => {
    const fwd = forward ? forward.info() : {
      enabled: false, url: '', connected: false, status: 'unavailable',
      lastError: '', lastConnectAt: 0, reconnectMs: 5000,
    };
    const connections = bridge ? bridge.connections.size : 0;
    let mode = 'standalone';
    if (fwd.connected && connections > 0) mode = 'both';
    else if (fwd.connected) mode = 'forward';
    else if (connections > 0) mode = 'reverse';

    return {
      ok: true,
      plugin: '@local/qq-bot',
      started: Boolean(bridge?.started),
      endpoint: {
        host: cfg.host,
        port: cfg.port,
        path: cfg.path,
        replyVia: cfg.replyVia,
        reverseWsUrl: `ws://127.0.0.1:${cfg.port}${cfg.path}`,
      },
      connections,
      selfIds: bridge ? [...bridge.selfIds] : [],
      mode,
      forward: fwd,
      llm: {
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
      chat: {
        messages: simulator ? simulator.history() : [],
      },
    };
  };

  /**
   * One-click self-check for the zero-download flow. Checks only things the
   * plugin itself controls — no NapCat WebUI / token / QQ login probing.
   * Shape matches the DSH panel: { ok, checks, hints, at }.
   */
  const runDiagnose = async () => {
    const fwd = forward ? forward.info() : null;
    const checks = [];
    const hints = [];
    const push = (id, label, ok, detail, hint) => {
      checks.push({ id, label, ok: Boolean(ok), detail: String(detail ?? ''), hint: hint || '' });
      if (!ok && hint) hints.push(hint);
    };

    // 1. The plugin's own OneBot listener (reverse WS / HTTP POST endpoint).
    push('bridge', 'OneBot 通道已启动', Boolean(bridge?.started),
      bridge?.started ? `监听 ${cfg.host}:${cfg.port}${cfg.path}` : '插件尚未启动监听',
      bridge?.started ? '' : '在插件设置里重新启用 @local/qq-bot。');

    // 2. Model backend availability (Harness-native, no key needed by default).
    const llmMode = cfg.llm?.mode || 'harness';
    const llmReady = llmMode !== 'harness' || Boolean(deps.llm);
    push('llm', '模型后端就绪', llmReady,
      llmMode === 'harness'
        ? (deps.llm ? 'Harness 内置 llm 服务已就绪（跟随 Harness 默认模型）' : 'Harness llm 服务缺失')
        : `外部端点 ${cfg.llm?.model || cfg.llm?.baseUrl || '未配置'}`,
      llmReady ? '' : (llmMode === 'harness'
        ? '请在 Harness 里选择一个模型；或把 llm.mode 改成 external 并填 apiKey/baseUrl。'
        : '请在配置里填写 llm.apiKey 与 llm.baseUrl。'));

    // 3. Reverse WS / HTTP connections from a real OneBot implementation.
    const connections = bridge ? bridge.connections.size : 0;
    push('reverse', '已有 OneBot 端连回本插件', connections > 0,
      connections > 0 ? `${connections} 个连接` : '暂无（可选：让 NapCat/Lagrange 等连回本插件）',
      '');

    // 4. Forward WS (plugin -> existing OneBot server).
    const forwardOk = Boolean(fwd && fwd.connected);
    push('forward', '正向 WebSocket 已连接', forwardOk,
      fwd ? (forwardOk ? `已连接 ${fwd.url}` : (fwd.url ? `${fwd.status}：${fwd.lastError || '未连接'}` : '未配置（可选）')) : '管理器不可用',
      '');

    // 5. In-panel chat works without ANY of the above.
    push('chat', '面板直聊测试可用', Boolean(simulator),
      simulator ? '无需安装任何东西，直接在「直聊测试」里发消息' : '直聊模拟器未初始化',
      simulator ? '' : '重新启用插件。');

    // 6. Long-term memory.
    push('memory', '记忆功能', Boolean(memory && memory.enabled !== false),
      memory ? (memory.enabled === false ? '已关闭' : `开启，${memory.stats ? memory.stats().senders : 0} 个会话`) : '不可用',
      '');

    if (!connections && !forwardOk) {
      hints.unshift('当前是「独立测试」模式：直接在面板「① 直聊测试」发消息即可，无需连接真实 QQ。');
    }
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
    // --- In-panel direct chat (zero-download smoke test) -------------------
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/chat`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        if (!simulator) return writeJson(res, 400, { ok: false, error: '直聊模拟器未启用' });
        const body = await readJsonBody(req);
        if (!body) return writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        try {
          const result = await simulator.send(body.text ?? '', body.image ?? '');
          log(`面板直聊：用户消息 ${String(body.text ?? '').slice(0, 40)} → ${result.replies.length} 条回复`);
          writeJson(res, 200, result);
        } catch (err) {
          writeJson(res, 200, { ok: false, error: err.message, replies: [], history: simulator.history() });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/chat-clear`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        if (simulator) simulator.clear();
        writeJson(res, 200, { ok: true, history: simulator ? simulator.history() : [] });
      },
    },
    // --- Connect to a real QQ (an already-running OneBot v11 server) ------
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/forward-config`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        if (!forward) return writeJson(res, 400, { ok: false, error: '正向连接管理器未启用' });
        const body = await readJsonBody(req);
        if (!body) return writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        try {
          const info = forward.configure(body);
          log(`面板：正向 WebSocket 配置已更新 (${info.url})`);
          writeJson(res, 200, { ok: true, forward: info });
        } catch (err) {
          writeJson(res, 200, { ok: false, error: err.message, forward: forward.info() });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/forward-disconnect`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const info = forward ? forward.disconnect() : null;
        writeJson(res, 200, { ok: true, forward: info });
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
    // --- Memory / conversation context ------------------------------------
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
