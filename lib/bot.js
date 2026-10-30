// Bot logic: decide which OneBot events to answer, call the vision backend,
// and reply. Kept separate from transport so it is easy to test/extend.

import { parseMessage } from './message.js';
import { askVision } from './vision.js';
import { ConversationMemory, conversationKey, IMAGE_MARKER } from './memory.js';
import { cleanReply, extractFacts, matchMemoryCommand, matchCommand, helpText, splitReply } from './reply.js';

const DEFAULT_PREFIX = '';
const MAX_TRACKED_IDS = 2000;
const NL = String.fromCharCode(10);

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
    // Long-term, per-sender facts (persisted to disk when configured).
    this.memory = new ConversationMemory(cfg.memory || {});
  }

  /** Load persisted memory. Safe to call even when memory is disabled. */
  async loadMemory() {
    if (!this.memory.enabled) return false;
    const ok = await this.memory.load();
    if (ok) this.log('已加载长期记忆');
    return ok;
  }

  /** Flush memory to disk (called on unload). */
  dispose() {
    this.memory.dispose();
  }

  /**
   * Handle the built-in memory controls ("忘记我", "我的记忆").
   * @returns {Promise<string|null>} a direct answer, or null when not a command
   */
  async _handleMemoryCommand(event, key, text) {
    const command = matchMemoryCommand(text);
    if (!command || !key) return null;
    if (command === 'clear') {
      const had = this.memory.hasMemory(key);
      this.memory.clear(key);
      this.log(`记忆：已清除 ${key}`);
      return had ? '好的，我已经忘记关于你的一切了。' : '我本来就没有记住关于你的信息。';
    }
    const facts = this.memory.facts(key);
    if (facts.length === 0) return '我还没有记住关于你的信息。你可以告诉我，比如"我叫小明"。';
    const lines = facts.map((f, i) => `${i + 1}. ${f}`);
    return ['我记得关于你的这些：', ...lines, '（发送"忘记我"可以清除）'].join(NL);
  }

  /**
   * Handle slash commands (/help, /status, /new, /forget, /memory).
   * @returns {Promise<string|null>} a direct answer, or null when not a command
   */
  async _handleCommand(event, key, text) {
    const cmd = matchCommand(text);
    if (!cmd) return null;
    const isGroup = event.message_type === 'group';

    if (cmd.id === 'help') return helpText();

    if (cmd.id === 'memory') {
      if (!key) return null;
      return this._handleMemoryCommand(event, key, '我的记忆');
    }

    if (cmd.id === 'forget') {
      if (!key) return null;
      return this._handleMemoryCommand(event, key, '忘记我');
    }

    if (cmd.id === 'new') {
      if (!key) return '好的，我们换个话题。';
      const dropped = this.memory.clearHistory(key);
      this.log(dropped ? `上下文：已重置 ${key}` : `上下文：本就没有进行中的话题 (${key})`);
      return dropped
        ? '好的，我们换个话题。刚才聊的内容我已经放下了，关于你的长期记忆仍然保留。'
        : '我们本来就没有进行中的话题，直接说吧。';
    }

    if (cmd.id === 'status') {
      const s = this.memory.stats();
      const lines = [
        `机器人运行中。模型：${this.cfg.llm?.model || '未配置'}`,
        `长期记忆：${s.enabled ? `开启，${s.senders} 个会话、${s.facts} 条信息` : '关闭'}`,
        `对话上下文：${s.maxHistory > 0 ? `最近 ${s.maxHistory} 轮，静默 ${Math.round(s.historyTtlMs / 60000)} 分钟后重置` : '关闭'}`,
      ];
      const facts = key ? this.memory.facts(key) : [];
      if (facts.length > 0) lines.push(`我记得关于你的 ${facts.length} 条信息，发送 /memory 查看。`);
      return lines.join(NL);
    }

    return null;
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
      // Missing group_id is denied when a whitelist is active (a malformed
      // event must not bypass the whitelist).
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

    const key = conversationKey(event);

    // Slash commands first, then the plain-Chinese memory controls. Both are
    // answered locally — no model call needed.
    const commandReply =
      (await this._handleCommand(event, key, text)) ||
      (await this._handleMemoryCommand(event, key, text));
    if (commandReply) {
      const sentCmd = await this._safeReply(replyFn, commandReply, event.message_type === 'group');
      return sentCmd.ok
        ? { ok: true, text: commandReply, memory: true }
        : { ok: false, error: sentCmd.error };
    }

    // Remember durable facts the user just told us (before building the
    // prompt, so they are part of the context on this very turn too).
    const learned = this.memory.enabled ? this.memory.rememberAll(key, extractFacts(text)) : 0;
    if (learned > 0) this.log(`记忆：新增 ${learned} 条 (${key})`);

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
      .join(NL);

    this.log(`收到消息: ${where}, 图片 ${parsed.images.length} 张, 文本 "${text.slice(0, 60)}"`);

    const llmCfg = this.cfg.llm || {};
    const facts = this.memory.enabled ? this.memory.facts(key) : [];
    if (facts.length > 0) this.log(`记忆：注入 ${facts.length} 条已知信息`);

    // Short-term window: what was actually said in the last few turns. This
    // is what makes "那它呢？" answerable; it expires on silence.
    const turns = this.memory.enabled ? this.memory.history(key) : [];
    if (turns.length > 0) this.log(`上下文：注入最近 ${turns.length} 轮对话`);

    // Ask for a fresh angle when the model is about to repeat itself.
    const repeating = this.memory.enabled ? this.memory.repetition(key, text) : 0;
    const extraSystem = repeating > 0
      ? '注意：你刚才已经给过类似的回答。请换一个角度、补充新的信息，或用更简洁的方式回答，不要重复。'
      : '';

    let answer;
    try {
      answer = await askVision(
        { ...llmCfg, maxImageBytes: llmCfg.maxImageBytes ?? this.cfg.maxImageBytes },
        { text: promptText, images: parsed.images, memory: facts, history: turns, extraSystem },
      );
    } catch (err) {
      this.log(`视觉接口调用失败: ${err.message}`);
      const friendly = err.message.includes('未配置')
        ? err.message
        : `抱歉，处理失败：${err.message}`;
      await this._safeReply(replyFn, friendly, false);
      return { ok: false, error: friendly };
    }

    // Cap the *total* length (per-message limit × allowed segments) so a
    // runaway model answer can't flood the chat; _sendReply then splits it.
    const perMessage = Number(llmCfg.maxReplyChars) > 0 ? Number(llmCfg.maxReplyChars) : 0;
    const maxParts = Number(llmCfg.maxReplyParts) > 0 ? Number(llmCfg.maxReplyParts) : 1;
    answer = cleanReply(answer, { maxChars: perMessage > 0 ? perMessage * maxParts : 0 });
    if (!answer) {
      const fallback = '抱歉，我没有想好怎么回答，可以再说具体一点吗？';
      const sentFallback = await this._safeReply(replyFn, fallback, event.message_type === 'group');
      return sentFallback.ok
        ? { ok: true, text: fallback }
        : { ok: false, error: sentFallback.error };
    }
    // Remember our own reply so the repetition guard can see it next turn,
    // and record the exchange so the next turn has real context.
    this.memory.addReply(key, answer);
    this.memory.addTurn(key, text || IMAGE_MARKER, answer);

    const atSender = event.message_type === 'group';
    const sent = await this._sendReply(replyFn, answer, atSender);
    if (!sent.ok) return { ok: false, error: sent.error, text: answer };
    return { ok: true, text: answer, learned, parts: sent.parts };
  }

  async _safeReply(replyFn, text, atSender) {
    if (typeof replyFn !== 'function') {
      this.log('没有可用的回复函数（可能未连接 OneBot 客户端）');
      return { ok: false, error: 'no reply function' };
    }
    try {
      await replyFn(text, { atSender });
      return { ok: true, parts: 1 };
    } catch (err) {
      this.log(`回复发送失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Send a reply, splitting it into several messages when it is longer than
   * the per-message limit. Only the first part @-mentions the sender, and
   * multi-part replies are numbered so the order is obvious in a busy chat.
   */
  async _sendReply(replyFn, text, atSender) {
    const maxChars = Number(this.cfg.llm?.maxReplyChars) > 0 ? Number(this.cfg.llm.maxReplyChars) : 0;
    const parts = splitReply(text, maxChars, { maxParts: this.cfg.llm?.maxReplyParts ?? 5 });
    if (parts.length === 0) return { ok: true, parts: 0 };
    if (parts.length === 1) return this._safeReply(replyFn, parts[0], atSender);

    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const label = `(${i + 1}/${parts.length}) `;
      // @-mention only on the first message to avoid spamming the sender.
      const sent = await this._safeReply(replyFn, label + parts[i], atSender && i === 0);
      if (!sent.ok) return { ok: false, error: sent.error, parts: i };
      out.push(parts[i]);
    }
    this.log(`回复较长，已分 ${parts.length} 条发送`);
    return { ok: true, parts: out.length };
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
  const mem = { ...(raw.memory || {}) };
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
      // 0 = no limit. QQ 单条消息过长会被截断，默认 600 字比较安全。
      maxReplyChars: toInt(llm.maxReplyChars, 0, 0, 8000),
      // How many segments a long answer may be split into (1 = truncate).
      maxReplyParts: toInt(llm.maxReplyParts, 4, 1, 10),
    },
    // Long-term memory (per sender, persisted to disk when `file` is set).
    memory: {
      enabled: mem.enabled !== false,
      maxFacts: toInt(mem.maxFacts, 60, 1, 500),
      maxFactChars: toInt(mem.maxFactChars, 120, 20, 2000),
      maxReplies: toInt(mem.maxReplies, 30, 0, 200),
      // Short-term conversation window ("刚才聊了什么").
      maxHistory: toInt(mem.maxHistory, 12, 0, 100),
      maxHistoryChars: toInt(mem.maxHistoryChars, 300, 20, 4000),
      historyTtlMinutes: toInt(mem.historyTtlMinutes, 30, 1, 7 * 24 * 60),
      ttlDays: toInt(mem.ttlDays, 30, 1, 365),
      file: typeof mem.file === 'string' ? mem.file.trim() : '',
      autoSaveMs: toInt(mem.autoSaveMs, 15000, 1000, 600000),
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
