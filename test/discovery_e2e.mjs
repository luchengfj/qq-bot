// Auto-discovery tests for NapCat WebUI token / port / config files.
//
// Uses real (cwd-relative) temp directories so Node's fs sees the same paths
// the plugin sees at runtime. Git-Bash /tmp paths would resolve to C:\tmp under
// node.exe, so we deliberately build dirs under the repo instead.
//
// Covers: explicit config token, env override, webui.json discovery, host
// normalisation, placeholder rejection, onebot11 path, missing/corrupt files,
// disableWebUI detection, and the async wrapper.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findSync, findNapCatConfig, candidateRoots, DEFAULT_PORT } from '../lib/discovery.js';

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log('ok  -', name); }
  catch (err) { results.push([false, name]); console.error('FAIL-', name, '\n   ', err.message); }
}

// Keep the env deterministic: save and restore around the tests.
const savedEnvToken = process.env.NAPCAT_WEBUI_SECRET_KEY;
const savedEnvPort = process.env.NAPCAT_WEBUI_PREFERRED_PORT;
const restoreEnv = () => {
  if (savedEnvToken === undefined) delete process.env.NAPCAT_WEBUI_SECRET_KEY;
  else process.env.NAPCAT_WEBUI_SECRET_KEY = savedEnvToken;
  if (savedEnvPort === undefined) delete process.env.NAPCAT_WEBUI_PREFERRED_PORT;
  else process.env.NAPCAT_WEBUI_PREFERRED_PORT = savedEnvPort;
};
delete process.env.NAPCAT_WEBUI_SECRET_KEY;
delete process.env.NAPCAT_WEBUI_PREFERRED_PORT;

const made = [];
function tmpdir(tag) {
  const dir = fs.mkdtempSync(`_disc-${tag}-`);  // cwd-relative on purpose
  made.push(dir);
  return dir;
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

await check('explicit configured token wins and builds URL from configured port', () => {
  const r = findSync({ configuredToken: 'abcd1234', configuredPort: 7000 });
  assert.equal(r.found, true);
  assert.equal(r.token, 'abcd1234');
  assert.equal(r.tokenSource, 'config');
  assert.equal(r.webuiPort, 7000);
  assert.equal(r.webuiUrl, 'http://127.0.0.1:7000');
  assert.equal(r.configPath, null);
});

await check('explicit token can use a configured baseUrl verbatim', () => {
  const r = findSync({ configuredToken: 'tok', configuredPort: 6099, baseUrl: 'http://192.168.1.5:7777' });
  assert.equal(r.webuiUrl, 'http://192.168.1.5:7777');
});

await check('placeholder tokens are rejected (empty / random / napcat)', () => {
  for (const t of ['', 'random', 'napcat', 'changeme', 'none', 'null', 'undefined']) {
    const r = findSync({ configuredToken: t, configuredPort: 6099, napcatDir: '__no_such_dir__' });
    assert.equal(r.found, false, `placeholder "${t}" should not be accepted`);
  }
});

await check('env NAPCAT_WEBUI_SECRET_KEY override + preferred port', () => {
  process.env.NAPCAT_WEBUI_SECRET_KEY = 'envsecret';
  process.env.NAPCAT_WEBUI_PREFERRED_PORT = '6123';
  const r = findSync({ configuredToken: '', configuredPort: 6099 });
  assert.equal(r.found, true);
  assert.equal(r.token, 'envsecret');
  assert.equal(r.tokenSource, 'env');
  assert.equal(r.webuiPort, 6123);
  assert.equal(r.webuiUrl, 'http://127.0.0.1:6123');
  delete process.env.NAPCAT_WEBUI_SECRET_KEY;
  delete process.env.NAPCAT_WEBUI_PREFERRED_PORT;
});

await check('discovers token + port + onebot11.json from webui.json', () => {
  const root = tmpdir('webui');
  const dir = path.join(root, 'napcat', 'config');
  writeJson(path.join(dir, 'webui.json'), { host: '::', port: 6555, token: 'deadbeef1234', loginRate: 10 });
  writeJson(path.join(dir, 'onebot11.json'), { network: {} });
  const r = findSync({ napcatDir: path.join(root, 'napcat'), configuredToken: '', configuredPort: 6099 });
  assert.equal(r.found, true, r.hints.join(' | '));
  assert.equal(r.token, 'deadbeef1234');
  assert.equal(r.tokenSource, 'webui.json');
  assert.equal(r.webuiPort, 6555);
  assert.equal(r.webuiUrl, 'http://127.0.0.1:6555'); // :: -> 127.0.0.1
  assert.ok(r.configPath && r.configPath.endsWith('webui.json'));
  assert.ok(r.onebot11Path && r.onebot11Path.endsWith('onebot11.json'));
});

await check('0.0.0.0 and ::1 hosts normalise to 127.0.0.1; IPv6 kept bracketed', () => {
  const root = tmpdir('host');
  writeJson(path.join(root, 'webui.json'), { host: '0.0.0.0', port: 6099, token: 'tok0' });
  const a = findSync({ napcatDir: root, configuredToken: '' });
  assert.equal(a.webuiUrl, 'http://127.0.0.1:6099');
  const root2 = tmpdir('host6');
  writeJson(path.join(root2, 'webui.json'), { host: '::1', port: 6099, token: 'tok1' });
  const b = findSync({ napcatDir: root2, configuredToken: '' });
  assert.equal(b.webuiUrl, 'http://127.0.0.1:6099');
  const root3 = tmpdir('host6b');
  writeJson(path.join(root3, 'webui.json'), { host: 'fe80::1', port: 6099, token: 'tok2' });
  const c = findSync({ napcatDir: root3, configuredToken: '' });
  assert.equal(c.webuiUrl, 'http://[fe80::1]:6099');
});

await check('placeholder token inside webui.json is not accepted but path is reported', () => {
  const root = tmpdir('placeholder');
  writeJson(path.join(root, 'webui.json'), { host: '::', port: 6099, token: 'random' });
  const r = findSync({ napcatDir: root, configuredToken: '' });
  assert.equal(r.found, false);
  assert.equal(r.tokenSource, 'none');
  assert.ok(r.configPath && r.configPath.endsWith('webui.json'));
  assert.ok(r.hints.some((h) => h.includes('占位') || h.includes('有效 token')));
});

await check('corrupt webui.json is skipped gracefully', () => {
  const root = tmpdir('corrupt');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'webui.json'), '{ not json', 'utf8');
  const r = findSync({ napcatDir: root, configuredToken: '' });
  assert.equal(r.found, false);
});

await check('disableWebUI / port=0 hint is surfaced', () => {
  const root = tmpdir('disabled');
  writeJson(path.join(root, 'webui.json'), { host: '::', port: 0, token: 'tokoff', disableWebUI: true });
  const r = findSync({ napcatDir: root, configuredToken: '' });
  assert.ok(r.hints.some((h) => h.includes('禁用')));
});

await check('missing config dir yields helpful hints and default port', () => {
  const r = findSync({ napcatDir: '__definitely_missing__', configuredToken: '' });
  assert.equal(r.found, false);
  assert.equal(r.webuiPort, DEFAULT_PORT);
  assert.ok(r.hints.length >= 1);
  assert.ok(r.hints.some((h) => h.includes('NapCat')));
});

await check('candidateRoots includes the explicit dir first and is deduplicated', () => {
  const roots = candidateRoots({ napcatDir: '_my_napcat_' });
  assert.equal(roots[0], '_my_napcat_');
  assert.equal(new Set(roots).size, roots.length);
});

await check('discovers deeply nested real-Shell webui.json (depth 8)', () => {
  // Mirrors the actual NapCat OneKey layout:
  //   <install>/NapCat.52230.Shell/versions/9.9.33-52230/resources/app/napcat/config/webui.json
  const root = tmpdir('shell');
  const deep = path.join(root, 'NapCat.52230.Shell', 'versions', '9.9.33-52230',
    'resources', 'app', 'napcat', 'config');
  writeJson(path.join(deep, 'webui.json'), { host: '::', port: 6099, token: 'deeptoken99' });
  writeJson(path.join(deep, 'onebot11.json'), { network: {} });
  const r = findSync({ napcatDir: root, configuredToken: '', configuredPort: 6099 });
  assert.equal(r.found, true, 'deep webui.json should be found: ' + r.hints.join(' | '));
  assert.equal(r.token, 'deeptoken99');
  assert.equal(r.tokenSource, 'webui.json');
});

await check('async findNapCatConfig matches findSync', async () => {
  const a = findSync({ configuredToken: 'asynctok', configuredPort: 6099 });
  const b = await findNapCatConfig({ configuredToken: 'asynctok', configuredPort: 6099 });
  assert.deepEqual(b, a);
});

// cleanup
restoreEnv();
for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
const failed = results.filter(([ok]) => !ok).length;
console.log(failed === 0 ? `ALL_DISCOVERY_PASS (${results.length})` : `DISCOVERY_FAILURES=${failed}`);
process.exit(failed === 0 ? 0 : 1);
