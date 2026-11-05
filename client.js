// Client half of the QQ bot bundle: renders the panel inside the DSH Web UI.
//
// Registered slot seats:
//   plugins.bundle.config  keyed '@local/qq-bot'          -> bundle page card
//   plugins.row.config     keyed '@local/qq-bot#qq-bot'   -> row configure page
//   sidebar.panellist                                     -> global panel icon
//   main                   keyed 'qq-bot'                 -> the panel itself
//
// Data comes from the Host bridge registered in lib/bridge.js on
// ctx.webServer under /api/qq-bot/* (same origin, loopback-only).
//
// NOTE: this module builds every element with React.createElement (h) ONLY.
// The automatic runtime's element helper takes (type, props, key) - its THIRD
// positional argument is the KEY, not children. Passing children there leaves
// props.children undefined and the whole panel renders as an EMPTY div.
// React.createElement(type, props, ...children) is the only correct call.

window.__ModuleLoader__.load({
  id: '@local/qq-bot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BRIDGE = '/api/qq-bot';
    const PANEL_ID = 'qq-bot';
    const POLL_MS = 4000;

    async function bridge(path, options) {
      const res = await fetch(`${BRIDGE}${path}`, Object.assign(
        { headers: { 'Content-Type': 'application/json' } },
        options,
      ));
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
      return data || {};
    }

    const call = (path) => bridge(path, { method: 'POST' });
    const post = (path, body) => bridge(path, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    });

    // ---------- small presentational helpers ----------

    // Pill takes `kind` (never `ok:`/`tone:`): ok | warn | err | info | neutral.
    function Pill({ children, kind }) {
      return h('span', {
        className: 'qq-pill' + (kind ? ` qq-pill-${kind}` : ''),
      }, children);
    }

    // `title` is a node (icon + label), `extra` sits on the right of the head.
    function Card({ title, icon, extra, children, className }) {
      return h('section', {
        className: 'qq-card' + (className ? ` ${className}` : ''),
      }, [
        h('header', { className: 'qq-card-head', key: 'h' }, [
          h('div', { className: 'qq-card-title', key: 't' }, [
            icon ? h('span', { className: 'qq-card-icon', key: 'i', 'aria-hidden': 'true' }, icon) : null,
            h('span', { key: 'tx' }, title),
          ]),
          extra ? h('div', { className: 'qq-card-extra', key: 'e' }, extra) : null,
        ]),
        h('div', { className: 'qq-card-body', key: 'b' }, children),
      ]);
    }

    function Field({ label, children }) {
      return h('div', { className: 'qq-field' }, [
        h('label', { key: 'l' }, label),
        h('div', { className: 'qq-field-c', key: 'c' }, children),
      ]);
    }

    function Button({ onClick, disabled, children, ghost, danger, loading, className, title }) {
      return h('button', {
        type: 'button',
        className: 'qq-btn' + (ghost ? ' qq-btn-ghost' : '') +
          (danger ? ' qq-btn-danger' : '') + (loading ? ' qq-btn-loading' : '') +
          (className ? ` ${className}` : ''),
        onClick,
        disabled: Boolean(disabled),
        title: title || undefined,
      }, [
        loading ? h('span', { className: 'qq-spinner', key: 's', 'aria-hidden': 'true' }) : null,
        h('span', { key: 't' }, children),
      ]);
    }

    function Dot({ tone }) {
      return h('span', { className: `qq-dot qq-dot-${tone || 'neutral'}`, 'aria-hidden': 'true' });
    }

    function KV({ k, children }) {
      return h('div', { className: 'qq-kv' }, [
        h('span', { className: 'qq-kv-k', key: 'k' }, k),
        h('span', { className: 'qq-kv-v', key: 'v' }, children),
      ]);
    }

    function StatTile({ label, value, tone }) {
      return h('div', { className: 'qq-stat' }, [
        h('span', { className: 'qq-stat-label', key: 'l' }, label),
        h('span', {
          className: 'qq-stat-value' + (tone ? ` qq-stat-${tone}` : ''),
          key: 'v',
        }, String(value)),
      ]);
    }

    // ---------- hero artwork ----------

    /** Inline SVG penguin glyph (sidebar + section icons). */
    function Icon({ size }) {
      const s = size || 18;
      return h('svg', {
        viewBox: '0 0 24 24', width: s, height: s, 'aria-hidden': 'true',
      }, h('path', {
        d: 'M12 2.6c-3.7 0-6.3 2.3-6.3 5.8 0 2.7 1.7 4.6 4.2 5.2-.3.5-.5 1.1-.5 1.7 0 .9.6 1.5 1.5 1.5h2.2c.9 0 1.5-.6 1.5-1.5 0-.6-.2-1.2-.5-1.7 2.5-.6 4.2-2.5 4.2-5.2 0-3.5-2.6-5.8-6.3-5.8zm-2.2 5.1a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm4.4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM5.2 19.4c-.8 0-1.4.6-1.4 1.4s.6 1.4 1.4 1.4h13.6c.8 0 1.4-.6 1.4-1.4s-.6-1.4-1.4-1.4H5.2z',
        fill: 'currentColor',
      }));
    }

    /** Friendly bot mark inside a rounded gradient square. */
    function HeroMark() {
      return h('span', { className: 'qq-hero-mark', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 48 48', width: 38, height: 38 }, [
          h('rect', { key: 'ant', x: 22, y: 5, width: 4, height: 7, rx: 2, fill: '#fff' }),
          h('circle', { key: 'tip', cx: 24, cy: 5, r: 2.4, fill: '#fff' }),
          h('rect', { key: 'head', x: 7, y: 11, width: 34, height: 29, rx: 13, fill: '#fff' }),
          h('circle', { key: 'e1', cx: 18, cy: 24, r: 3.1, fill: '#4f46e5' }),
          h('circle', { key: 'e2', cx: 30, cy: 24, r: 3.1, fill: '#4f46e5' }),
          h('path', { key: 'smile', d: 'M18 31 q6 4.5 12 0', fill: 'none', stroke: '#4f46e5', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
          h('rect', { key: 'l', x: 4, y: 21, width: 3, height: 9, rx: 1.5, fill: '#fff', opacity: 0.85 }),
          h('rect', { key: 'r', x: 41, y: 21, width: 3, height: 9, rx: 1.5, fill: '#fff', opacity: 0.85 }),
        ]));
    }

    // ---------- grouped sections ----------

    function Section({ icon, title, desc, children, className }) {
      return h('section', { className: 'qq-section' + (className ? ` ${className}` : '') }, [
        h('div', { className: 'qq-section-head', key: 'h' }, [
          h('span', { className: 'qq-section-icon', key: 'i', 'aria-hidden': 'true' }, icon),
          h('div', { className: 'qq-section-titles', key: 't' }, [
            h('h3', { key: 'ti' }, title),
            h('p', { key: 'd' }, desc),
          ]),
        ]),
        h('div', { className: 'qq-section-grid', key: 'g' }, children),
      ]);
    }

    // ---------- 运行概览 + 状态徽标 ----------

    function StatusPanel({ state }) {
      const s = state.status;
      const stats = (s && s.stats) || {};
      const llm = (s && s.llm) || {};
      const ep = (s && s.endpoint) || {};
      const nap = (s && s.napcat) || {};
      const connected = Boolean(s && s.connections > 0);
      const logged = Boolean(s && s.selfIds && s.selfIds.length);
      return h(Card, {
        title: '运行状态', icon: '🛰', className: 'qq-card-status',
        extra: h(Button, {
          key: 'r', ghost: true, onClick: state.refresh, title: '立即刷新状态',
        }, '刷新'),
      }, [
        h('div', { className: 'qq-stat-grid', key: 'tiles' }, [
          h(StatTile, { key: 'a', label: '连接数', value: s ? s.connections : '—', tone: connected ? 'ok' : '' }),
          h(StatTile, { key: 'b', label: '已接收', value: stats.received || 0 }),
          h(StatTile, { key: 'c', label: '已回复', value: stats.answered || 0 }),
          h(StatTile, { key: 'd', label: '失败', value: stats.failed || 0, tone: stats.failed ? 'err' : '' }),
        ]),
        h('div', { className: 'qq-kv-list', key: 'info' }, [
          h(KV, { k: '已登录 QQ', key: 'q' }, logged ? h(Pill, { kind: 'ok' }, s.selfIds.join(', ')) : '尚未登录'),
          h(KV, { k: '当前模型', key: 'm' },
            llm.mode === 'external'
              ? (llm.hasKey ? `外部端点 · ${llm.model}` : '外部端点 · 未配置密钥')
              : `Harness 模型 · ${llm.model || '跟随当前选择'}`),
          h(KV, { k: '反向 WS', key: 'r' }, h('code', null, (s && s.reverseUrl) || '—')),
          h(KV, { k: '本插件端点', key: 'e' },
            h('code', null, `${ep.host || '—'}:${ep.port || '—'}${ep.path || ''} · ${ep.replyVia || '—'}`)),
          h(KV, { k: 'NapCat WebUI', key: 'n' }, [
            h('code', { key: 'u' }, nap.baseUrl || '—'),
            nap.hasToken ? null : h(Pill, { key: 't', kind: 'warn' }, '未填令牌'),
          ]),
          stats.lastError ? h('p', { className: 'qq-error', key: 'err' }, `最近错误：${stats.lastError}`) : null,
        ]),
      ]);
    }

    // ---------- 连接与登录 ----------

    function LoginPanel({ state }) {
      const s = state.status;
      const nap = (s && s.napcat) || {};
      return h(Card, { title: '扫码登录与接入', icon: '🔑' }, [
        h('div', { className: 'qq-row', key: 'btns' }, [
          h(Button, {
            key: 'qr', onClick: () => state.action('newQr'),
            disabled: state.busy === 'newQr', loading: state.busy === 'newQr',
          }, state.qrUrl ? '刷新二维码' : '获取二维码'),
          h(Button, {
            key: 'lk', ghost: true, onClick: () => state.action('link'),
            disabled: state.busy === 'link', loading: state.busy === 'link',
          }, '一键接入反向 WS'),
          (s && s.setupUrl)
            ? h('a', { className: 'qq-link', key: 'a', href: s.setupUrl, target: '_blank', rel: 'noreferrer' }, '独立控制台 ↗')
            : null,
        ]),
        h('div', { className: 'qq-qr-wrap', key: 'qr' }, [
          h('div', { className: 'qq-qr', key: 'box' },
            state.qrUrl
              ? h('img', {
                  className: 'qq-qr-img', alt: 'QQ 登录二维码',
                  src: `${BRIDGE}/qr.svg?t=${state.qrStamp}`,
                })
              : h('span', { className: 'qq-qr-empty', 'aria-hidden': 'true' }, '▦')),
          h('div', { className: 'qq-qr-side', key: 'side' }, [
            h('p', { className: 'qq-qr-lead', key: 'l' }, state.qrUrl ? '请用手机 QQ 扫码' : '点击「获取二维码」开始'),
            h('div', { className: 'qq-row', key: 'cd' }, [
              h(Pill, { kind: 'warn' }, '⏱ 约 115 秒后失效'),
            ]),
            h('p', { className: 'qq-muted', key: 't' },
              '二维码由插件本地生成，不会上传到任何第三方；过期后点「刷新二维码」即可。'),
          ]),
        ]),
        h('div', { className: 'qq-codebox', key: 'url' }, h('code', null, (s && s.reverseUrl) || '—')),
        (nap.hints && nap.hints.length)
          ? h('ul', { className: 'qq-hints', key: 'hints' },
              nap.hints.map((t, i) => h('li', { key: `h${i}` }, String(t))))
          : null,
        h('p', { className: 'qq-muted', key: 'note' },
          '若无法生成二维码，请确认 NapCat 已启动、端口正确，且 napcat.webuiToken 与 NapCat 登录令牌一致。'),
      ]);
    }

    // ---------- NapCat 运行时 ----------

    function InstallPanel({ state }) {
      const s = state.status;
      const rt = s && s.napcatRuntime;
      const job = rt && rt.job;
      const steps = (job && job.steps) || [];
      return h(Card, { title: '安装与启动', icon: '📦' }, [
        h('div', { className: 'qq-row', key: 'pills' }, [
          h(Pill, { key: 'i', kind: rt && rt.installed ? 'ok' : 'warn' }, rt && rt.installed ? '引导包已下载' : '未安装'),
          h(Pill, { key: 'r', kind: rt && rt.running ? 'ok' : 'warn' }, rt && rt.running ? 'WebUI 在线' : 'WebUI 未连接'),
          h(Pill, { key: 's', kind: rt && rt.ready ? 'ok' : 'warn' }, rt && rt.ready ? '运行时就绪' : '运行时未就绪'),
          rt && rt.busy ? h(Pill, { key: 'b', kind: 'info' }, `进行中：${rt.busy}`) : null,
        ]),
        rt && rt.dir ? h('p', { className: 'qq-muted', key: 'dir' }, `安装目录：${rt.dir}`) : null,
        rt && rt.bootstrapper && !rt.ready
          ? h('p', { className: 'qq-muted', key: 'boot' }, '当前只有 1 MB 引导包：点「启动 NapCat」会先运行 NapCatInstaller.exe 下载真正的 Shell 运行时（QQNT + NapCat），完成后再点一次「启动 NapCat」。')
          : null,
        rt && rt.shell && rt.shell.dir ? h('p', { className: 'qq-muted', key: 'sh' }, `运行时目录：${rt.shell.dir}`) : null,
        rt && rt.launcher ? h('p', { className: 'qq-muted', key: 'ln' }, `启动器：${rt.launcher}`) : null,
        rt && rt.lastError ? h('p', { className: 'qq-error', key: 'er' }, String(rt.lastError)) : null,
        h('div', { className: 'qq-row', key: 'btns' }, [
          h(Button, {
            key: 'i', onClick: () => state.action('napInstall'),
            disabled: Boolean(state.busy), loading: state.busy === 'napInstall',
          }, rt && rt.installed ? '重新安装 NapCat' : '下载并安装 NapCat'),
          h(Button, {
            key: 'l', ghost: true, onClick: () => state.action('napLaunch'),
            disabled: Boolean(state.busy) || !(rt && rt.installed),
            loading: state.busy === 'napLaunch',
          }, rt && rt.bootstrapper && !rt.ready ? '运行 NapCat 安装器' : '启动 NapCat'),
        ]),
        job
          ? h('div', { className: 'qq-job', key: 'job' }, [
              h('p', { className: 'qq-muted', key: 'st' }, `状态：${job.stage}${job.done ? '' : ' …'}`),
              steps.length
                ? h('ul', { className: 'qq-mem-facts', key: 'ul' },
                    steps.map((x, i) => h('li', { key: `s${i}` }, String(x))))
                : null,
              job.error ? h('p', { className: 'qq-error', key: 'je' }, String(job.error)) : null,
            ])
          : h('p', { className: 'qq-muted', key: 'idle' },
              '首次使用：先「下载并安装 NapCat」，再「启动 NapCat」（引导包阶段会先运行安装器），等「运行时就绪 / WebUI 在线」后回到「接入」页扫码登录。'),
      ]);
    }

    // ---------- 测试 ----------

    function SendPanel({ state }) {
      const [form, setForm] = React.useState({
        messageType: 'group',
        userId: '',
        groupId: '',
        text: '',
      });
      const update = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
      const send = () => state.action('send', form);
      const valid = Boolean(form.text.trim()) && (
        form.messageType === 'private' ? Boolean(form.userId.trim()) : Boolean(form.groupId.trim())
      );
      return h(Card, { title: '发送测试消息', icon: '✉️' }, [
        h('div', { className: 'qq-row', key: 'r1' }, [
          h(Field, { label: '类型', key: 't' },
            h('select', { className: 'qq-input', value: form.messageType, onChange: update('messageType') }, [
              h('option', { key: 'g', value: 'group' }, '群消息'),
              h('option', { key: 'p', value: 'private' }, '私聊消息'),
            ])),
          form.messageType === 'private'
            ? h(Field, { label: 'QQ 号', key: 'u' },
                h('input', { className: 'qq-input', value: form.userId, onChange: update('userId'), placeholder: '如 10001' }))
            : h(Field, { label: '群号', key: 'g' },
                h('input', { className: 'qq-input', value: form.groupId, onChange: update('groupId'), placeholder: '如 123456' })),
        ]),
        h(Field, { label: '内容', key: 'c' },
          h('input', { className: 'qq-input', value: form.text, onChange: update('text'), placeholder: '要发送的文本' })),
        h('div', { className: 'qq-row', key: 'r2' },
          h(Button, {
            key: 'b', onClick: send, disabled: !valid || state.busy === 'send',
            loading: state.busy === 'send',
          }, '发送消息')),
        h('div', { className: 'qq-row', key: 'r3' }, [
          h(Button, {
            key: 't', ghost: true, disabled: state.busy === 'llmTest',
            loading: state.busy === 'llmTest', onClick: () => state.action('llmTest'),
          }, '测试模型接口'),
          h(Button, { key: 's', ghost: true, onClick: () => state.action('resetStats') }, '清空统计'),
          h(Button, { key: 'l', ghost: true, onClick: () => state.action('clearLog') }, '清空日志'),
        ]),
        state.testResult
          ? h('p', {
              key: 'tr',
              className: state.testResult.ok ? 'qq-ok' : 'qq-error',
            }, state.testResult.ok
              ? `模型接口正常（${state.testResult.ms} ms）：${state.testResult.reply}`
              : `模型接口异常：${state.testResult.error}`)
          : null,
      ]);
    }

    /** Diagnostics: render {name, ok, detail}[] + hints (also tolerates checks[]). */
    function DiagPanel({ state }) {
      const diag = state.diagnose;
      const raw = diag
        ? (Array.isArray(diag.checks) ? diag.checks : (Array.isArray(diag.results) ? diag.results : []))
        : [];
      const hints = (diag && (diag.hints || diag.tips)) || [];
      const items = raw.map((c) => ({
        name: c.name || c.label || c.id || '检查项',
        ok: Boolean(c.ok),
        detail: c.detail != null ? String(c.detail) : (c.hint ? String(c.hint) : ''),
      }));
      const passed = items.filter((c) => c.ok).length;
      const failed = items.length - passed;
      return h(Card, {
        title: '连接诊断', icon: '🩺', className: 'qq-card-diag',
        extra: h(Button, {
          key: 'd', onClick: () => state.action('diagnose'),
          disabled: state.busy === 'diagnose', loading: state.busy === 'diagnose',
        }, '运行诊断'),
      }, [
        diag
          ? h('div', { className: 'qq-diag', key: 'd' }, [
              h('div', { className: 'qq-diag-summary', key: 's' }, [
                h(Pill, { key: 'a', kind: 'info' }, `共 ${items.length} 项`),
                h(Pill, { key: 'b', kind: 'ok' }, `✓ 正常 ${passed}`),
                failed ? h(Pill, { key: 'c', kind: 'err' }, `✗ 需处理 ${failed}`) : null,
                diag.at ? h('span', { className: 'qq-muted', key: 't' }, new Date(diag.at).toLocaleString()) : null,
              ]),
              items.length
                ? h('div', { className: 'qq-check-list', key: 'list' },
                    items.map((c, i) =>
                      h('div', {
                        className: 'qq-check' + (c.ok ? '' : ' qq-check-bad'),
                        key: `${c.name}:${i}`,
                      }, [
                        h('span', { className: 'qq-check-sym', key: 's', 'aria-hidden': 'true' }, c.ok ? '✓' : '✗'),
                        h('div', { className: 'qq-check-main', key: 'm' }, [
                          h('div', { className: 'qq-check-label', key: 'l' }, c.name),
                          c.detail ? h('div', { className: 'qq-check-detail', key: 'x' }, c.detail) : null,
                        ]),
                        h('span', { className: 'qq-check-flag', key: 'f' }, c.ok ? '正常' : '需处理'),
                      ])))
                : h('p', { className: 'qq-muted', key: 'e' }, '本次没有返回检测项。'),
              hints.length
                ? h('ul', { className: 'qq-hints', key: 'hints' },
                    hints.map((t, i) => h('li', { key: `h${i}` }, String(t))))
                : null,
              diag.error ? h('p', { className: 'qq-error', key: 'er' }, String(diag.error)) : null,
            ])
          : h('div', { className: 'qq-empty', key: 'e' }, [
              h('span', { className: 'qq-empty-icon', key: 'i', 'aria-hidden': 'true' }, '🩺'),
              h('span', { className: 'qq-muted', key: 't' },
                '还没有运行过诊断。点「运行诊断」开始逐项排查连接问题。'),
            ]),
        h('div', { className: 'qq-log-head', key: 'lh' }, [
          h('span', { className: 'qq-muted', key: 't' }, '最近日志'),
          h(Button, { key: 'c', ghost: true, onClick: () => state.action('clearLog') }, '清空'),
        ]),
        h('div', { className: 'qq-log', key: 'log' },
          ((state.status && state.status.log) || []).length
            ? (state.status.log).slice().reverse().map((line) => h('div', {
                className: 'qq-log-line', key: line.at + ':' + line.message,
              }, [
                h('span', { className: 'qq-log-time', key: 't' }, new Date(line.at).toLocaleTimeString()),
                h('span', { className: 'qq-log-msg', key: 'm' }, line.message),
              ]))
            : h('span', { className: 'qq-muted' }, '暂无日志')),
      ]);
    }

    // ---------- 记忆 ----------

    function MemoryPanel({ state }) {
      const mem = state.status && state.status.memory;
      const [open, setOpen] = React.useState('');
      const [facts, setFacts] = React.useState([]);
      const [loading, setLoading] = React.useState('');

      if (!mem) return h(Card, { title: '长期记忆', icon: '🧠' },
        h('p', { className: 'qq-muted' }, '记忆功能未启用（或状态尚未加载）。'));

      const senders = Array.isArray(mem.senders) ? mem.senders : [];
      const senderCount = Array.isArray(mem.senders) ? senders.length : (mem.senders || 0);

      const toggle = async (key) => {
        if (open === key) {
          setOpen('');
          setFacts([]);
          return;
        }
        setOpen(key);
        setLoading(key);
        try {
          const data = await call(`/memory-facts?key=${encodeURIComponent(key)}`);
          setFacts(data.facts || []);
        } catch (err) {
          setFacts([]);
        } finally {
          setLoading('');
        }
      };

      const refreshOpen = async (key) => {
        try {
          const data = await call(`/memory-facts?key=${encodeURIComponent(key)}`);
          setFacts(data.facts || []);
        } catch (err) {
          setFacts([]);
        }
      };

      return h(Card, {
        title: '长期记忆', icon: '🧠',
        extra: h('div', { className: 'qq-row', key: 'x' }, [
          h(Button, {
            key: 's', ghost: true, disabled: state.busy === 'memSave',
            loading: state.busy === 'memSave', onClick: () => state.action('memSave'),
          }, '立即保存'),
          h(Button, {
            key: 'c', ghost: true, danger: true,
            disabled: state.busy === 'memClearAll',
            loading: state.busy === 'memClearAll', onClick: () => state.action('memClearAll'),
          }, '清空全部'),
        ]),
      }, [
        h('div', { className: 'qq-row', key: 'stats' }, [
          h(Pill, { key: 'on', kind: mem.enabled ? 'ok' : 'warn' }, mem.enabled ? '已启用' : '已关闭'),
          h('span', { className: 'qq-muted', key: 'n' }, `记住了 ${senderCount} 个会话 / ${mem.facts || 0} 条信息`),
          mem.maxHistory > 0
            ? h('span', { className: 'qq-muted', key: 'h' },
              `上下文 ${mem.turns || 0} 轮（每会话最多 ${mem.maxHistory}，静默 ${Math.round((mem.historyTtlMs || 0) / 60000)} 分钟重置）`)
            : null,
          mem.file ? h('span', { className: 'qq-muted', key: 'f' }, `文件：${mem.file}`)
            : h('span', { className: 'qq-muted', key: 'nf' }, '未配置持久化文件（重启后丢失）'),
          mem.lastError ? h('span', { className: 'qq-error', key: 'e' }, mem.lastError) : null,
        ]),
        senders.length === 0
          ? h('p', { className: 'qq-muted', key: 'empty' },
            '还没有任何记忆。用户说「我叫小明」这类话时会自动记住；也可以在 QQ 里发「我的记忆」查看。')
          : h('div', { className: 'qq-mem-list', key: 'list' },
              senders.map((row) => h('div', { className: 'qq-mem-row', key: row.key }, [
                h('button', {
                  type: 'button', className: 'qq-mem-head',
                  onClick: () => toggle(row.key),
                }, [
                  h('span', { className: 'qq-mem-key', key: 'k' }, row.key),
                  h('span', { className: 'qq-muted', key: 'c' }, `${row.facts} 条`),
                  row.turns > 0 ? h('span', { className: 'qq-muted', key: 't' }, `${row.turns} 轮上下文`) : null,
                  h('span', { className: 'qq-muted', key: 'p' }, row.preview),
                  h('span', { className: 'qq-mem-caret', key: 'x' }, open === row.key ? '▾' : '▸'),
                ]),
                open === row.key
                  ? h('div', { className: 'qq-mem-body', key: 'b' }, [
                      loading === row.key
                        ? h('span', { className: 'qq-muted' }, '加载中…')
                        : facts.length === 0
                          ? h('span', { className: 'qq-muted' }, '（空）')
                          : h('ul', { className: 'qq-mem-facts' },
                              facts.map((f, i) => h('li', { key: `${i}:${f}` }, [
                                h('span', { key: 't' }, f),
                                h('button', {
                                  key: 'd', type: 'button', className: 'qq-btn-ghost qq-btn-xs',
                                  title: '删除这条',
                                  onClick: () => state.action('memForget', { key: row.key, fact: f }).then(() => toggle(row.key).then(() => toggle(row.key))),
                                }, '删除'),
                              ]))),
                      h('div', { className: 'qq-row', key: 'acts' }, [
                        h(Button, {
                          key: 'nt', ghost: true, disabled: state.busy === 'memNewTopic',
                          loading: state.busy === 'memNewTopic',
                          onClick: () => state.action('memNewTopic', { key: row.key }).then(() => refreshOpen(row.key)),
                        }, '换个话题（清上下文）'),
                        h(Button, {
                          key: 'del', ghost: true, danger: true,
                          onClick: () => state.action('memForget', { key: row.key }).then(() => { setOpen(''); setFacts([]); }),
                        }, '清除这个会话的记忆'),
                      ]),
                    ])
                  : null,
              ]))),
        h('p', { className: 'qq-muted', key: 'tip' },
          '私聊与群聊的记忆互相隔离。QQ 里可发 /help /status /new /memory /forget；修改 cordis.patch.yml 的 memory.file 可以把记忆写到磁盘，重启后仍然记得。'),
      ]);
    }

    // ---------- 配置 ----------

    function ConfigPanel({ state }) {
      const s = state.status;
      if (!s) return h(Card, { title: '当前配置（只读）', icon: '⚙️' },
        h('p', { className: 'qq-muted' }, '状态尚未加载。'));
      const trigger = s.trigger || {};
      const allow = s.allow || {};
      return h(Card, { title: '当前配置（只读）', icon: '⚙️' }, [
        h('dl', { className: 'qq-dl' }, [
          h('dt', { key: 'd1' }, '私聊'),
          h('dd', { key: 'v1' }, trigger.privateAlways ? '全部响应' : '不响应'),
          h('dt', { key: 'd2' }, '群消息'),
          h('dd', { key: 'v2' }, trigger.groupRequiresAt
            ? `需要 @机器人${trigger.prefix ? ` 或前缀 "${trigger.prefix}"` : ''}`
            : '全部响应'),
          h('dt', { key: 'd3' }, '群白名单'),
          h('dd', { key: 'v3' }, allow.groups && allow.groups.length ? allow.groups.join(', ') : '不限制'),
          h('dt', { key: 'd4' }, '用户白名单'),
          h('dd', { key: 'v4' }, allow.users && allow.users.length ? allow.users.join(', ') : '不限制'),
          h('dt', { key: 'd5' }, '黑名单'),
          h('dd', { key: 'v5' }, allow.denyUsers && allow.denyUsers.length ? allow.denyUsers.join(', ') : '无'),
        ]),
        h('p', { className: 'qq-muted', key: 'm' },
          '配置在插件包的 cordis.patch.yml 中修改；改完后在插件管理里关闭再启用本插件即可生效（本地目录安装不会热更新）。'),
      ]);
    }

    // ---------- panel root ----------

    function QqBotPanel({ compact }) {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [qrUrl, setQrUrl] = React.useState('');
      const [qrStamp, setQrStamp] = React.useState(0);
      const [testResult, setTestResult] = React.useState(null);
      const [diagnose, setDiagnose] = React.useState(null);
      const alive = React.useRef(true);

      const refresh = React.useCallback(async () => {
        try {
          const data = await bridge('/status');
          if (!alive.current) return;
          setStatus(data);
          setError('');
        } catch (err) {
          if (!alive.current) return;
          setError(err.message || String(err));
        }
      }, []);

      React.useEffect(() => {
        alive.current = true;
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [refresh]);

      const action = React.useCallback(async (name, payload) => {
        setBusy(name);
        setNotice('');
        try {
          if (name === 'newQr') {
            const result = await call('/qr');
            if (result.logined) {
              setQrUrl('');
              setNotice(`该 NapCat 已经登录${result.uin ? `（QQ ${result.uin}）` : ''}`);
            } else {
              setQrUrl(result.qr.url);
              setQrStamp(Date.now());
              setNotice('请用手机 QQ 扫码；约 115 秒后失效。');
            }
          } else if (name === 'link') {
            const result = await call('/link');
            setNotice(result.added ? '已新增接入到 NapCat' : '已更新 NapCat 中的接入');
          } else if (name === 'send') {
            await post('/send', payload);
            setNotice('已发送。');
            refresh();
          } else if (name === 'llmTest') {
            const result = await call('/llm-test');
            setTestResult(result);
          } else if (name === 'diagnose') {
            const result = await call('/diagnose');
            setDiagnose(result);
          } else if (name === 'resetStats') {
            await call('/stats-reset');
            refresh();
          } else if (name === 'clearLog') {
            await call('/log-clear');
            refresh();
          } else if (name === 'memSave') {
            const result = await call('/memory-save');
            setNotice(result.ok ? '记忆已写入磁盘。' : `保存失败：${result.error || '未知错误'}`);
            refresh();
          } else if (name === 'memForget') {
            await post('/memory-forget', payload);
            setNotice('已删除。');
            refresh();
          } else if (name === 'memClearAll') {
            await post('/memory-forget', { scope: 'all' });
            setNotice('已清空全部记忆。');
            refresh();
          } else if (name === 'memNewTopic') {
            await post('/memory-newtopic', payload);
            setNotice('已清空该会话的对话上下文（长期记忆保留）。');
            refresh();
          } else if (name === 'napInstall') {
            const result = await call('/napcat-install');
            setNotice(result.started ? '已在后台开始下载安装，下方会显示进度。' : `无法开始：${result.error || '未知错误'}`);
            refresh();
          } else if (name === 'napLaunch') {
            const result = await call('/napcat-launch');
            const hint = result.hint ? ` ${result.hint}` : '';
            setNotice(result.ok
              ? `${result.phase === 'bootstrap' ? '已启动 NapCat 安装器' : '已启动 NapCat 运行时'}（pid=${result.pid}）。${hint}`
              : `启动失败：${result.error || '未知错误'}`);
            refresh();
          }
        } catch (err) {
          setNotice(`失败：${err.message || String(err)}`);
          if (name === 'llmTest') setTestResult({ ok: false, error: err.message });
          if (name === 'diagnose') setDiagnose({ error: err.message || String(err), checks: [], hints: [] });
        } finally {
          setBusy('');
        }
      }, [refresh]);

      const state = { status, error, busy, notice, qrUrl, qrStamp, testResult, diagnose, action, refresh };
      const connected = Boolean(status && status.connections > 0);
      const s = status || {};
      const llm = s.llm || {};
      const nap = s.napcat || {};
      const mem = s.memory || {};
      const rt = s.napcatRuntime || {};

      // Hero status-pill row: 连接 / 模型 / NapCat / 记忆
      const heroPills = h('div', { className: 'qq-hero-pills' }, [
        h(Pill, { key: 'c', kind: connected ? 'ok' : 'warn' },
          connected ? `● 连接 ${s.connections}` : '○ 未连接'),
        h(Pill, { key: 'm', kind: (llm.mode === 'external' && !llm.hasKey) ? 'warn' : (llm.model ? 'info' : 'neutral') },
          llm.mode === 'external' ? `模型 · 外部 ${llm.model || '未配置'}` : `模型 · ${llm.model || 'Harness'}`),
        h(Pill, { key: 'n', kind: rt.running ? 'ok' : 'warn' },
          rt.running ? 'NapCat · 在线' : `NapCat · ${rt.installed ? '未启动' : (nap.configured ? '未连接' : '未安装')}`),
        h(Pill, { key: 'r', kind: mem.enabled ? 'ok' : 'neutral' },
          mem.enabled ? `记忆 · ${mem.facts || 0} 条` : '记忆 · 关闭'),
      ]);

      if (compact) {
        return h('div', { className: 'qq-panel qq-panel-compact' }, [
          h('div', { className: 'qq-compact-head', key: 'h' }, [
            h(HeroMark, { key: 'm' }),
            h('div', { className: 'qq-compact-titles', key: 't' }, [
              h('strong', { key: 'n' }, 'QQ 机器人'),
              h('span', { className: 'qq-muted', key: 's' }, connected ? '运行中 · 已连接' : '等待 NapCat 连接'),
            ]),
            h(Pill, { key: 'p', kind: connected ? 'ok' : 'warn' }, connected ? '已连接' : '未连接'),
          ]),
          error ? h('p', { className: 'qq-error', key: 'e' }, error) : null,
          heroPills,
          h('div', { className: 'qq-compact-stats', key: 'st' }, [
            h('span', { key: 'a' }, `连接 ${status ? status.connections : '—'}`),
            h('span', { key: 'b' }, `接收 ${(s.stats && s.stats.received) || 0}`),
            h('span', { key: 'c' }, `回复 ${(s.stats && s.stats.answered) || 0}`),
            h('span', { key: 'd' }, `失败 ${(s.stats && s.stats.failed) || 0}`),
          ]),
          h('div', { className: 'qq-row', key: 'b' }, [
            h(Button, { key: 'r', ghost: true, onClick: refresh }, '刷新'),
            h(Button, {
              key: 'd', ghost: true, disabled: busy === 'diagnose', loading: busy === 'diagnose',
              onClick: () => action('diagnose'),
            }, '运行诊断'),
          ]),
          notice ? h('p', { className: 'qq-notice', key: 'n' }, notice) : null,
          diagnose
            ? h('div', { className: 'qq-compact-diag', key: 'dg' }, [
                h('span', { className: 'qq-muted', key: 't' }, '诊断结果'),
                ((diagnose.checks || diagnose.results || [])).slice(0, 4).map((c, i) =>
                  h('span', { className: 'qq-compact-check', key: `c${i}` }, [
                    h(Dot, { key: 'd', tone: c.ok ? 'ok' : 'err' }),
                    h('span', { key: 'l' }, c.name || c.label || c.id),
                  ])),
              ])
            : null,
        ]);
      }

      return h('div', { className: 'qq-panel' }, [
        h('header', { className: 'qq-hero', key: 'hero' }, [
          h(HeroMark, { key: 'm' }),
          h('div', { className: 'qq-hero-titles', key: 't' }, [
            h('h2', { key: 'n' }, 'QQ 机器人'),
            h('p', { key: 's' }, '连接 NapCat，让 Harness 模型在 QQ 里替你自动回复'),
          ]),
          h('div', { className: 'qq-hero-status', key: 'st' }, [
            h('span', { className: `qq-status qq-status-${connected ? 'ok' : 'idle'}` }, [
              h('span', { className: 'qq-status-dot', key: 'd' }),
              h('span', { key: 'l' }, connected ? '已连接' : '未连接'),
            ]),
          ]),
          heroPills,
        ]),
        error
          ? h('div', { className: 'qq-banner qq-banner-err', key: 'err' }, [
              h('span', { key: 'm' }, `${error} · 请确认插件已启用且 /api/qq-bot/* 路由已注册（重新启用插件后再试）。`),
              h(Button, { key: 'r', ghost: true, onClick: refresh }, '重试'),
            ])
          : null,
        (!status && !error) ? h('p', { className: 'qq-muted qq-loading', key: 'ld' }, '正在加载状态…') : null,
        h('div', { className: 'qq-sections', key: 'sections' }, [
          h(Section, {
            key: 'sec-connect', icon: '🔌', title: '连接与登录',
            desc: '运行状态、扫码登录与一键接入反向 WebSocket',
          }, [
            h(StatusPanel, { key: 'status', state }),
            h(LoginPanel, { key: 'login', state }),
          ]),
          h(Section, {
            key: 'sec-nap', icon: '🐱', title: 'NapCat 运行时',
            desc: '在本机安装、启动 NapCat 并查看安装进度',
          }, h(InstallPanel, { key: 'install', state })),
          h(Section, {
            key: 'sec-test', icon: '🧪', title: '测试与诊断',
            desc: '发一条消息试试、跑一次连接自检',
          }, [
            h(SendPanel, { key: 'send', state }),
            h(DiagPanel, { key: 'diag', state }),
          ]),
          h(Section, {
            key: 'sec-mem', icon: '🧠', title: '记忆',
            desc: '机器人记住的长期信息与对话上下文',
          }, h(MemoryPanel, { key: 'memory', state })),
          h(Section, {
            key: 'sec-cfg', icon: '⚙️', title: '配置',
            desc: '当前生效的触发与白名单规则（只读）',
          }, h(ConfigPanel, { key: 'config', state })),
        ]),
        notice ? h('div', { className: 'qq-toast', key: 'toast' }, notice) : null,
      ]);
    }

    /** Compact one-line summary rendered on the plugin list rows. */
    function SummaryText() {
      const [text, setText] = React.useState('QQ 机器人通道');
      React.useEffect(() => {
        let alive = true;
        bridge('/status').then((data) => {
          if (!alive) return;
          const conn = data.connections > 0 ? `已连接 ${data.connections}` : '未连接';
          const login = data.selfIds && data.selfIds.length ? '已登录' : '未登录';
          setText(`QQ 机器人 · ${conn} · ${login}`);
        }).catch(() => { /* keep the default label */ });
        return () => { alive = false; };
      }, []);
      return h('span', { className: 'qq-summary' }, text);
    }

    const STYLE_ID = 'qq-bot-panel-style';
    const CSS = [
      '.qq-panel{--qq-line:color-mix(in srgb,currentColor 13%,transparent);--qq-line-soft:color-mix(in srgb,currentColor 8%,transparent);--qq-fill:color-mix(in srgb,currentColor 4%,transparent);--qq-fill-soft:color-mix(in srgb,currentColor 2%,transparent);--qq-a1:#6366f1;--qq-a2:#a855f7;--qq-a3:#ec4899;--qq-ok:#22c55e;--qq-warn:#f59e0b;--qq-err:#ef4444;--qq-info:#38bdf8;--qq-r:16px;--qq-grad:linear-gradient(135deg,var(--qq-a1),var(--qq-a2) 58%,var(--qq-a3));display:grid;gap:22px;padding:24px;max-width:1120px;margin:0 auto;color:inherit;font-size:14px;line-height:1.55}',
      '.qq-panel *{box-sizing:border-box}',
      '.qq-panel a{color:inherit}',
      '.qq-panel code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}',
      '.qq-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.qq-muted{opacity:.62;font-size:12px;margin:0}',
      '.qq-error{color:var(--qq-err);font-size:13px;margin:0}',
      '.qq-ok{color:var(--qq-ok);font-size:13px;margin:0}',
      /* hero */
      '.qq-hero{position:relative;display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:22px 24px;border-radius:20px;border:1px solid var(--qq-line-soft);background:radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--qq-a1) 20%,transparent),transparent 55%),radial-gradient(100% 120% at 100% 0%,color-mix(in srgb,var(--qq-a3) 16%,transparent),transparent 52%),var(--qq-fill-soft);box-shadow:0 1px 2px rgba(0,0,0,.05),0 18px 44px rgba(0,0,0,.10);overflow:hidden}',
      '.qq-hero:before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(120deg,color-mix(in srgb,currentColor 3%,transparent),transparent 40%)}',
      '.qq-hero-mark{display:grid;place-items:center;width:64px;height:64px;flex:0 0 64px;border-radius:20px;background:var(--qq-grad);box-shadow:0 10px 26px color-mix(in srgb,var(--qq-a1) 42%,transparent),inset 0 1px 0 rgba(255,255,255,.4);position:relative;z-index:1}',
      '.qq-hero-titles{display:grid;gap:3px;min-width:0;flex:1 1 260px;position:relative;z-index:1}',
      '.qq-hero-titles h2{margin:0;font-size:22px;font-weight:750;letter-spacing:.3px}',
      '.qq-hero-titles p{margin:0;font-size:13px;opacity:.62}',
      '.qq-hero-status{flex:0 0 auto;position:relative;z-index:1}',
      '.qq-status{display:inline-flex;align-items:center;gap:9px;padding:7px 15px;border-radius:999px;font-size:13px;font-weight:650;border:1px solid var(--qq-line);background:var(--qq-fill)}',
      '.qq-status-dot{width:8px;height:8px;border-radius:50%;background:var(--qq-warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-warn) 22%,transparent)}',
      '.qq-status-ok .qq-status-dot{background:var(--qq-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-ok) 22%,transparent);animation:qq-pulse 2.4s ease-in-out infinite}',
      '@keyframes qq-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      '.qq-hero-pills{display:flex;gap:8px;flex-wrap:wrap;width:100%;padding-top:16px;margin-top:4px;border-top:1px solid var(--qq-line-soft);position:relative;z-index:1}',
      /* banner / toast / notice */
      '.qq-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-radius:12px;font-size:13px;border:1px solid color-mix(in srgb,var(--qq-err) 35%,transparent);background:color-mix(in srgb,var(--qq-err) 9%,transparent)}',
      '.qq-loading{margin:0}',
      '.qq-notice{margin:0;padding:10px 14px;border-radius:11px;font-size:13px;background:color-mix(in srgb,var(--qq-a1) 12%,transparent);border:1px solid color-mix(in srgb,var(--qq-a1) 28%,transparent)}',
      '.qq-toast{position:sticky;bottom:14px;justify-self:center;padding:11px 20px;border-radius:999px;font-size:13px;font-weight:600;background:color-mix(in srgb,currentColor 8%,transparent);border:1px solid var(--qq-line);box-shadow:0 10px 30px rgba(0,0,0,.18);backdrop-filter:blur(12px)}',
      /* sections + responsive grid */
      '.qq-sections{display:grid;gap:26px}',
      '.qq-section{display:grid;gap:14px}',
      '.qq-section-head{display:flex;align-items:center;gap:12px}',
      '.qq-section-icon{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border-radius:11px;font-size:17px;background:var(--qq-fill);border:1px solid var(--qq-line-soft)}',
      '.qq-section-titles{display:grid;gap:1px;min-width:0}',
      '.qq-section-titles h3{margin:0;font-size:15px;font-weight:700;letter-spacing:.2px}',
      '.qq-section-titles p{margin:0;font-size:12px;opacity:.58}',
      '.qq-section-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start}',
      /* cards */
      '.qq-card{border:1px solid var(--qq-line);border-radius:var(--qq-r);background:color-mix(in srgb,currentColor 2%,transparent);box-shadow:0 1px 2px rgba(0,0,0,.04),0 10px 30px rgba(0,0,0,.06);overflow:hidden;transition:box-shadow .22s ease,border-color .22s ease,transform .22s ease;backdrop-filter:blur(6px)}',
      '.qq-card:hover{box-shadow:0 2px 4px rgba(0,0,0,.05),0 16px 38px rgba(0,0,0,.11);border-color:color-mix(in srgb,var(--qq-a1) 30%,var(--qq-line));transform:translateY(-2px)}',
      '.qq-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--qq-line-soft);background:linear-gradient(180deg,color-mix(in srgb,currentColor 4%,transparent),transparent)}',
      '.qq-card-title{margin:0;font-size:14px;font-weight:700;letter-spacing:.2px;display:flex;align-items:center;gap:9px}',
      '.qq-card-icon{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;font-size:13px;background:color-mix(in srgb,var(--qq-a1) 16%,transparent)}',
      '.qq-card-extra{display:flex;align-items:center;gap:8px}',
      '.qq-card-body{padding:16px 18px;display:grid;gap:13px}',
      /* buttons */
      '.qq-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid transparent;border-radius:11px;padding:9px 16px;font-size:13px;font-weight:650;cursor:pointer;background:var(--qq-grad);color:#fff;box-shadow:0 4px 14px color-mix(in srgb,var(--qq-a1) 34%,transparent);transition:transform .16s ease,box-shadow .16s ease,filter .16s ease,background .16s ease,opacity .16s ease;white-space:nowrap;line-height:1.3}',
      '.qq-btn:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.07);box-shadow:0 8px 20px color-mix(in srgb,var(--qq-a1) 44%,transparent)}',
      '.qq-btn:active:not(:disabled){transform:translateY(0)}',
      '.qq-btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none;filter:saturate(.6)}',
      '.qq-btn-ghost{background:transparent;color:inherit;border-color:var(--qq-line);box-shadow:none}',
      '.qq-btn-ghost:hover:not(:disabled){background:var(--qq-fill);box-shadow:none;filter:none}',
      '.qq-btn-danger{background:linear-gradient(135deg,#f87171,var(--qq-err));color:#fff;box-shadow:0 4px 14px color-mix(in srgb,var(--qq-err) 28%,transparent)}',
      '.qq-btn-ghost.qq-btn-danger{background:transparent;color:var(--qq-err);border-color:color-mix(in srgb,var(--qq-err) 42%,transparent);box-shadow:none}',
      '.qq-btn-ghost.qq-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--qq-err) 10%,transparent)}',
      '.qq-spinner{width:13px;height:13px;flex:0 0 13px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;animation:qq-spin .7s linear infinite}',
      '@keyframes qq-spin{to{transform:rotate(360deg)}}',
      '.qq-btn-xs{padding:3px 9px;font-size:11px;border-radius:7px;border:1px solid var(--qq-line)}',
      /* pills */
      '.qq-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:650;background:var(--qq-fill);border:1px solid var(--qq-line-soft);white-space:nowrap}',
      '.qq-pill-ok{color:var(--qq-ok);background:color-mix(in srgb,var(--qq-ok) 13%,transparent);border-color:color-mix(in srgb,var(--qq-ok) 30%,transparent)}',
      '.qq-pill-warn{color:var(--qq-warn);background:color-mix(in srgb,var(--qq-warn) 13%,transparent);border-color:color-mix(in srgb,var(--qq-warn) 30%,transparent)}',
      '.qq-pill-err{color:var(--qq-err);background:color-mix(in srgb,var(--qq-err) 13%,transparent);border-color:color-mix(in srgb,var(--qq-err) 30%,transparent)}',
      '.qq-pill-info{color:var(--qq-info);background:color-mix(in srgb,var(--qq-info) 13%,transparent);border-color:color-mix(in srgb,var(--qq-info) 30%,transparent)}',
      '.qq-pill-neutral{color:inherit;opacity:.8}',
      /* fields / inputs */
      '.qq-field{display:grid;gap:6px;font-size:13px;min-width:0;flex:1 1 150px}',
      '.qq-field label{opacity:.62;font-size:12px;font-weight:600}',
      '.qq-field-c{min-width:0}',
      '.qq-input{width:100%;border:1px solid var(--qq-line);border-radius:10px;padding:9px 11px;background:var(--qq-fill-soft);color:inherit;font-size:13px;outline:none;transition:border-color .16s ease,box-shadow .16s ease}',
      '.qq-input:focus{border-color:color-mix(in srgb,var(--qq-a1) 65%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-a1) 16%,transparent)}',
      '.qq-dl{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;margin:0;font-size:13px}',
      '.qq-dl dt{opacity:.6}.qq-dl dd{margin:0;word-break:break-all}',
      /* status tiles + kv */
      '.qq-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
      '.qq-stat{display:grid;gap:3px;padding:14px;border-radius:13px;border:1px solid var(--qq-line-soft);background:linear-gradient(150deg,var(--qq-fill),transparent);box-shadow:0 1px 2px rgba(0,0,0,.04);transition:transform .18s ease,box-shadow .18s ease}',
      '.qq-stat:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.10)}',
      '.qq-stat-label{font-size:11px;opacity:.58}',
      '.qq-stat-value{font-size:25px;font-weight:750;line-height:1.2;font-variant-numeric:tabular-nums;letter-spacing:.5px}',
      '.qq-stat-ok{color:var(--qq-ok)}.qq-stat-err{color:var(--qq-err)}',
      '.qq-kv-list{display:grid;gap:2px}',
      '.qq-kv{display:grid;grid-template-columns:104px minmax(0,1fr);gap:6px 14px;align-items:start;font-size:13px;padding:4px 0}',
      '.qq-kv-k{opacity:.58}',
      '.qq-kv-v{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}',
      /* QR */
      '.qq-qr-wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap}',
      '.qq-qr{display:grid;place-items:center;width:196px;height:196px;flex:0 0 196px;background:#fff;border-radius:16px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.14),inset 0 0 0 1px rgba(0,0,0,.06);border:1px solid var(--qq-line-soft);position:relative;overflow:hidden}',
      '.qq-qr-img{width:172px;height:172px;image-rendering:pixelated}',
      '.qq-qr-empty{font-size:64px;color:#cbd5e1;line-height:1}',
      '.qq-qr-side{display:grid;gap:9px;flex:1 1 160px;min-width:0}',
      '.qq-qr-lead{margin:0;font-size:14px;font-weight:650}',
      '.qq-codebox{padding:11px 14px;border-radius:11px;border:1px dashed var(--qq-line);background:var(--qq-fill);overflow:auto}',
      '.qq-link{font-size:13px;font-weight:650;text-decoration:none;opacity:.8;transition:opacity .16s ease}.qq-link:hover{opacity:1;text-decoration:underline}',
      '.qq-hints{margin:0;padding-left:20px;display:grid;gap:4px;font-size:12px;opacity:.72}',
      /* install job */
      '.qq-job{padding:11px 13px;border-radius:11px;border:1px solid var(--qq-line-soft);background:var(--qq-fill);display:grid;gap:6px}',
      /* diagnostics */
      '.qq-diag{display:grid;gap:11px}',
      '.qq-diag-summary{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.qq-check-list{display:grid;gap:8px}',
      '.qq-check{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:11px;align-items:center;padding:11px 13px;border-radius:12px;border:1px solid var(--qq-line-soft);background:var(--qq-fill-soft);transition:border-color .16s ease,background .16s ease}',
      '.qq-check:hover{border-color:var(--qq-line)}',
      '.qq-check-sym{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;font-size:12px;font-weight:800;color:#fff;background:var(--qq-ok)}',
      '.qq-check-bad{background:color-mix(in srgb,var(--qq-err) 6%,transparent);border-color:color-mix(in srgb,var(--qq-err) 24%,transparent)}',
      '.qq-check-bad .qq-check-sym{background:var(--qq-err)}',
      '.qq-check-main{display:grid;gap:2px;min-width:0}',
      '.qq-check-label{font-size:13px;font-weight:650}',
      '.qq-check-detail{font-size:12px;opacity:.7;word-break:break-word}',
      '.qq-check-flag{font-size:11px;font-weight:650;opacity:.5;white-space:nowrap}',
      '.qq-empty{display:grid;gap:8px;justify-items:center;padding:26px 10px;text-align:center;border:1px dashed var(--qq-line);border-radius:12px;background:var(--qq-fill-soft)}',
      '.qq-empty-icon{font-size:26px;opacity:.4}',
      '.qq-log-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.qq-log{max-height:220px;overflow:auto;font-size:12px;display:grid;gap:3px;background:var(--qq-fill);border-radius:11px;padding:10px 12px;border:1px solid var(--qq-line-soft)}',
      '.qq-log-line{display:grid;grid-template-columns:78px 1fr;gap:10px;padding:2px 0}',
      '.qq-log-time{opacity:.48}',
      '.qq-log-msg{word-break:break-word}',
      /* dots (compact diag) */
      '.qq-dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}',
      '.qq-dot-ok{background:var(--qq-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-ok) 20%,transparent)}',
      '.qq-dot-warn{background:var(--qq-warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-warn) 20%,transparent)}',
      '.qq-dot-err{background:var(--qq-err);box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-err) 20%,transparent)}',
      '.qq-dot-neutral{background:currentColor;opacity:.4}',
      /* memory */
      '.qq-mem-list{display:grid;gap:8px}',
      '.qq-mem-row{border:1px solid var(--qq-line-soft);border-radius:12px;overflow:hidden;background:var(--qq-fill-soft)}',
      '.qq-mem-head{display:grid;grid-template-columns:auto auto 1fr auto;gap:12px;align-items:center;width:100%;text-align:left;background:transparent;border:0;color:inherit;font-size:13px;padding:11px 13px;cursor:pointer;transition:background .16s ease}',
      '.qq-mem-head:hover{background:var(--qq-fill)}',
      '.qq-mem-key{font-weight:650}',
      '.qq-mem-caret{opacity:.6}',
      '.qq-mem-body{padding:11px 13px;border-top:1px solid var(--qq-line-soft);display:grid;gap:10px}',
      '.qq-mem-facts{margin:0;padding-left:18px;display:grid;gap:5px;font-size:13px}',
      '.qq-mem-facts li{display:flex;gap:10px;align-items:center;justify-content:space-between}',
      /* summary + compact */
      '.qq-summary{font-size:12px;opacity:.8}',
      '.qq-panel-compact{gap:13px;padding:16px;max-width:none}',
      '.qq-compact-head{display:flex;align-items:center;gap:12px}',
      '.qq-compact-head .qq-hero-mark{width:44px;height:44px;flex:0 0 44px;border-radius:14px}',
      '.qq-compact-head .qq-hero-mark svg{width:26px;height:26px}',
      '.qq-compact-titles{display:grid;gap:2px;flex:1;min-width:0}',
      '.qq-compact-titles strong{font-size:15px}',
      '.qq-panel-compact .qq-hero-pills{padding-top:0;margin-top:0;border-top:0}',
      '.qq-compact-stats{display:flex;gap:8px;flex-wrap:wrap}',
      '.qq-compact-stats span{padding:4px 10px;border-radius:8px;font-size:12px;background:var(--qq-fill);border:1px solid var(--qq-line-soft)}',
      '.qq-compact-diag{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:10px 12px;border-radius:10px;border:1px solid var(--qq-line-soft);background:var(--qq-fill-soft);font-size:12px}',
      '.qq-compact-check{display:inline-flex;align-items:center;gap:6px}',
      '@media(max-width:720px){.qq-panel{padding:14px;gap:16px}.qq-hero{padding:16px}.qq-section-grid{grid-template-columns:1fr}.qq-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.qq-kv{grid-template-columns:1fr;gap:2px}.qq-qr-wrap{justify-content:center}.qq-hero-pills{gap:6px}}',
    ].join('\n');

    function mountStyle() {
      if (typeof document === 'undefined') return () => {};
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
      }
      return () => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const unmountStyle = mountStyle();
        ctx.effect(() => () => { unmountStyle(); }, 'qq-bot: panel style');

        const slots = ctx.slots;

        // Each seat is registered independently: an unsupported slot key must
        // not take down the whole module.
        const safe = (slotKey, reg, render) => {
          try {
            slots.inject(slotKey, () => slots.register(reg, render));
          } catch (err) {
            if (typeof console !== 'undefined') {
              console.warn(`[qq-bot] 无法注册 slot ${slotKey}:`, err);
            }
          }
        };

        const panel = (slotProps) => (slotProps && slotProps.view === 'summary'
          ? h(SummaryText, {})
          : h(QqBotPanel, { compact: true }));

        // Plugin page seats. Keys follow dsh-free-search: bundle seat is keyed
        // by package name, row seat by `<package name>#<row id>`.
        safe('plugins.bundle.config', { name: 'plugins.bundle.config', key: '@local/qq-bot' }, panel);
        safe('plugins.row.config', { name: 'plugins.row.config', key: '@local/qq-bot#qq-bot' }, panel);

        // Standalone panel: sidebar entry + central panel selected by its id.
        safe('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          label: () => 'QQ 机器人',
        }, () => h(Icon, {}));
        safe('main', { name: 'main', key: PANEL_ID }, () => h(QqBotPanel, {}));
      },
    };
  },
});
