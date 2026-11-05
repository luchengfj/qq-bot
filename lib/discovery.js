// Auto-discovery of NapCat's WebUI connection details.
//
// NapCat generates a RANDOM webui token on first boot and writes it to
// <configDir>/webui.json as { host, port, token, ... }. Requiring the user to
// find it and paste it into cordis.patch.yml is the single biggest source of
// "无法获取二维码 / 无法接入" reports. This module scans the usual NapCat
// install/config locations, reads webui.json, and returns the token + port so
// SetupConsole can configure NapCatClient without any manual step.
//
// Zero npm deps — only node:fs / node:path / node:os / node:process.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_PORT = 6099;

// Tokens NapCat may ship as placeholders; never treat these as real secrets.
const PLACEHOLDERS = new Set(['', 'random', 'napcat', 'changeme', 'none', 'null', 'undefined']);

function isRealToken(value) {
  const s = String(value ?? '').trim();
  return s.length > 0 && !PLACEHOLDERS.has(s.toLowerCase());
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Where NapCat may keep its config. Order matters: explicit config wins, then
 * the managed install, then temp/QQNT/user locations.
 */
export function candidateRoots(opts = {}) {
  const roots = [];
  const push = (dir) => {
    if (dir && typeof dir === 'string' && !roots.includes(dir)) roots.push(dir);
  };
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

  push(opts.napcatDir || '');
  push(process.env.NAPCAT_WORKDIR || '');
  push(path.join(home, '.dsh', 'integrations', 'dsh-qq', 'napcat'));
  push(path.join(home, '.dsh', 'integrations', 'dsh-qq'));
  push(path.join(appData, 'QQNT'));
  push(path.join(home, 'Documents'));
  push(path.join(programFiles, 'Tencent', 'QQNT'));

  // A DSH-side installer may have staged NapCat in %TEMP%\qq-installer-*.
  // Newest first; tolerate a missing/unreadable temp dir.
  try {
    const tempRoot = path.join(localAppData, 'Temp');
    const entries = fs.readdirSync(tempRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('qq-installer-'))
      .map((e) => ({ name: e.name, file: path.join(tempRoot, e.name) }))
      .map((e) => {
        try { return { ...e, mtime: fs.statSync(e.file).mtimeMs }; } catch { return { ...e, mtime: 0 }; }
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries) {
      push(e.file);
      push(path.join(e.file, 'napcat'));
      push(path.join(e.file, 'napcat', 'config'));
    }
  } catch { /* no temp dir — fine */ }

  return roots;
}

/**
 * Recursively look for webui.json / onebot11*.json under a root.
 * Bounded by depth and total visited directories so we never walk the whole
 * Program Files tree.
 */
function scan(root, maxDepth = 6, budget = { left: 4000 }) {
  const found = { webui: null, onebot11: [], napcatDir: null };
  if (!root || budget.left <= 0) return found;
  const walk = (dir, depth) => {
    if (depth > maxDepth || budget.left <= 0) return;
    budget.left--;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip huge / irrelevant directory names (each `ent.name` is ONE name,
        // never a path, so this must be a name-only pattern, no separators).
        if (/^(node_modules|windows|app_launcher|\$recycle\.bin)$/i.test(ent.name)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        const lower = ent.name.toLowerCase();
        if (lower === 'webui.json' && !found.webui) {
          found.webui = full;
          found.napcatDir = path.dirname(full);
        } else if (/^onebot11(_\d+)?\.json$/i.test(ent.name)) {
          found.onebot11.push(full);
        }
      }
    }
  };
  walk(root, 0);
  return found;
}

function normaliseHost(host) {
  const h = String(host || '').trim();
  if (!h || h === '::' || h === '0.0.0.0' || h === '::1') return '127.0.0.1';
  if (h.startsWith('[')) return h;
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

/**
 * Find NapCat WebUI connection details.
 *
 * @param {object} [opts]
 * @param {string} [opts.napcatDir]   explicit NapCat install/config dir
 * @param {number} [opts.configuredPort] fallback port from cordis.patch.yml
 * @param {string} [opts.baseUrl]      configured base URL (used as a hint)
 * @param {string} [opts.configuredToken] explicitly configured token (wins)
 * @returns {{
 *   found:boolean, token:string, tokenSource:string, webuiPort:number,
 *   webuiUrl:string, configPath:string|null, configDir:string|null,
 *   onebot11Path:string|null, napcatDir:string|null, hints:string[]
 * }}
 */
export function findSync(opts = {}) {
  const hints = [];
  const configuredToken = String(opts.configuredToken || '').trim();
  const envToken = String(process.env.NAPCAT_WEBUI_SECRET_KEY || '').trim();

  // 1. Explicit config (cordis.patch.yml) — user knows best.
  if (isRealToken(configuredToken)) {
    const port = Number(opts.configuredPort) || DEFAULT_PORT;
    const url = opts.baseUrl || `http://127.0.0.1:${port}`;
    return {
      found: true, token: configuredToken, tokenSource: 'config',
      webuiPort: port, webuiUrl: url, configPath: null, configDir: null,
      onebot11Path: null, napcatDir: opts.napcatDir || null, hints,
    };
  }
  // 2. Environment override (NapCat rewrites webui.json from it each boot).
  if (isRealToken(envToken)) {
    const port = Number(process.env.NAPCAT_WEBUI_PREFERRED_PORT) || Number(opts.configuredPort) || DEFAULT_PORT;
    return {
      found: true, token: envToken, tokenSource: 'env',
      webuiPort: port, webuiUrl: `http://127.0.0.1:${port}`,
      configPath: null, configDir: null, onebot11Path: null,
      napcatDir: opts.napcatDir || null, hints,
    };
  }
  // 3. Scan for webui.json.
  if (!isRealToken(configuredToken)) {
    hints.push('napcat.webuiToken 未填写：将尝试从 NapCat 的 webui.json 自动读取令牌');
  }
  for (const root of candidateRoots(opts)) {
    // A real NapCat Shell nests its config deeply:
    //   NapCat.*.Shell/versions/<ver>/resources/app/napcat/config/webui.json
    // (8 levels below the install root). Depth 9 reaches it while the
    // 4000-directory budget still bounds the walk.
    const hit = scan(root, 9);
    if (!hit.webui) continue;
    const cfg = readJson(hit.webui);
    if (!cfg || typeof cfg !== 'object') continue;
    const token = String(cfg.token || '').trim();
    const port = Number(cfg.port) || Number(opts.configuredPort) || DEFAULT_PORT;
    const host = normaliseHost(cfg.host);
    const webuiUrl = `http://${host}:${port}`;
    const result = {
      found: isRealToken(token),
      token: isRealToken(token) ? token : '',
      tokenSource: isRealToken(token) ? 'webui.json' : 'none',
      webuiPort: port,
      webuiUrl,
      configPath: hit.webui,
      configDir: path.dirname(hit.webui),
      onebot11Path: hit.onebot11[0] || null,
      napcatDir: hit.napcatDir || root,
      hints,
    };
    if (!result.found) {
      hints.push(`发现 ${hit.webui}，但其中没有有效 token（可能是安装器占位文件）`);
    } else if (cfg.disableWebUI === true || port === 0) {
      hints.push(`${hit.webui} 显示 WebUI 已被禁用 (disableWebUI=true / port=0)`);
    }
    return result;
  }

  hints.push('未发现 NapCat 的 webui.json：请先启动 NapCat（运行 NapCatInstaller.exe 后执行 napcat.bat），或在 cordis.patch.yml 填 napcat.webuiToken');
  return {
    found: false, token: '', tokenSource: 'none',
    webuiPort: Number(opts.configuredPort) || DEFAULT_PORT,
    webuiUrl: opts.baseUrl || `http://127.0.0.1:${Number(opts.configuredPort) || DEFAULT_PORT}`,
    configPath: null, configDir: null, onebot11Path: null,
    napcatDir: opts.napcatDir || null, hints,
  };
}

/** Async wrapper so callers can `await` without changing the sync core. */
export async function findNapCatConfig(opts = {}) {
  return findSync(opts);
}
