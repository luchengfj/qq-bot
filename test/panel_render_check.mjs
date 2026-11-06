// Faithful render harness for client.js.
//
// Why this exists: the original blank-panel bug survived 10 green test suites
// because a hand-written jsx stub treated the THIRD arg as children. React's
// automatic runtime is jsx(type, props, KEY); React.createElement is
// (type, props, ...children). This harness uses a REAL createElement-shaped
// implementation and actually invokes function components, so an empty panel
// (or a dropped-children bug) shows up as nodes=1 / textLen=0.
//
// Run: node test/panel_render_check.mjs

import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// ---- minimal but FAITHFUL React -------------------------------------------
let hookIndex = 0;
let hooks = [];
let currentComponent = null;

function resetHooks(name) {
  hookIndex = 0;
  hooks = [];
  currentComponent = name;
}

function useState(initial) {
  const i = hookIndex++;
  if (!(i in hooks)) {
    hooks[i] = typeof initial === 'function' ? initial() : initial;
  }
  const set = (value) => {
    hooks[i] = typeof value === 'function' ? value(hooks[i]) : value;
  };
  return [hooks[i], set];
}

function useRef(initial) {
  const i = hookIndex++;
  if (!(i in hooks)) hooks[i] = { current: initial };
  return hooks[i];
}

function useCallback(fn) {
  const i = hookIndex++;
  if (!(i in hooks)) hooks[i] = fn;
  return hooks[i];
}

function useEffect(fn) {
  // Do NOT run effects in the static harness (they'd start network calls).
  // Just consume a hook slot so indices stay aligned.
  hookIndex++;
  void fn;
}

const React = {
  createElement(type, props, ...children) {
    const p = { ...(props || {}) };
    // Children passed positionally (createElement) become props.children.
    if (children.length === 1) p.children = children[0];
    else if (children.length > 1) p.children = children;
    return { type, props: p, key: p.key ?? null };
  },
  useState,
  useRef,
  useCallback,
  useEffect,
};

// ---- render walker --------------------------------------------------------
function walk(node, visit) {
  if (node == null || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit(String(node), null);
    return;
  }
  if (typeof node !== 'object' || !node.type) return;
  const { type, props } = node;
  if (typeof type === 'function') {
    // Invoke function components with a fresh hook cursor.
    resetHooks(type.name || 'anon');
    let out;
    try {
      out = type(props || {});
    } catch (err) {
      throw new Error(`render ${type.name || '?'} threw: ${err.message}`);
    }
    walk(out, visit);
    return;
  }
  visit(null, { tag: String(type), props });
  const ch = props && props.children;
  if (ch != null) walk(ch, visit);
}

function renderTree(node) {
  let nodes = 0;
  let textLen = 0;
  const samples = [];
  const allText = [];
  walk(node, (text, el) => {
    if (text != null) {
      textLen += text.length;
      allText.push(text);
      if (samples.length < 12) samples.push(text);
    } else {
      nodes++;
    }
  });
  return { nodes, textLen, sample: samples.join('').slice(0, 240), fullText: allText.join('') };
}

// ---- capture the module + seats ------------------------------------------
let moduleDef = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(def) { moduleDef = def; },
    },
  },
  document: {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild() {} },
  },
  navigator: { clipboard: null },
  console,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  setImmediate: (fn) => fn(),
  Date,
  String,
  Number,
  Boolean,
  Array,
  Object,
  JSON,
  Math,
  Error,
  RegExp,
  encodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

if (!moduleDef) throw new Error('FAIL: module did not call __ModuleLoader__.load');
if (moduleDef.id !== '@local/qq-bot') throw new Error(`FAIL: wrong module id ${moduleDef.id}`);

let exported = null;
const registered = [];
const ctx = {
  slots: {
    inject(name, cb) { cb(); },
    register(reg, render) { registered.push({ reg, render }); },
  },
  effect() {},
};
exported = moduleDef.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require: ${id}`);
});
if (!exported || !Array.isArray(exported.inject) || exported.inject[0] !== 'slots') {
  throw new Error('FAIL: factory must return { inject: ["slots"], apply }');
}
exported.apply(ctx);

if (registered.length !== 4) {
  throw new Error(`FAIL: expected 4 slot seats, got ${registered.length}`);
}

const byKey = (key) => registered.find((s) => s.reg && s.reg.key === key);
const main = byKey('qq-bot');
if (!main) throw new Error('FAIL: main seat (key qq-bot) not registered');

let rendered;
try {
  rendered = main.render({});
} catch (err) {
  throw new Error(`FAIL: main seat render threw: ${err.message}\n${err.stack}`);
}
const result = renderTree(rendered);

const checks = [];
const ok = (cond, msg) => { checks.push([Boolean(cond), msg]); };

ok(result.nodes > 60, `main panel has content (nodes=${result.nodes})`);
ok(result.textLen > 200, `main panel has text (textLen=${result.textLen})`);
ok(result.fullText.includes('直聊测试'), 'panel mentions 直聊测试');
ok(result.fullText.includes('连接真实 QQ'), 'panel mentions 连接真实 QQ');
ok(result.fullText.includes('零下载'), 'panel mentions 零下载');
ok(result.fullText.includes('正向 WebSocket'), 'panel offers forward WS');
ok(result.fullText.includes('反向 WS'), 'panel offers reverse WS');
ok(result.fullText.includes('自动探测本机 OneBot 端口'), 'panel shows the auto-detect card');
ok(result.fullText.includes('立即扫描'), 'panel shows the immediate-scan button');
ok(!/NapCatInstaller|一键接入|下载并安装|扫码登录/.test(result.fullText),
  'no NapCat download / QR / one-click-link UI remains');
ok(byKey('@local/qq-bot') != null, 'plugins.bundle.config seat present');
ok(byKey('@local/qq-bot#qq-bot') != null, 'plugins.row.config seat present');
ok(registered.find((s) => s.reg && s.reg.id === 'qq-bot') != null, 'sidebar.panellist seat present');

// The sidebar seat renders just the icon — it must at least produce a node.
const sidebar = registered.find((s) => s.reg && s.reg.id === 'qq-bot');
const icon = renderTree(sidebar.render({}));
ok(icon.nodes >= 1, `sidebar icon seat renders (nodes=${icon.nodes})`);

// The bundle/row compact panel must not be blank either.
const compactSeat = byKey('@local/qq-bot');
const compact = renderTree(compactSeat.render({ view: 'configure' }));
ok(compact.nodes > 8 && compact.textLen > 20,
  `compact panel has content (nodes=${compact.nodes}, textLen=${compact.textLen})`);

let failed = 0;
for (const [pass, msg] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${msg}`);
}
console.log(`MAIN nodes=${result.nodes} textLen=${result.textLen}`);
console.log(`SAMPLE: ${result.sample}`);
if (failed) {
  console.error(`PANEL_RENDER_FAIL (${failed})`);
  process.exit(1);
}
console.log(`ALL_PANEL_RENDER_PASS (${checks.length})`);
