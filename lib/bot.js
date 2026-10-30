// Bot logic: decide which OneBot events to answer, call the vision backend,
// and reply. Kept separate from transport so it is easy to test/extend.

import { parseMessage } from './message.js';
import { askVision } from './vision.js';

const DEFAULT_PREFIX = '';
const MAX_TRACKED_IDS = 2000;

export class BotLogic {
  /**
   * @param {object} cfg - full normalized plugin config
   * @param {(msg: string) => void} log
   */
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.seen = new Set();
    this.seenQueue = [];
  }

  /** True if we've already handled this event (dedup by message_id). */
  _isDuplicate(event) {
    const id = event.message_id;
    if (id == null) return false;
    const key = String(id);
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.seenQueue.push(key);
    if (this.seenQueue.length > MAX_TRACKED_IDS) {
      const old = this.seenQueue.shift();
      this.seen.delete(old);
    }
    return false;
  }

  /**
   * Decide whether an incoming event should be answered.
   * Returns { answer: boolean, reason?: string }.
   */
  shouldAnswer(event) {
    if (!event || event.post_type !== 'message') {
      return { answer: false, reason: 'post_type != message' };
    }
    if (event.message_type !== 'private' && event.message_type !== 'group') {
      return { answer: false, reason: `message_type=${event.message_type}` };
    }

    const trigger = this.cfg.trigger || {};
    const selfId = event.self_id != null ? String(event.self_id) : '';

    if (event.message_type === 'private') {
      if (trigger.privateAlways === false) {
        return { answer: false, reason: 'privateAlways=false' };
      }
    } else {
      // Group messages: require @self OR a configured prefix (unless disabled).
      const parsed = parseMessage(event.message);
      const atList = parsed.atList || [];
      const mentioned =
        selfId && (atList.includes(selfId) || atList.includes('all'));
      const prefix = typeof trigger.prefix === 'string' ? trigger.prefix : DEFAULT_PREFIX;
      const startsWithPrefix = prefix && parsed.text.trim().startsWith(prefix);
      const requiresAt = trigger.groupRequiresAt !== false;
      if (requiresAt && !mentioned && !startsWithPrefix) {
        return { answer: false, reason: 'group message not @self or prefixed' };
      }
    }

    // Allow / deny lists.
    const allow = this.cfg.allow || {};
    const denyUsers = (allow.denyUsers || []).map(String);
    const userId = event.user_id != null ? String(event.user_id) : '';
    if (denyUsers.length > 0 && (!userId || denyUsers.includes(userId))) {
      return { answer: false, reason: userId ? 'user in denyUsers' : 'missing user_id while denyUsers set' };
    }
    const allowUsers = (allow.users || []).map(String);
    if (allowUsers.length > 0 && (!userId || !allowUsers.includes(userId))) {
      return { answer: false, reason: userId ? 'user not in allow.users' : 'missing user_id while allow.users set' };
    }
    if (event.message_type === 'group') {
      const allowGroups = (allow.groups || []).map(String);
      const groupId = event.group_id != null ? String(event.group_id) : '';
      if (allowGroups.length > 0 && (!groupId || !allowGroups.includes(groupId))) {
        return { answer: false, reason: groupId ? 'group not in allow.groups' : 'missing group_id while allow.groups set' };
      }
    }

    return { answer: true };
  }

  /**
   * Handle one event end-to-end: parse, call the backend, and reply.
   * Never throws — all failures are logged and, where possible, surfaced back
   * to the chat. Returns a status object (or null when the event is ignored).
   */
  async handle(event, replyFn, context = {}) {
    const decision = this.shouldAnswer(event);
    if (!decision.answer) {
      this.log(`忽略消息: ${decision.reason}`);
      return null;
    }
    if (this._isDuplicate(event)) {
      this.log('忽略重复消息 (message_id 去重)');
      return null;
    }

    const parsed = parseMessage(event.message);
    let text = parsed.text || '';
    // Strip a configured leading prefix from the prompt.
    const prefix = this.cfg.trigger?.prefix;
    if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length).trim();

    // Provide conversational context hint to the model (who / where).
    const who =
      event.sender?.nickname || (event.user_id != null ? `QQ ${event.user_id}` : '某人');
    const where = event.message_type === 'group' ? `群 ${event.group_id}` : '私聊';
    const contextHint = context.hint || '';
    const promptText = [
      contextHint,
      text
        ? `【${where} · ${who} 说】${text}`
        : `【${where} · ${who}】发送了图片，请描述图片内容并做出回应。`,
    ]
      .filter(Boolean)
      .join('\n');

    this.log(`收到消息: ${where}, 图片 ${parsed.images.length} 张, 文本 "${text.slice(0, 60)}"`);

    const llmCfg = this.cfg.llm || {};
    let answer;
    try {
      answer = await askVision(
        { ...llmCfg, maxImageBytes: llmCfg.maxImageBytes ?? this.cfg.maxImageBytes },
        { text: promptText, images: parsed.images },
      );
    } catch (err) {
      this.log(`视觉接口调用失败: ${err.message}`);
      const friendly = err.message.includes('未配置')
        ? err.message
        : `抱歉，处理失败：${err.message}`;
      await this._safeReply(replyFn, friendly, false);
      return { ok: false, error: friendly };
    }

    const atSender = event.message_type === 'group';
    const sent = await this._safeReply(replyFn, answer, atSender);
    if (!sent.ok) return { ok: false, error: sent.error, text: answer };
    return { ok: true, text: answer };
  }

  async _safeReply(replyFn, text, atSender) {
    if (typeof replyFn !== 'function') {
      this.log('没有可用的回复函数（可能未连接 OneBot 客户端）');
      return { ok: false, error: 'no reply function' };
    }
    try {
      await replyFn(text, { atSender });
      return { ok: true };
    } catch (err) {
      this.log(`回复发送失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
}

/**
 * Merge user-supplied config over defaults (shallow per known block).
 * Accepts a plain object from the patch's `config:` field.
 */
export function normalizeConfig(raw = {}) {
  const trigger = { ...(raw.trigger || {}) };
  const allow = { ...(raw.allow || {}) };
  const llm = { ...(raw.llm || {}) };
  const nap = { ...(raw.napcat || {}) };
  return {
    host: typeof raw.host === 'string' ? raw.host : '0.0.0.0',
    port: toInt(raw.port, 6700, 1, 65535),
    path: normalizePath(raw.path, '/onebot'),
    accessToken: String(raw.accessToken || ''),
    secret: String(raw.secret || ''),
    replyVia: raw.replyVia === 'http' ? 'http' : 'ws',
    httpApiBase: typeof raw.httpApiBase === 'string' ? raw.httpApiBase.replace(/\/+$/, '') : '',
    httpApiToken: String(raw.httpApiToken || ''),
    replyAtSender: raw.replyAtSender !== false,
    maxBodyBytes: toInt(raw.maxBodyBytes, 4 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxImageBytes: toInt(raw.maxImageBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    trigger: {
      privateAlways: trigger.privateAlways !== false,
      groupRequiresAt: trigger.groupRequiresAt !== false,
      prefix: typeof trigger.prefix === 'string' ? trigger.prefix : '',
    },
    allow: {
      groups: Array.isArray(allow.groups) ? allow.groups.map(String) : [],
      users: Array.isArray(allow.users) ? allow.users.map(String) : [],
      denyUsers: Array.isArray(allow.denyUsers) ? allow.denyUsers.map(String) : [],
    },
    napcat: {
      enabled: nap.enabled !== false,
      baseUrl: typeof nap.baseUrl === 'string' && nap.baseUrl.trim() ? nap.baseUrl.trim() : 'http://127.0.0.1:6099',
      webuiToken: String(nap.webuiToken || ''),
      reverseHost: String(nap.reverseHost || '127.0.0.1'),
      reversePort: toInt(nap.reversePort, 0, 0, 65535) || raw.port || 6700,
      timeoutMs: toInt(nap.timeoutMs, 15000, 1000, 120000),
    },
    llm: {
      baseUrl: llm.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: llm.apiKey || '',
      model: llm.model || 'qwen-vl-max-latest',
      systemPrompt: llm.systemPrompt || '你是 QQ 群里的智能助手，请用简洁、友好的中文回答用户的问题；当用户发来图片时，请描述图片并针对图片内容作答。',
      maxTokens: toInt(llm.maxTokens, 1024, 1, 32768),
      timeoutMs: toInt(llm.timeoutMs, 60000, 1000, 600000),
      // SSRF guard: image URLs come from chat events. Only opt out if your
      // gateway really serves images from loopback/LAN (tests do).
      allowPrivateImages: llm.allowPrivateImages === true,
    },
  };
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizePath(p, fallback) {
  if (typeof p !== 'string' || !p.trim()) return fallback;
  let v = p.trim();
  if (!v.startsWith('/')) v = `/${v}`;
  if (v.length > 1) v = v.replace(/\/+$/, '');
  return v;
}
