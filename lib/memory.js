// Long-term, per-sender memory: remember facts the user told the bot, and
// recall them later.
//
// The earlier short-term design kept the whole chat log and replayed it. That
// has two problems for a chat bot: the log is huge (10 turns of chat text), and
// the model tends to echo stale text back. This version instead keeps:
//
//  1. A durable fact list per sender, extracted from what the user actually
//     said ("我叫小明", "我喜欢咖啡", "明天别忘了提醒我开会"). Written to disk
//     so it survives a plugin reload.
//  2. A small "recent replies" ring, used only by the de-duplication guard so
//     the bot doesn't repeat itself.
//
// A sender is keyed by who they are plus where they spoke, so something told in
// private is never recalled in a group.

import fs from 'node:fs';
import path from 'node:path';

const MAX_TRACKED_SENDERS = 500;
const DEFAULT_MAX_FACTS = 60;
const DEFAULT_MAX_CHARS = 120;
const DEFAULT_MAX_REPLIES = 30;
const DEFAULT_MAX_HISTORY = 12;
const DEFAULT_HISTORY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_HISTORY_CHARS = 300;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_AUTOSAVE_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const IMAGE_MARKER = '[图片]';

/**
 * Identify who is speaking and where. Private and group memories are separate
 * by design: a fact shared in private must not surface in a group reply.
 */
export function conversationKey(event) {
  if (!event || typeof event !== 'object') return null;
  const user = event.user_id != null ? String(event.user_id) : '';
  if (!user) return null;
  const scope = event.message_type === 'group' && event.group_id != null
    ? `group:${event.group_id}`
    : 'private';
  return `${scope}:${user}`;
}

export class ConversationMemory {
  /**
   * @param {{enabled?:boolean, maxFacts?:number, maxFactChars?:number,
   *   maxReplies?:number, maxHistory?:number, historyTtlMs?:number,
   *   historyTtlMinutes?:number, maxHistoryChars?:number,
   *   ttlMs?:number, ttlDays?:number, file?:string,
   *   autoSaveMs?:number}} [opts]
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.maxFacts = toInt(opts.maxFacts, DEFAULT_MAX_FACTS, 1, 500);
    this.maxFactChars = toInt(opts.maxFactChars, DEFAULT_MAX_CHARS, 20, 2000);
    this.maxReplies = toInt(opts.maxReplies, DEFAULT_MAX_REPLIES, 0, 200);
    // Short-term conversation window: what was actually said in the last few
    // turns. Distinct from long-term facts — this is "刚才聊了什么".
    this.maxHistory = toInt(opts.maxHistory, DEFAULT_MAX_HISTORY, 0, 100);
    this.maxHistoryChars = toInt(opts.maxHistoryChars, DEFAULT_MAX_HISTORY_CHARS, 20, 4000);
    this.historyTtlMs = Number.isFinite(Number(opts.historyTtlMs))
      ? toInt(opts.historyTtlMs, DEFAULT_HISTORY_TTL_MS, 1000, 7 * DAY_MS)
      : toInt(opts.historyTtlMinutes, 30, 1, 7 * 24 * 60) * MINUTE_MS;
    // ttlDays is the user-facing knob (cordis.patch.yml); ttlMs overrides it.
    this.ttlMs = Number.isFinite(Number(opts.ttlMs))
      ? toInt(opts.ttlMs, DEFAULT_TTL_MS, 1000, 365 * DAY_MS)
      : toInt(opts.ttlDays, 30, 1, 365) * DAY_MS;
    this.file = typeof opts.file === 'string' && opts.file.trim() ? opts.file.trim() : '';
    this.autoSaveMs = toInt(opts.autoSaveMs, DEFAULT_AUTOSAVE_MS, 1000, 600000);
    // Map<key, { facts: Array<{text, at}>, replies: string[], at: number }>
    this.conversations = new Map();
    this.dirty = false;
    this._saveTimer = null;
    this._saving = null;
    this.lastError = '';
  }

  // ---------------------------------------------------------------- lifecycle

  /** Load the persisted fact file (best effort; a broken file is ignored). */
  async load() {
    if (!this.enabled || !this.file) return false;
    try {
      const text = await fs.promises.readFile(this.file, 'utf8');
      const data = JSON.parse(text);
      const rows = Array.isArray(data?.conversations) ? data.conversations : [];
      let loaded = 0;
      for (const row of rows) {
        if (!row || typeof row.key !== 'string') continue;
        this.conversations.set(row.key, {
          facts: Array.isArray(row.facts) ? row.facts.filter(isFact) : [],
          replies: Array.isArray(row.replies) ? row.replies.filter((r) => typeof r === 'string') : [],
          history: Array.isArray(row.history) ? row.history.filter(isTurn) : [],
          at: Number.isFinite(row.at) ? row.at : Date.now(),
        });
        loaded += 1;
      }
      this.lastError = '';
      return loaded > 0;
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.lastError = err.message;
      return false;
    }
  }

  /** Persist synchronously (used when the plugin is being disposed). */
  saveSync() {
    if (!this.enabled || !this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = { version: 1, savedAt: Date.now(), conversations: this._serialize() };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.lastError = '';
      return true;
    } catch (err) {
      this.lastError = err?.message || String(err);
      return false;
    }
  }

  /** Persist asynchronously; coalesced by autoSaveMs. */
  save() {
    // Nothing configured to persist to: treat as a successful no-op so the
    // panel doesn't report a failure when there is simply no file set.
    if (!this.file) return Promise.resolve(true);
    if (!this.enabled) return Promise.resolve(false);
    if (this._saving) return this._saving;
    this._saving = (async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        const payload = { version: 1, savedAt: Date.now(), conversations: this._serialize() };
        const tmp = `${this.file}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(payload), 'utf8');
        await fs.promises.rename(tmp, this.file);
        this.dirty = false;
        this.lastError = '';
        return true;
      } catch (err) {
        this.lastError = err?.message || String(err);
        return false;
      } finally {
        this._saving = null;
      }
    })();
    return this._saving;
  }

  /** Mark dirty and schedule a coalesced flush. */
  touch() {
    this.dirty = true;
    if (!this.file || !this.enabled) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch(() => {});
    }, this.autoSaveMs);
    // Never hold the process open just for a save.
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  /** Cancel the pending flush and do a final synchronous write. */
  dispose() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this.dirty) this.saveSync();
  }

  _serialize() {
    const out = [];
    for (const [key, convo] of this.conversations) {
      out.push({
        key,
        facts: convo.facts,
        replies: convo.replies.slice(0, this.maxReplies),
        history: convo.history.slice(0, this.maxHistory),
        at: convo.at,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ pruning

  /** Drop entries nobody has touched recently, then bound the map size. */
  prune(now = Date.now()) {
    let removed = 0;
    for (const [key, convo] of this.conversations) {
      if (now - convo.at > this.ttlMs) {
        this.conversations.delete(key);
        removed += 1;
      }
    }
    while (this.conversations.size > MAX_TRACKED_SENDERS) {
      const oldest = this.conversations.keys().next();
      if (oldest.done) break;
      this.conversations.delete(oldest.value);
      removed += 1;
    }
    if (removed > 0) this.touch();
    return removed;
  }

  _touch(key, now = Date.now()) {
    let convo = this.conversations.get(key);
    if (!convo) {
      this.prune(now);
      convo = { facts: [], replies: [], history: [], at: now };
      this.conversations.set(key, convo);
    } else {
      // A long silence starts a new topic: drop the short-term window so an
      // old conversation can't bleed into a fresh one. Long-term facts stay.
      if (now - convo.at > this.historyTtlMs && convo.history.length > 0) convo.history = [];
      this.conversations.delete(key);
      this.conversations.set(key, convo);
      convo.at = now;
    }
    return convo;
  }

  // -------------------------------------------------------------------- facts

  /**
   * Remember a fact. Duplicate and contradictory facts are handled here:
   * a new statement about the same subject replaces the old one.
   * @returns {boolean} true when stored
   */
  remember(key, text, opts = {}) {
    if (!this.enabled || !key) return false;
    const value = normalizeFact(String(text == null ? '' : text));
    if (!value) return false;
    const convo = this._touch(key, opts.now);
    const subject = subjectOf(value);
    const existing = convo.facts.findIndex((f) => subject && subjectOf(f.text) === subject);
    if (existing >= 0) {
      if (convo.facts[existing].text === value) return false;
      convo.facts.splice(existing, 1);
    }
    convo.facts.push({ text: value, at: opts.now ?? Date.now() });
    while (convo.facts.length > this.maxFacts) convo.facts.shift();
    this.touch();
    return true;
  }

  /** Remember several facts at once. @returns {number} how many were stored */
  rememberAll(key, texts, opts = {}) {
    let n = 0;
    for (const text of texts || []) if (this.remember(key, text, opts)) n += 1;
    return n;
  }

  /** Forget one fact (substring match) for one sender. */
  forget(key, needle, opts = {}) {
    if (!key) return 0;
    const convo = this.conversations.get(key);
    if (!convo) return 0;
    const target = normalizeFact(String(needle || ''));
    const before = convo.facts.length;
    convo.facts = convo.facts.filter((f) => !f.text.includes(target));
    const removed = before - convo.facts.length;
    if (removed > 0) this.touch();
    return removed;
  }

  /** @returns {string[]} remembered facts, oldest first */
  facts(key, opts = {}) {
    if (!this.enabled || !key) return [];
    const convo = this.conversations.get(key);
    if (!convo) return [];
    if (opts.now && opts.now - convo.at > this.ttlMs) return [];
    return convo.facts.map((f) => f.text);
  }

  // ------------------------------------------------------------------ replies

  /** Record a reply we produced, for the repetition guard. */
  addReply(key, text, opts = {}) {
    if (!this.enabled || !key || this.maxReplies <= 0) return;
    const value = String(text == null ? '' : text).trim();
    if (!value) return;
    const convo = this._touch(key, opts.now);
    convo.replies.push(value);
    while (convo.replies.length > this.maxReplies) convo.replies.shift();
  }

  /**
   * How many of the last `window` replies are near-identical to `text`?
   * Used to stop the model from parroting itself.
   */
  repetition(key, text, window = 6) {
    const convo = this.conversations.get(key);
    if (!convo) return 0;
    const value = String(text == null ? '' : text).trim();
    if (!value) return 0;
    const recent = convo.replies.slice(-window);
    return recent.filter((r) => similarity(r, value) >= 0.72).length;
  }

  /** The last reply we sent in this conversation (for "再说一遍" style asks). */
  lastReply(key) {
    const convo = this.conversations.get(key);
    if (!convo || convo.replies.length === 0) return '';
    return convo.replies[convo.replies.length - 1];
  }

  // ----------------------------------------------------------------- history

  /**
   * Record one completed exchange (what the user said, what we answered).
   * Only the short-term window is stored; it expires by silence and is not
   * treated as durable knowledge.
   * @param {string} key
   * @param {string} userText
   * @param {string} botText
   */
  addTurn(key, userText, botText, opts = {}) {
    if (!this.enabled || !key || this.maxHistory <= 0) return false;
    const user = clip(String(userText == null ? '' : userText).trim(), this.maxHistoryChars);
    const bot = clip(String(botText == null ? '' : botText).trim(), this.maxHistoryChars);
    if (!user && !bot) return false;
    const convo = this._touch(key, opts.now);
    convo.history.push({
      user: user || IMAGE_MARKER,
      bot,
      at: opts.now ?? Date.now(),
    });
    while (convo.history.length > this.maxHistory) convo.history.shift();
    this.touch();
    return true;
  }

  /**
   * The recent exchange window, oldest first, for prompt injection.
   * Expired entries are dropped here too, so a stale window never reaches
   * the model even if nothing else touched this key.
   * @returns {Array<{user:string, bot:string, at:number}>}
   */
  history(key, opts = {}) {
    if (!this.enabled || !key || this.maxHistory <= 0) return [];
    const convo = this.conversations.get(key);
    if (!convo || convo.history.length === 0) return [];
    const now = opts.now ?? Date.now();
    if (now - convo.at > this.historyTtlMs) {
      convo.history = [];
      return [];
    }
    return convo.history.map((t) => ({ user: t.user, bot: t.bot, at: t.at }));
  }

  /** Start a fresh topic for one conversation (facts are kept). */
  clearHistory(key) {
    if (!key) return false;
    const convo = this.conversations.get(key);
    if (!convo || convo.history.length === 0) return false;
    convo.history = [];
    this.touch();
    return true;
  }

  // -------------------------------------------------------------------- admin

  clear(key) {
    if (!key) return false;
    const existed = this.conversations.delete(key);
    if (existed) this.touch();
    return existed;
  }

  /** Forget every fact in every conversation, but keep the memory enabled. */
  resetAll() {
    const keys = [...this.conversations.keys()];
    for (const convo of this.conversations.values()) {
      convo.facts = [];
      convo.replies = [];
      convo.history = [];
    }
    this.touch();
    if (this.file) this.save().catch(() => {});
    return keys.length;
  }

  clearAll() {
    const n = this.conversations.size;
    this.conversations.clear();
    this.touch();
    return n;
  }

  /** @returns {boolean} true when this sender has nothing remembered yet */
  hasMemory(key) {
    const convo = this.conversations.get(key);
    return Boolean(convo && convo.facts.length > 0);
  }

  /** Summary for the panel. */
  stats() {
    let facts = 0;
    let replies = 0;
    let turns = 0;
    for (const convo of this.conversations.values()) {
      facts += convo.facts.length;
      replies += convo.replies.length;
      turns += convo.history.length;
    }
    return {
      enabled: this.enabled,
      senders: this.conversations.size,
      facts,
      replies,
      turns,
      maxFacts: this.maxFacts,
      maxFactChars: this.maxFactChars,
      maxReplies: this.maxReplies,
      maxHistory: this.maxHistory,
      historyTtlMs: this.historyTtlMs,
      ttlMs: this.ttlMs,
      file: this.file || null,
      dirty: this.dirty,
      lastError: this.lastError,
    };
  }

  /** Recent senders for the panel (most recently used first). */
  list(limit = 20) {
    const out = [];
    for (const [key, convo] of [...this.conversations.entries()].reverse()) {
      out.push({
        key,
        facts: convo.facts.length,
        turns: convo.history.length,
        at: convo.at,
        preview: convo.facts.length > 0 ? clip(convo.facts[convo.facts.length - 1].text, 80) : '',
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

function isFact(f) {
  return Boolean(f) && typeof f.text === 'string' && f.text.length > 0;
}

function isTurn(t) {
  return Boolean(t) && typeof t === 'object' && typeof t.user === 'string';
}

/** Trim a fact to the configured length, keeping it a single line. */
function normalizeFact(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * The "subject" of a fact — the word right after 我叫/我是/我喜欢 (or the first
 * few characters as a fallback). Two facts with the same subject are treated as
 * the same slot, so a newer statement replaces the older one.
 */
function subjectOf(text) {
  const groups = [
    ['我叫', 2], ['我的名字是', 5], ['我是', 2], ['我姓', 2],
    ['我喜欢', 3], ['我爱', 2], ['我讨厌', 3], ['我不喜欢', 4],
    ['我在', 2], ['我住在', 3], ['我的', 2],
    ['记住', 2], ['请记住', 3], ['别忘了', 3], ['记得', 2],
    ['我是做', 3], ['我负责', 3], ['我的工作', 4],
  ];
  for (const [prefix, len] of groups) {
    if (text.startsWith(prefix)) return prefix;
  }
  return '';
}

/**
 * Cheap similarity in [0,1] between two short strings: bigram Dice
 * coefficient, plus an exact/prefix fast path.
 */
export function similarity(a, b) {
  const x = String(a || '').replace(/\s+/g, '');
  const y = String(b || '').replace(/\s+/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const gx = bigrams(x);
  const gy = bigrams(y);
  if (gx.length === 0 || gy.length === 0) return 0;
  const counts = new Map();
  for (const g of gx) counts.set(g, (counts.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of gy) {
    const n = counts.get(g) || 0;
    if (n > 0) {
      counts.set(g, n - 1);
      overlap += 1;
    }
  }
  return (2 * overlap) / (gx.length + gy.length);
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export { IMAGE_MARKER as IMAGE_PLACEHOLDER };
