// Vision / chat backend for the QQ bot.
//
// Talks to any OpenAI-compatible `/chat/completions` endpoint (DashScope's
// compatible-mode, OpenAI, DeepSeek, a local vLLM/Ollama gateway, ...). The
// endpoint, key and model are all configurable from the plugin patch. Images
// are downloaded in-process (with a hard byte cap) and inlined as data URIs,
// which is the format every OpenAI-compatible vision API accepts.

import dns from 'node:dns';

/**
 * Download a remote image into a base64 data URI.
 * Enforces a maximum size so a malicious/large URL can't exhaust memory.
 *
 * @param {string} url
 * @param {{ maxBytes?: number, timeoutMs?: number }} options
 * @returns {Promise<{ dataUri: string, bytes: number, mime: string }>}
 */
export async function downloadImage(url, options = {}) {
  const maxBytes = clampInt(options.maxBytes, 1, 64 * 1024 * 1024, 8 * 1024 * 1024);
  const timeoutMs = clampInt(options.timeoutMs, 1000, 300000, 30000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await assertPublicImageUrl(url, options);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'dsh-qq-bot/1.0', Accept: 'image/*,*/*;q=0.8' },
    });

    // Follow redirects ourselves so every hop is re-validated: a public host
    // must not be able to bounce us onto a loopback / metadata address.
    if (isRedirectStatus(res.status)) {
      const { dataUri, bytes, mime } = await followRedirects(res, url, { maxBytes, timeoutMs, controller, deadline: Date.now() + timeoutMs });
      return { dataUri, bytes, mime };
    }
    return readImageResponse(res, url, { maxBytes });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask an OpenAI-compatible chat/vision endpoint.
 *
 * @param {object} config - the `llm` config block (baseUrl, apiKey, model,
 *   systemPrompt, maxTokens, timeoutMs, maxImageBytes)
 * @param {{ text: string, images: string[] }} input - text prompt + image URLs
 * @returns {Promise<string>} the assistant reply text
 */
export async function askVision(config, input) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(config.apiKey || '');
  const model = String(config.model || '');
  const systemPrompt = String(config.systemPrompt || '你是 QQ 里的智能助手，请用简洁、友好的中文回答问题。');
  const maxTokens = clampInt(config.maxTokens, 1, 32768, 1024);
  const timeoutMs = clampInt(config.timeoutMs, 1000, 600000, 60000);
  const maxImageBytes = clampInt(config.maxImageBytes, 1, 64 * 1024 * 1024, 8 * 1024 * 1024);

  if (!baseUrl) throw new Error('未配置视觉接口地址 (llm.baseUrl)');
  if (!model) throw new Error('未配置视觉模型 (llm.model)');
  // Some local gateways (Ollama/vLLM) need no key. Only require it for the
  // hosted DashScope/OpenAI defaults — but don't hard-fail if it's empty,
  // just send without the header so local setups still work.
  const needsKey = /dashscope|openai\.com|api\.deepseek/i.test(baseUrl);
  if (needsKey && !apiKey) {
    throw new Error('未配置视觉接口密钥 (llm.apiKey)，请在插件配置中填写');
  }

  // Download all images (up to a sane cap) in parallel.
  const imageUrls = (input.images || []).slice(0, 4);
  // SSRF guard is on by default; only a config opt-in (used by local tests and
  // self-hosted gateways that really do serve images from the LAN) turns it off.
  const allowPrivate = config.allowPrivateImages === true;
  const downloaded = await Promise.all(
    imageUrls.map((url) =>
      downloadImage(url, {
        maxBytes: maxImageBytes,
        timeoutMs: Math.min(timeoutMs, 45000),
        allowPrivate,
      }),
    ),
  );

  const userContent = [];
  const text = String(input.text || '').trim();
  if (text) userContent.push({ type: 'text', text });
  for (const img of downloaded) {
    userContent.push({ type: 'image_url', image_url: { url: img.dataUri } });
  }
  if (userContent.length === 0) {
    userContent.push({ type: 'text', text: '（用户未输入内容）' });
  }

  const endpoint = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
    temperature: 0.4,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(`视觉接口返回 HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('视觉接口返回的不是有效 JSON');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  // Some providers return an array of content parts.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (joined) return joined;
  }
  throw new Error('视觉接口未返回可识别的回答内容');
}

/**
 * Follow redirects manually, re-validating every hop.
 */
async function followRedirects(res, startUrl, state, hops = 0) {
  if (hops >= 5) throw new Error('图片下载重定向次数过多');
  if (Date.now() > state.deadline) throw new Error('图片下载超时');

  let current = res;
  let currentUrl = startUrl;
  while (isRedirectStatus(current.status)) {
    const location = current.headers.get('location');
    if (!location) throw new Error('图片下载重定向缺少 Location');
    const nextUrl = new URL(location, currentUrl).toString();
    await assertPublicImageUrl(nextUrl, { allowPrivate: state.allowPrivate });
    if (current.body && current.body.cancel) { try { await current.body.cancel(); } catch { /* ignore */ } }
    currentUrl = nextUrl;
    current = await fetch(nextUrl, {
      signal: state.controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'dsh-qq-bot/1.0', Accept: 'image/*,*/*;q=0.8' },
    });
    if (hops++ >= 5) throw new Error('图片下载重定向次数过多');
    if (Date.now() > state.deadline) throw new Error('图片下载超时');
  }
  return readImageResponse(current, currentUrl, { maxBytes: state.maxBytes });
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Guard against SSRF: image URLs come from chat events, so an attacker could
 * otherwise point us at http://127.0.0.1/... or a cloud metadata endpoint and
 * have the bytes inlined straight into the LLM request.
 */
export async function assertPublicImageUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error('图片地址无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的图片协议 (${parsed.protocol || '空'})`);
  }
  if (options.allowPrivate) return parsed;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost') throw new Error('禁止下载本机地址的图片');

  // Literal IPs: check directly, no DNS needed.
  const literal = parseIpLiteral(host);
  if (literal) {
    if (!isPublicAddress(literal.family, literal.address)) {
      throw new Error(`禁止下载内网地址的图片 (${host})`);
    }
    return parsed;
  }

  // Hostnames: resolve first so a name pointing at 127.0.0.1 is refused too.
  let addresses = [];
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error('图片域名解析失败');
  }
  if (addresses.length === 0) throw new Error('图片域名解析失败');
  // Every resolved address must be public — one private answer is enough to
  // let a redirect chain land on an internal host.
  for (const entry of addresses) {
    if (!isPublicAddress(entry.family, entry.address)) {
      throw new Error(`禁止下载内网地址的图片 (${host} → ${entry.address})`);
    }
  }
  return parsed;
}

function parseIpLiteral(host) {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1, 5).map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return { family: 4, address: host };
  }
  if (host === '::1' || host === '::') return { family: 6, address: host };
  if (host.startsWith('[')) return { family: 6, address: host.slice(1, -1) };
  if (host.includes(':')) return { family: 6, address: host };
  return null;
}

function isPublicAddress(family, address) {
  if (family === 6 || family === 'IPv6') return isPublicIpv6(address);
  return isPublicIpv4(address);
}

function isPublicIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;              // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return false;      // 172.16.0.0/12
  if (a === 192 && b === 168) return false;               // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return false;     // CGNAT
  if (a >= 224) return false;                             // multicast / reserved
  return true;
}

function isPublicIpv6(address) {
  const ip = String(address).toLowerCase().split('%')[0];
  if (ip === '::' || ip === '::1') return false;
  if (ip.startsWith('fe80') || ip.startsWith('fec0')) return false;   // link/site local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return false;       // unique local
  if (ip.startsWith('ff')) return false;                              // multicast
  // IPv4-mapped (::ffff:127.0.0.1) and NAT64 prefixes must be judged as v4 —
  // both the dotted-quad and the hex-group spellings.
  const mappedDotted = ip.match(/(?:^|:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isPublicIpv4(mappedDotted[1]);
  const mappedHex = ip.match(/^(?:::|0+:)+ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return isPublicIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.'));
    }
  }
  const nat64 = ip.match(/^64:ff9b:.*?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (nat64) return isPublicIpv4(nat64[1]);
  return true;
}

function readImageResponse(res, url, options) {
  const maxBytes = options.maxBytes;
  if (!res.ok) throw new Error(`图片下载失败 (HTTP ${res.status})`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new Error(`图片过大 (${formatBytes(declared)} > ${formatBytes(maxBytes)})`);
  }
  const mime = normalizeMime(res.headers.get('content-type') || '', url);
  return readStreamWithCap(res, maxBytes).then((buf) => {
    if (buf.length === 0) throw new Error('图片内容为空');
    return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, mime };
  });
}

async function readStreamWithCap(res, maxBytes) {
  const chunks = [];
  let total = 0;
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`图片过大 (超过 ${formatBytes(maxBytes)})`);
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const ab = await res.arrayBuffer();
    total = ab.byteLength;
    if (total > maxBytes) throw new Error(`图片过大 (超过 ${formatBytes(maxBytes)})`);
    chunks.push(Buffer.from(ab));
  }
  return Buffer.concat(chunks, total);
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function normalizeMime(contentType, url) {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return ct;
  const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  };
  return map[ext] || 'image/jpeg';
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
