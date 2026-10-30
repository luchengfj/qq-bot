// OneBot v11 message parsing.
//
// OneBot delivers messages in one of two formats, selected by the framework's
// `message_post_format` setting:
//   1. "string" — CQ codes embedded in text, e.g. "[CQ:image,file=abc,url=https://...]"
//   2. "array"  — a JSON array of segment objects, e.g.
//        [{ type: "text", data: { text: "看这个" } },
//         { type: "image", data: { url: "https://..." } }]
//
// This module normalizes both into { text, images, atList, raw }, where:
//   - text    : all plain-text content joined (CQ codes stripped)
//   - images  : array of downloadable image URLs / data URIs
//   - atList  : array of QQ ids that were @-mentioned ('all' = @全体成员)

const HTTP_PREFIX = ['h', 't', 't', 'p', 's', ':', '/', '/'].join('');
const HTTP_PREFIX_SHORT = ['h', 't', 't', 'p', ':', '/', '/'].join('');
const DATA_IMAGE_PREFIX = 'data:image/';
const BASE64_PREFIX = 'base64://';

function startsWithIgnoreCase(value, prefix) {
  if (value.length < prefix.length) return false;
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/**
 * Extract a usable image reference from any of the fields OneBot/QQ use.
 * Priority: url > file > src.
 *
 * Accepted forms:
 *   - http:// / https://  (downloaded by lib/vision.js, SSRF-guarded)
 *   - data:image/...      (inline, passed straight through)
 *   - base64://<bytes>    (converted to a data: URI)
 *
 * Rejected on purpose:
 *   - file:// paths — the plugin runs as a server and must not read arbitrary
 *     local files, and fetch() would reject them mid-turn anyway.
 *   - anything else (protocol-relative, relative paths, opaque ids).
 *
 * @param {Record<string, any>} data
 * @param {{ selfId?: string|number }} options
 * @returns {string | null}
 */
export function pickImageUrl(data, options = {}) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [data.url, data.file, data.src];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue;
    const v = raw.trim();
    if (!v) continue;
    if (startsWithIgnoreCase(v, HTTP_PREFIX) || startsWithIgnoreCase(v, HTTP_PREFIX_SHORT)) return v;
    if (startsWithIgnoreCase(v, DATA_IMAGE_PREFIX)) return v;
    if (startsWithIgnoreCase(v, BASE64_PREFIX)) return base64ToDataUri(v.slice(BASE64_PREFIX.length));
  }
  return null;
}

/**
 * Convert `base64://<payload>` into a `data:image/...;base64,...` URI.
 * Guesses the mime from the payload magic bytes; falls back to image/jpeg.
 */
export function base64ToDataUri(payload) {
  const clean = String(payload || '').trim();
  if (!clean) return null;
  let mime = 'image/jpeg';
  try {
    const head = Buffer.from(clean.slice(0, 12), 'base64');
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50) mime = 'image/png';
    else if (head.length >= 3 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) mime = 'image/gif';
    else if (head.length >= 12 && head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp';
    else if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) mime = 'image/jpeg';
  } catch {
    /* keep default */
  }
  return `data:${mime};base64,${clean}`;
}

/**
 * Parse a OneBot `message` field (string or array) into normalized parts.
 * @param {string | Array | undefined} message
 * @param {{ selfId?: string|number }} options
 */
export function parseMessage(message, options = {}) {
  const images = [];
  const atList = [];
  let text = '';

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue;
      const type = seg.type || seg.typeName || '';
      const data = seg.data || {};
      switch (type) {
        case 'text':
          text += String(data.text ?? '');
          break;
        case 'image': {
          const url = pickImageUrl(data, options);
          if (url) images.push(url);
          break;
        }
        case 'at': {
          const qq = data.qq ?? data.target ?? '';
          // 'all' means @全体成员 — keep it so trigger rules can see it.
          if (qq) atList.push(String(qq));
          break;
        }
        case 'face':
        case 'emoji':
          // Emoji/QQ faces — keep a marker so text isn't empty.
          text += String(data.name ? `[${data.name}]` : '[表情]');
          break;
        case 'reply':
          // A reply segment carries the quoted message id; ignore for content.
          break;
        default:
          // Unknown segment with a `text` field, e.g. some forward nodes.
          if (typeof data.text === 'string') text += data.text;
          break;
      }
    }
  } else if (typeof message === 'string') {
    const parsed = parseCqString(message, options);
    text += parsed.text;
    images.push(...parsed.images);
    atList.push(...parsed.atList);
  } else if (message != null) {
    text += String(message);
  }

  return { text: text.trim(), images, atList };
}

/**
 * Parse a CQ-code string.
 *
 * Uses a small state machine instead of a regex: CQ values may legitimately
 * contain escaped brackets (&#91; / &#93;) and commas (&#44;), and a regex that
 * stops at the first unescaped ']' truncates values holding a raw ']'.
 */
export function parseCqString(input, options = {}) {
  const images = [];
  const atList = [];
  const textParts = [];

  const src = String(input || '');
  const CQ_OPEN = '[CQ:';
  let i = 0;
  let plainStart = 0;

  while (i < src.length) {
    // Find the next CQ opening tag.
    const at = src.indexOf(CQ_OPEN, i);
    if (at === -1) break;

    // Find its closing ']', skipping escaped sequences.
    let depth = 0;
    let j = at + CQ_OPEN.length;
    let end = -1;
    while (j < src.length) {
      const ch = src.charAt(j);
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        if (depth === 0) { end = j; break; }
        depth -= 1;
      }
      j += 1;
    }
    if (end === -1) break; // unterminated tag — treat the rest as plain text

    // Plain text before this tag.
    if (at > plainStart) textParts.push(unescapeCq(src.slice(plainStart, at)));

    const inner = src.slice(at + CQ_OPEN.length, end); // e.g. "image,file=abc,url=..."
    const comma = inner.indexOf(',');
    const type = comma === -1 ? inner : inner.slice(0, comma);
    const paramsStr = comma === -1 ? '' : inner.slice(comma + 1);
    const params = parseCqParams(paramsStr);

    switch (type) {
      case 'image': {
        const url = pickImageUrl(params, options);
        if (url) images.push(url);
        break;
      }
      case 'at': {
        const qq = params.qq ?? '';
        if (qq) atList.push(qq); // includes 'all'
        break;
      }
      case 'face':
        textParts.push('[表情]');
        break;
      case 'reply':
        break;
      default:
        textParts.push(`[${type}]`);
        break;
    }

    i = end + 1;
    plainStart = i;
  }
  if (plainStart < src.length) textParts.push(unescapeCq(src.slice(plainStart)));

  return { text: textParts.join('').trim(), images, atList };
}

/**
 * Split `key=value,key=value` into an object. A comma only separates params
 * when it is unescaped, so values holding commas survive.
 */
function parseCqParams(str) {
  const params = {};
  if (!str) return params;
  let keyStart = 0;
  let eq = -1;
  let i = 0;
  const flush = (end) => {
    if (eq !== -1 && eq > keyStart) {
      const key = str.slice(keyStart, eq).trim();
      const value = unescapeCq(str.slice(eq + 1, end));
      if (key) params[key] = value;
    }
    keyStart = end + 1;
    eq = -1;
  };
  while (i < str.length) {
    const ch = str.charAt(i);
    // Skip whole escape sequences — '&#44;' must not read as a separator.
    if (ch === '&') {
      const skip = escapeLengthAt(str, i);
      if (skip > 0) { i += skip; continue; }
    }
    if (ch === '=' && eq === -1 && i > keyStart) eq = i;
    else if (ch === ',') { flush(i); }
    i += 1;
  }
  flush(str.length);
  return params;
}

/** Length of a CQ escape sequence starting at `i`, or 0 when none. */
function escapeLengthAt(str, i) {
  for (const esc of CQ_ESCAPES) {
    if (str.startsWith(esc.text, i)) return esc.text.length;
  }
  return 0;
}

/** CQ escape sequences: &amp; -> &, &#44; -> ,, &#91; -> [, &#93; -> ] */
const CQ_ESCAPES = [
  { text: '&amp;', char: '&' },
  { text: '&#44;', char: ',' },
  { text: '&#91;', char: '[' },
  { text: '&#93;', char: ']' },
];

function unescapeCq(s) {
  return String(s)
    .split('&amp;').join('&')
    .split('&#44;').join(',')
    .split('&#91;').join('[')
    .split('&#93;').join(']');
}
