// Reply shaping: turn whatever the model produced into something that reads
// well inside a QQ chat, and pull durable facts out of what the user said.
//
// Everything here is deterministic and offline — no extra model call, no npm
// dependency — so it can be unit-tested and cannot add latency or cost.

const NL = String.fromCharCode(10);

/** Prefixes models love to open with but nobody wants to read in a chat. */
const PREAMBLES = [
  '作为一个人工智能助手',
  '作为一名人工智能助手',
  '作为一个语言模型',
  '作为一个大型语言模型',
  '作为人工智能助手',
  '作为AI助手',
  '作为ai助手',
  '我是一个人工智能助手',
  '我是一个AI助手',
  '我是一个ai助手',
  '我是一个语言模型',
  '作为助手',
  '好的，',
  '好的！',
  '当然，',
  '当然！',
  '没问题，',
  '很高兴为您解答',
  '很高兴为你解答',
];

const SENTENCE_ENDS = ['。', '！', '？', '；', '…', '.', '!', '?', '\n'];

/**
 * Remove a canned opening ("作为一个人工智能助手，…") so the answer starts
 * with the actual content.
 */
export function stripPreamble(text) {
  let out = String(text == null ? '' : text).trim();
  if (!out) return '';
  for (const pre of PREAMBLES) {
    if (!out.startsWith(pre)) continue;
    const rest = out.slice(pre.length);
    if (rest.length === 0) return '';
    const head = rest.slice(0, 2);
    const hasSep =
      head.indexOf('，') >= 0 ||
      head.indexOf(',') >= 0 ||
      head.indexOf('。') >= 0 ||
      head.indexOf('：') >= 0;
    if (hasSep) {
      const trimmed = rest.replace(/^[\s，,。：:、！!]+/, '');
      if (trimmed.length > 0) return trimmed;
    }
  }
  return out;
}

/** Collapse runs of blank lines and trim trailing space on each line. */
export function collapseBlankLines(text) {
  const lines = String(text == null ? '' : text)
    .split(NL)
    .map((l) => l.replace(/\s+$/, ''));
  const out = [];
  let blank = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (blank) continue;
      blank = true;
      out.push('');
      continue;
    }
    blank = false;
    out.push(line);
  }
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out.join(NL);
}

/**
 * Cut a reply down to `maxChars`, preferring a sentence boundary and then a
 * word boundary, so we never send a wall of text into a chat.
 */
export function truncateReply(text, maxChars) {
  const limit = Number(maxChars);
  const s = String(text == null ? '' : text);
  if (!Number.isFinite(limit) || limit <= 0 || s.length <= limit) return s;
  const window = s.slice(0, limit);
  let cut = -1;
  for (const end of SENTENCE_ENDS) {
    const idx = window.lastIndexOf(end);
    if (idx > cut) cut = idx;
  }
  // Keep a reasonable chunk: don't cut after just two characters.
  if (cut >= Math.floor(limit * 0.5)) return window.slice(0, cut + 1).trimEnd();
  const space = window.lastIndexOf(' ');
  if (space >= Math.floor(limit * 0.6)) return `${window.slice(0, space).trimEnd()}…`;
  return `${window.trimEnd()}…`;
}

/** Full cleanup applied to every model answer. */
export function cleanReply(text, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0;
  let out = collapseBlankLines(stripPreamble(text));
  if (maxChars > 0) out = truncateReply(out, maxChars);
  return out.trim();
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

/** Substrings that mark a sentence as something worth remembering. */
const FACT_HINTS = [
  '我叫', '我的名字', '我姓', '我是', '我今年', '我住在', '我在', '我来自',
  '我喜欢', '我爱', '我讨厌', '我不喜欢', '我擅长', '我习惯',
  '我用', '我的', '我有个', '我有一个', '我负责', '我做',
  '叫我', '别叫我', '记住', '请记住', '记得', '别忘了', '别忘',
  '以后', '从此', '从现在', '我希望', '我想要', '我要', '我需要',
];

const SPLITTERS = ['\n', '。', '！', '？', '；', '!', '?', ';', '…'];

/**
 * Pull durable statements out of a user message.
 *
 * Conservative on purpose: we would rather remember nothing than fill the
 * memory with noise, because every remembered line is sent back to the model
 * on later turns.
 *
 * @returns {string[]} facts (already trimmed, single line)
 */
export function extractFacts(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return [];
  const parts = splitSentences(raw);
  const out = [];
  for (const piece of parts) {
    const s = piece.text;
    if (s.length < 3 || s.length > 120) continue;
    // Questions are not facts ("我叫什么？").
    if (piece.end === '？' || piece.end === '?') continue;
    if (!hasHint(s)) continue;
    const fact = normalize(s);
    if (fact) out.push(fact);
  }
  return out;
}

function splitSentences(text) {
  const flat = String(text).replace(/\r/g, '');
  // Walk the string once and cut on any separator, remembering which one
  // ended each piece so question sentences can be dropped later.
  const parts = [];
  let start = 0;
  for (let i = 0; i < flat.length; i += 1) {
    const ch = flat[i];
    if (SPLITTERS.indexOf(ch) < 0) continue;
    parts.push({ text: flat.slice(start, i), end: ch });
    start = i + 1;
  }
  parts.push({ text: flat.slice(start), end: '' });
  return parts.map((p) => ({ text: p.text.trim(), end: p.end })).filter((p) => p.text.length > 0);
}

function hasHint(sentence) {
  for (const hint of FACT_HINTS) {
    if (sentence.indexOf(hint) >= 0) return true;
  }
  return false;
}

function normalize(sentence) {
  return sentence
    .replace(/^[\s，,、。]+/, '')
    .replace(/\s+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Memory commands typed by the user
// ---------------------------------------------------------------------------

const CLEAR_WORDS = [
  '忘记我', '忘掉我', '清除记忆', '清空记忆', '删除记忆', '清除我的信息', '重置记忆', '清空我的记忆',
];
const LIST_WORDS = ['我的记忆', '你记得我什么', '记得我什么', '查看记忆', '记忆列表', '你还记得我吗'];

/**
 * Recognise the built-in memory controls.
 * @returns {'clear'|'list'|null}
 */
export function matchMemoryCommand(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  for (const word of CLEAR_WORDS) {
    if (s.indexOf(word) >= 0) return 'clear';
  }
  for (const word of LIST_WORDS) {
    if (s.indexOf(word) >= 0) return 'list';
  }
  return null;
}

export { NL };
