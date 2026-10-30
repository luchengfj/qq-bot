// Minimal QR Code encoder (byte mode), ISO/IEC 18004.
//
// The plugin needs to render a QQ login QR code in its own setup page without
// pulling in an npm dependency, so this module implements just enough of the
// spec: byte/8-bit mode, error-correction levels L and M, versions 1-10
// (up to ~216 bytes of payload, far more than a login URL needs).
//
// Exports:
//   encode(text, level) -> { version, size, level, get(row, col) }
//   toSvg(qr, opts)     -> string (standalone SVG document)

const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
// (group2 entries are omitted when there is only one group).
const CAPACITY = {
  L: [
    [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108],
    [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43],
    [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
};

// Alignment pattern centre coordinates, indexed by version - 1.
const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// --- GF(256) arithmetic, primitive polynomial 0x11D -------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Systematic Reed-Solomon: returns only the `ecLen` parity bytes. */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(ecLen);
  for (const b of data) {
    const factor = b ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/** 15-bit BCH format information. */
function formatBits(ecLevelBits, mask) {
  let data = (ecLevelBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

/** 18-bit BCH version information (versions >= 7). */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

class QrMatrix {
  constructor(version, level) {
    this.version = version;
    this.level = level;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }

  idx(row, col) { return row * this.size + col; }

  set(row, col, dark, fn = false) {
    const i = this.idx(row, col);
    this.modules[i] = dark ? 1 : 0;
    if (fn) this.isFunction[i] = 1;
  }

  get(row, col) { return this.modules[this.idx(row, col)]; }

  drawFinder(rowCentre, colCentre) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const r = rowCentre + dr;
        const c = colCentre + dc;
        if (r < 0 || r >= this.size || c < 0 || c >= this.size) continue;
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        this.set(r, c, dist !== 2 && dist !== 4, true);
      }
    }
  }

  drawAlignment(rowCentre, colCentre) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        this.set(rowCentre + dr, colCentre + dc, dist !== 1, true);
      }
    }
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0, true);
      this.set(i, 6, i % 2 === 0, true);
    }
    this.drawFinder(3, 3);
    this.drawFinder(3, size - 4);
    this.drawFinder(size - 4, 3);

    const coords = ALIGN[this.version - 1] || [];
    for (const r of coords) {
      for (const c of coords) {
        // Skip the three positions occupied by finder patterns.
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        this.drawAlignment(r, c);
      }
    }

    // Reserve the format-information areas.
    for (let i = 0; i < 9; i++) {
      if (i !== 6) { this.set(8, i, false, true); this.set(i, 8, false, true); }
    }
    for (let i = 0; i < 8; i++) {
      this.set(8, size - 1 - i, false, true);
      this.set(size - 1 - i, 8, false, true);
    }
    if (this.version >= 7) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) {
          this.set(i, size - 11 + j, false, true);
          this.set(size - 11 + j, i, false, true);
        }
      }
    }
  }

  drawFormat(mask) {
    const { size } = this;
    const bits = formatBits(EC_BITS[this.level], mask);
    const bit = (i) => (bits >> i) & 1;
    for (let i = 0; i <= 5; i++) this.set(i, 8, bit(i), true);
    this.set(7, 8, bit(6), true);
    this.set(8, 8, bit(7), true);
    this.set(8, 7, bit(8), true);
    for (let i = 9; i < 15; i++) this.set(8, 14 - i, bit(i), true);

    // Second copy: bits 0-7 run horizontally in row 8 under the top-right
    // finder; bits 8-14 run vertically in column 8 beside the bottom-left one.
    for (let i = 0; i < 8; i++) this.set(8, size - 1 - i, bit(i), true);
    for (let i = 8; i < 15; i++) this.set(size - 15 + i, 8, bit(i), true);
    this.set(size - 8, 8, 1, true); // the always-dark module

    if (this.version >= 7) {
      const vbits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const b = (vbits >> i) & 1;
        const a = size - 11 + (i % 3);
        const d = Math.floor(i / 3);
        this.set(d, a, b, true);
        this.set(a, d, b, true);
      }
    }
  }

  /** Place codeword bits in the zig-zag pattern, skipping function modules. */
  drawCodewords(codewords) {
    let bitIndex = 0;
    const total = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing column is skipped
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? this.size - 1 - vert : vert;
          if (this.isFunction[this.idx(row, col)]) continue;
          let dark = false;
          if (bitIndex < total) {
            dark = ((codewords[bitIndex >>> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
            bitIndex++;
          }
          this.set(row, col, dark);
        }
      }
    }
  }

  applyMask(mask) {
    const fn = MASKS[mask];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        const i = this.idx(r, c);
        if (!this.isFunction[i] && fn(r, c)) this.modules[i] ^= 1;
      }
    }
  }

  /** ISO/IEC 18004 penalty score — lower is better. */
  penalty() {
    const { size, modules } = this;
    let score = 0;
    const runs = (get, n) => {
      let prev = -1;
      let run = 0;
      for (let i = 0; i < n; i++) {
        const v = get(i);
        if (v === prev) run++;
        else { if (run >= 5) score += 3 + (run - 5); prev = v; run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    };
    for (let r = 0; r < size; r++) runs((i) => modules[this.idx(r, i)], size);
    for (let c = 0; c < size; c++) runs((i) => modules[this.idx(i, c)], size);

    // 2x2 blocks of the same colour.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[this.idx(r, c)];
        if (v === modules[this.idx(r, c + 1)] && v === modules[this.idx(r + 1, c)] && v === modules[this.idx(r + 1, c + 1)]) score += 3;
      }
    }

    // 1:1:3:1:1 finder-like sequences.
    const PATTERN = [1, 0, 1, 1, 1, 0, 1];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c <= size - 7; c++) {
        let hit = true;
        for (let k = 0; k < 7; k++) if (modules[this.idx(r, c + k)] !== PATTERN[k]) { hit = false; break; }
        if (hit) score += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r <= size - 7; r++) {
        let hit = true;
        for (let k = 0; k < 7; k++) if (modules[this.idx(r + k, c)] !== PATTERN[k]) { hit = false; break; }
        if (hit) score += 40;
      }
    }

    // Dark-ratio deviation.
    let dark = 0;
    for (let i = 0; i < modules.length; i++) dark += modules[i];
    const ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  clone() {
    const m = new QrMatrix(this.version, this.level);
    m.modules.set(this.modules);
    m.isFunction.set(this.isFunction);
    return m;
  }
}

/**
 * Encode a UTF-8 string into a QR code.
 * @param {string} text
 * @param {'L'|'M'} level
 * @returns {{version:number,size:number,level:string,mask:number,modules:Uint8Array,get:(r:number,c:number)=>number}}
 */
export function encode(text, level = 'M') {
  if (level !== 'L' && level !== 'M') throw new Error(`不支持的纠错等级: ${level}`);
  const bytes = Buffer.from(String(text), 'utf8');
  const table = CAPACITY[level];

  let version = 0;
  let spec = null;
  for (let v = 1; v <= table.length; v++) {
    const s = table[v - 1];
    const dataCodewords = s[2] * s[1] + (s[4] ? s[4] * s[3] : 0);
    const countBits = v < 10 ? 8 : 16;
    const needed = 4 + countBits + bytes.length * 8;
    if (needed <= dataCodewords * 8) { version = v; spec = s; break; }
  }
  if (!version) throw new Error('内容过长，超出 QR 版本 10 的容量');

  const dataCodewords = spec[2] * spec[1] + (spec[4] ? spec[4] * spec[3] : 0);
  const capacityBits = dataCodewords * 8;
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  // Terminator, then pad to the codeword boundary and fill with 0xEC / 0x11.
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCodewords; i++) codewords.push(PAD[i % 2]);

  // Split into blocks and compute error correction per block.
  const blocks = [];
  let offset = 0;
  const ecLen = spec[0];
  const groups = [[spec[1], spec[2]]];
  if (spec[4]) groups.push([spec[3], spec[4]]);
  for (const [count, dataLen] of groups) {
    for (let i = 0; i < count; i++) {
      const data = Uint8Array.from(codewords.slice(offset, offset + dataLen));
      offset += dataLen;
      blocks.push({ data, ec: rsEncode(data, ecLen) });
    }
  }

  // Interleave: all data codewords first (by index across blocks), then EC.
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);

  const base = new QrMatrix(version, level);
  base.drawFunctionPatterns();
  base.drawCodewords(Uint8Array.from(out));

  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.clone();
    m.applyMask(mask);
    m.drawFormat(mask);
    const score = m.penalty();
    if (score < bestScore) { bestScore = score; best = m; bestMask = mask; }
  }

  return {
    version,
    level,
    size: best.size,
    mask: bestMask,
    modules: best.modules,
    get: (r, c) => best.modules[r * best.size + c],
  };
}

/**
 * Render an encoded QR code as a standalone SVG document.
 */
export function toSvg(qr, opts = {}) {
  const scale = opts.scale || 8;
  const margin = opts.margin == null ? 4 : opts.margin;
  const dark = opts.dark || '#111827';
  const light = opts.light || '#ffffff';
  const dim = qr.size + margin * 2;
  const parts = [];
  for (let r = 0; r < qr.size; r++) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.get(r, c)) { c++; continue; }
      let len = 1;
      while (c + len < qr.size && qr.get(r, c + len)) len++;
      const x = c + margin;
      const y = r + margin;
      parts.push(`M${x} ${y}h${len}v1H${x}z`);
      c += len;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"`,
    ` width="${dim * scale}" height="${dim * scale}" shape-rendering="crispEdges">`,
    `<rect width="${dim}" height="${dim}" fill="${light}"/>`,
    `<path d="${parts.join('')}" fill="${dark}"/>`,
    '</svg>',
  ].join('');
}

/** Render as compact ANSI half-blocks for terminal output. */
export function toAnsi(qr) {
  const lines = [];
  const blank = new Array(qr.size + 5).fill(false);
  const rows = [];
  for (let r = 0; r < qr.size; r++) {
    const row = [false, false];
    for (let c = 0; c < qr.size; c++) row.push(!!qr.get(r, c));
    row.push(false, false);
    rows.push(row);
  }
  rows.push(blank.slice(), blank.slice());
  for (let r = 0; r < rows.length; r += 2) {
    let line = '';
    for (let c = 0; c < rows[r].length; c++) {
      const top = rows[r][c];
      const bottom = rows[r + 1] ? rows[r + 1][c] : false;
      line += top && bottom ? ' ' : top ? '\u2580' : bottom ? '\u2584' : '\u2588';
    }
    lines.push(line);
  }
  return lines.join(String.fromCharCode(10));
}
