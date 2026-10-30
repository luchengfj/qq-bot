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
      llm: base.llm || { baseUrl: cfg.llm?.baseUrl || '', model: cfg.llm?.model || '', hasKey: Boolean(cfg.llm?.apiKey) },
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
    };
  };

  const requireNapcat = (res) => {
    const setup = getSetup();
    if (!setup || !setup.napcat) {
      writeJson(res, 400, { ok: false, error: '未配置 NapCat WebUI（cordis.patch.yml 的 napcat.baseUrl / napcat.webuiToken）' });
      return null;
    }
    return setup;
  };

  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/status`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        writeJson(res, 200, status());
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
          const answer = await askVision(
            { ...cfg.llm, maxImageBytes: cfg.maxImageBytes },
            { text: '请只回复两个字：正常', images: [] },
          );
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
