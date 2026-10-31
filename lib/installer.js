// NapCat runtime installer — makes "一键接入" genuinely one click.
//
// Previously the plugin assumed NapCat was already downloaded and its WebUI was
// running on 127.0.0.1:6099. When it wasn't, every QR / 接入 action failed with
// a bare "无法连接 NapCat" and the user had to leave Harness and install it by
// hand — which is exactly what "还是没办法用" meant.
//
// This module closes that gap. It:
//   1. detects an existing NapCat install (dir, launcher, onebot11.json),
//   2. probes whether the WebUI is already answering on its port,
//   3. downloads NapCat.Shell.Windows.OneKey.zip from GitHub,
//   4. extracts it (PowerShell Expand-Archive; falls back to the bundled 7z.exe),
//   5. launches the bootmain launcher detached.
//
// IMPORTANT NETWORK NOTE (hard-won): on some networks `github.com:443` times out
// while `api.github.com` is always reachable. Release assets are therefore
// downloaded through the API endpoint
//   https://api.github.com/repos/<owner>/<repo>/releases/assets/<assetId>
// with `Accept: application/octet-stream`, which 302s to object storage.
//
// Only Node built-ins are used; there is no npm dependency.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';

const REPO = 'NapNeko/NapCatQQ';
const ASSET_NAME = 'NapCat.Shell.Windows.OneKey.zip';
const LAUNCHER = 'NapCatWinBootMain.exe';
const DEFAULT_WEBUI_PORT = 6099;

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function defaultInstallDir() {
  // Sit next to the other Harness integration data.
  return path.join(os.homedir(), '.dsh', 'integrations', 'dsh-qq', 'napcat');
}

/** Is something listening on this loopback port? */
export function probePort(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(Number(port), host);
    } catch {
      finish(false);
    }
  });
}

/** Cheap "is the NapCat WebUI up?" check: GET /api/test needs no auth. */
export async function probeWebUi(baseUrl, timeoutMs = 4000) {
  const target = `${String(baseUrl).replace(/\/+$/, '')}/api/test`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method: 'GET', signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function runCommand(file, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout, stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: -2, stdout, stderr: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); if (stdout.length > 4000) stdout = stdout.slice(-4000); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: -1, stdout, stderr: String(err?.message || err) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: Number(code) === 0, code, stdout, stderr }); });
  });
}

/** Pick the most useful executable inside an extracted NapCat tree. */
export function findLauncher(dir) {
  const candidates = [
    path.join(dir, 'bootmain', LAUNCHER),
    path.join(dir, 'NapCatWinBootMain', LAUNCHER),
    path.join(dir, LAUNCHER),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

/** Recursively look for onebot11.json under dir (bounded). */
export function findOb11Config(dir, maxDepth = 4) {
  const walk = (current, depth) => {
    if (depth > maxDepth) return null;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name === 'onebot11.json') return full;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = walk(path.join(current, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(dir, 0);
}

export class NapCatInstaller {
  /**
   * @param {{installDir?:string, webuiPort?:number, timeoutMs?:number,
   *          log?:(msg:string)=>void}} [opts]
   */
  constructor(opts = {}) {
    this.installDir = String(opts.installDir || '').trim() || defaultInstallDir();
    this.webuiPort = Number(opts.webuiPort) || DEFAULT_WEBUI_PORT;
    this.timeoutMs = Number(opts.timeoutMs) || 180000;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.busy = null; // 'install' | 'launch' | null
    this.lastError = '';
    this.lastResult = null;
    // Background install progress: { stage, steps, done, error }
    this.job = null;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.webuiPort}`;
  }

  /** Synchronous-ish snapshot; `reachable` is filled by refresh(). */
  status() {
    const launcher = findLauncher(this.installDir);
    let configPath = null;
    try { configPath = findOb11Config(this.installDir); } catch { configPath = null; }
    let exists = false;
    try { exists = fs.existsSync(this.installDir); } catch { exists = false; }
    return {
      installed: Boolean(launcher),
      dir: this.installDir,
      exists,
      launcher,
      configPath,
      webuiUrl: this.baseUrl,
      webuiPort: this.webuiPort,
      running: Boolean(this.lastResult && this.lastResult.reachable),
      busy: this.busy,
      lastError: this.lastError || undefined,
      job: this.job,
    };
  }

  /** Probe the WebUI and remember the outcome. */
  async refresh() {
    const result = await probeWebUi(this.baseUrl, Math.min(this.timeoutMs, 8000));
    this.lastResult = result;
    if (result.ok) this.lastError = '';
    return result;
  }

  /**
   * Download + extract NapCat underneath installDir.
   * @param {(stage:string)=>void} [onStage]
   * @returns {Promise<{ok:boolean, dir?:string, launcher?:string, error?:string, steps?:string[]}>}
   */
  async install(onStage = () => {}) {
    if (this.busy) return { ok: false, error: '已有安装任务在进行中' };
    this.busy = 'install';
    this.lastError = '';
    const steps = [];
    try {
      onStage('正在查询最新版本');
      const probe = await probeWebUi(this.baseUrl, 2500);
      if (probe.ok) {
        // NapCat is already running — installing over a live instance would
        // fail to overwrite files (and restart it out from under the user).
        this.busy = null;
        return { ok: true, skipped: true, reason: 'NapCat 已在运行，跳过安装', steps };
      }
      const api = `https://api.github.com/repos/${REPO}/releases/latest`;
      const metaRes = await fetch(api, {
        headers: { 'User-Agent': 'dsh-qq-bot', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30000)),
      });
      if (!metaRes.ok) throw new Error(`无法获取版本信息 (HTTP ${metaRes.status})`);
      const meta = await metaRes.json();
      const asset = (meta.assets || []).find((a) => a && a.name === ASSET_NAME);
      if (!asset) throw new Error(`发布包中找不到 ${ASSET_NAME}`);
      steps.push(`版本 ${meta.tag_name}`);

      await fsp.mkdir(this.installDir, { recursive: true });
      const zipPath = path.join(this.installDir, ASSET_NAME);

      onStage('正在下载 NapCat');
      const assetRes = await fetch(
        `https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`,
        {
          headers: { 'User-Agent': 'dsh-qq-bot', Accept: 'application/octet-stream' },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!assetRes.ok) throw new Error(`下载失败 (HTTP ${assetRes.status})`);
      const buf = Buffer.from(await assetRes.arrayBuffer());
      if (buf.length && asset.size && buf.length !== asset.size) {
        throw new Error(`下载不完整：${buf.length}/${asset.size} 字节`);
      }
      await fsp.writeFile(zipPath, buf);
      steps.push(`下载完成 ${buf.length} 字节`);

      onStage('正在解压');
      await extractZip(zipPath, this.installDir, this.timeoutMs);
      steps.push('解压完成');

      const launcher = findLauncher(this.installDir);
      this.busy = null;
      this.lastResult = await probeWebUi(this.baseUrl, 5000);
      return {
        ok: Boolean(launcher),
        dir: this.installDir,
        launcher,
        error: launcher ? undefined : '解压后没有找到 NapCatWinBootMain.exe',
        steps,
        webuiReachable: Boolean(this.lastResult && this.lastResult.ok),
      };
    } catch (err) {
      this.busy = null;
      this.lastError = err?.message || String(err);
      return { ok: false, error: this.lastError, steps };
    }
  }

  /**
   * Start install() in the background and return immediately.
   * The panel polls status() and shows job.stage / job.steps.
   * @returns {Promise<{ok:boolean, started:boolean, error?:string}>}
   */
  startInstall() {
    if (this.busy) return Promise.resolve({ ok: false, started: false, error: '已有任务在进行中' });
    this.lastError = '';
    this.job = { stage: '准备中', steps: [], done: false, error: null };
    this.install((stage) => {
      this.job.stage = stage;
    }).then((result) => {
      this.busy = null;
      this.job.steps = result.steps || this.job.steps;
      this.job.done = true;
      this.job.ok = result.ok;
      this.job.stage = result.ok ? '安装完成' : '安装失败';
      if (!result.ok) this.job.error = result.error || '未知错误';
    }).catch((err) => {
      this.busy = null;
      this.job.done = true;
      this.job.ok = false;
      this.job.stage = '安装失败';
      this.job.error = err?.message || String(err);
    });
    return Promise.resolve({ ok: true, started: true });
  }

  /**
   * Launch NapCat detached (it hooks QQNT and opens its own console).
   * @returns {Promise<{ok:boolean, pid?:number, error?:string}>}
   */
  async launch() {
    if (this.busy) return { ok: false, error: '已有任务在进行中' };
    this.busy = 'launch';
    this.lastError = '';
    try {
      const launcher = findLauncher(this.installDir);
      if (!launcher) {
        throw new Error('尚未安装 NapCat 运行时，请先点击「安装 NapCat 运行时」');
      }
      // NapCatWinBootMain.exe boots `<its own dir>/QQ.exe`. The OneKey bundle
      // does not ship that binary, so point it at the real QQNT install by
      // copying/symlinking is not possible; instead launch with the QQNT path
      // as cwd fallback handled by the launcher's own search: if QQ.exe is not
      // beside the launcher, launch QQNT ourselves and let NapCat hook it.
      const cwd = path.dirname(launcher);
      const qqnt = fs.existsSync(path.join(cwd, 'QQ.exe')) ? cwd : findQqnt();
      const target = qqnt ? path.join(qqnt, 'QQ.exe') : launcher;
      const child = spawn(target, [], {
        cwd: qqnt || cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      this.busy = null;
      return {
        ok: true,
        pid: child.pid,
        webuiUrl: this.baseUrl,
        launched: path.basename(target),
        from: qqnt ? 'QQNT 安装目录' : 'NapCat 启动器',
      };
    } catch (err) {
      this.busy = null;
      this.lastError = err?.message || String(err);
      return { ok: false, error: this.lastError };
    }
  }
}

/**
 * Extract a zip archive. Windows ships PowerShell's Expand-Archive, which is the
 * only dependency-free route; if it is unavailable (Core, restricted policy, or
 * non-Windows), fall back to the 7z.exe that ships inside the OneKey bundle.
 */
export async function extractZip(zipPath, destDir, timeoutMs = 180000) {
  await fsp.mkdir(destDir, { recursive: true });

  const ps = [
    '$ErrorActionPreference = "Stop"',
    `Expand-Archive -LiteralPath '${powershellLiteral(zipPath)}' -DestinationPath '${powershellLiteral(destDir)}' -Force`,
  ].join('; ');

  const result = await runCommand(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { timeoutMs },
  );

  if (result.ok) return { ok: true, tool: 'powershell' };

  // Fallback: 7z.exe from the OneKey bundle (it sits next to the zip).
  const sevenZip = path.join(path.dirname(zipPath), '7z.exe');
  if (fs.existsSync(sevenZip)) {
    const fallback = await runCommand(sevenZip, ['x', `-o${destDir}`, zipPath, '-y'], { timeoutMs });
    if (fallback.ok) return { ok: true, tool: '7z' };
    throw new Error(`解压失败：${fallback.stderr || fallback.stdout || '未知错误'}`);
  }

  throw new Error(`解压失败：${result.stderr || result.stdout || '未知错误'}`);
}

/** Escape a path for use inside a single-quoted PowerShell string. */
export function powershellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/** Locate the QQNT installation, if present. */
export function findQqnt() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, 'Tencent', 'QQNT', 'QQ.exe');
    try {
      if (fs.existsSync(candidate)) return path.dirname(candidate);
    } catch { /* ignore */ }
  }
  return null;
}

export { DEFAULT_WEBUI_PORT, ASSET_NAME, REPO };

export const _internal = { bool, defaultInstallDir };
