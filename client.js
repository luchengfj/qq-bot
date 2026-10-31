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

    function Pill({ children, kind }) {
      return h('span', {
        className: 'qq-pill' + (kind ? ` qq-pill-${kind}` : ''),
      }, children);
    }

    function Card({ title, extra, children }) {
      return h('section', { className: 'qq-card' }, [
        h('header', { className: 'qq-card-head', key: 'h' }, [
          h('h3', { key: 't' }, title),
          extra ? h('div', { key: 'e', className: 'qq-card-extra' }, extra) : null,
        ]),
        h('div', { key: 'b', className: 'qq-card-body' }, children),
      ]);
    }

    function Field({ label, children }) {
      return h('div', { className: 'qq-field' }, [
        h('label', { key: 'l' }, label),
        h('div', { key: 'c' }, children),
      ]);
    }

    function Button({ onClick, disabled, children, ghost, danger }) {
      return h('button', {
        type: 'button',
        className: 'qq-btn' + (ghost ? ' qq-btn-ghost' : '') + (danger ? ' qq-btn-danger' : ''),
        onClick,
        disabled: Boolean(disabled),
      }, children);
    }

    // ---------- panels ----------

    function StatusPanel({ state, onRefresh }) {
      const s = state.status;
      if (state.error) {
        return h(Card, { title: 'QQ 机器人 · 状态', extra: h(Button, { onClick: onRefresh, ghost: true }, '重试') }, [
          h('p', { className: 'qq-error', key: 'e' }, state.error),
          h('p', { className: 'qq-muted', key: 'm' }, '请确认插件已启用，且 /api/qq-bot/* 路由已注册（重新启用插件后再试）。'),
        ]);
      }
      if (!s) return h(Card, { title: 'QQ 机器人 · 状态' }, h('span', { className: 'qq-muted' }, '加载中…'));

      const connected = s.connections > 0;
      return h(Card, {
        title: 'QQ 机器人 · 状态',
        extra: h(Button, { onClick: onRefresh, ghost: true }, '刷新'),
      }, [
        h('div', { className: 'qq-row', key: 'pills' }, [
          h(Pill, { key: 'c', kind: connected ? 'ok' : 'warn' },
            connected ? `OneBot 已连接 ${s.connections}` : '等待 NapCat 连接'),
          h(Pill, { key: 'q', kind: s.selfIds && s.selfIds.length ? 'ok' : 'warn' },
            s.selfIds && s.selfIds.length ? `已登录 QQ ${s.selfIds.join(', ')}` : '未登录 QQ'),
          h(Pill, { key: 'l', kind: s.llm.hasKey ? 'ok' : 'warn' },
            s.llm.hasKey ? `模型 ${s.llm.model}` : '未配置模型密钥'),
        ]),
        h('dl', { className: 'qq-dl', key: 'dl' }, [
          h('dt', { key: 'd1' }, '本插件端点'),
          h('dd', { key: 'v1' }, h('code', null, `${s.endpoint.host}:${s.endpoint.port}${s.endpoint.path}`)),
          h('dt', { key: 'd2' }, '反向 WS 地址'),
          h('dd', { key: 'v2' }, h('code', null, s.reverseUrl || '—')),
          h('dt', { key: 'd3' }, '独立控制台'),
          h('dd', { key: 'v3' }, h('a', { href: s.setupUrl, target: '_blank', rel: 'noreferrer' }, s.setupUrl)),
          h('dt', { key: 'd4' }, 'NapCat WebUI'),
          h('dd', { key: 'v4' }, h('span', null, [
            h('code', { key: 'u' }, s.napcat.baseUrl || '—'),
            s.napcat.hasToken ? null : h(Pill, { key: 't', kind: 'warn' }, '未填令牌'),
          ])),
          h('dt', { key: 'd5' }, '消息统计'),
          h('dd', { key: 'v5' },
            `收到 ${s.stats.received} · 已回复 ${s.stats.answered} · 失败 ${s.stats.failed}`),
        ]),
        s.stats.lastError
          ? h('p', { className: 'qq-error', key: 'err' }, `最近错误：${s.stats.lastError}`)
          : null,
      ]);
    }

    // Lets the user fetch + start NapCat without leaving Harness. Shown first
    // when no runtime is detected, since everything else depends on it.
    function InstallPanel({ state }) {
      const [open, setOpen] = React.useState(false);
      const rt = state.status && state.status.napcatRuntime;
      const job = rt && rt.job;
      if (!rt) return null;
      const steps = (job && job.steps) || [];
      return h(Card, { title: 'NapCat 运行时' }, [
        h('div', { className: 'qq-row', key: 'r1' }, [
          h(Pill, { key: 'p', ok: rt.installed }, rt.installed ? '已安装' : '未安装'),
          h(Pill, { key: 'p2', ok: rt.running }, rt.running ? 'WebUI 在线' : 'WebUI 未连接'),
          rt.busy ? h(Pill, { key: 'p3', ok: false }, `进行中：${rt.busy}`) : null,
        ]),
        h('p', { className: 'qq-muted', key: 'dir' }, `安装目录：${rt.dir}`),
        rt.launcher ? h('p', { className: 'qq-muted', key: 'ln' }, `启动器：${rt.launcher}`) : null,
        rt.configPath ? h('p', { className: 'qq-muted', key: 'cfg' }, `配置：${rt.configPath}`) : null,
        rt.lastError ? h('p', { className: 'qq-err', key: 'er' }, rt.lastError) : null,
        h('div', { className: 'qq-row', key: 'r2' }, [
          h(Button, {
            key: 'i', onClick: () => state.action('napInstall'),
            disabled: Boolean(state.busy),
          }, rt.installed ? '重新安装' : '下载并安装 NapCat'),
          h(Button, {
            key: 'l', ghost: true, onClick: () => state.action('napLaunch'),
            disabled: Boolean(state.busy) || !rt.installed,
          }, '启动 NapCat'),
        ]),
        job
          ? h('div', { className: 'qq-mem-body', key: 'job' }, [
              h('p', { className: 'qq-muted', key: 'st' }, `状态：${job.stage}${job.done ? '' : ' …'}`),
              steps.length
                ? h('ul', { className: 'qq-mem-facts', key: 'ul' },
                    steps.map((s, i) => h('li', { key: `s${i}` }, String(s))))
                : null,
              job.error ? h('p', { className: 'qq-err', key: 'je' }, String(job.error)) : null,
            ])
          : h('p', { className: 'qq-muted', key: 'idle' },
            '首次使用请先「下载并安装 NapCat」，然后「启动 NapCat」并扫码登录。'),
        void open,
      ]);
    }

    function LoginPanel({ state, setState }) {
      const s = state.status;
      const setup = s && s.setupUrl;
      return h(Card, { title: '扫码登录 + 一键接入' }, [
        h('div', { className: 'qq-row', key: 'row' }, [
          h(Button, { key: 'qr', onClick: () => state.action('newQr'), disabled: state.busy === 'newQr' }, '获取二维码'),
          h(Button, {
            key: 'rf', ghost: true, disabled: !state.qrUrl || state.busy === 'newQr',
            onClick: () => state.action('newQr'),
          }, '刷新二维码'),
          h(Button, { key: 'lk', onClick: () => state.action('link'), disabled: state.busy === 'link' }, '一键接入'),
        ]),
        h('div', { className: 'qq-qr', key: 'box' }, [
          state.qrUrl
            ? h('img', {
                key: 'img', className: 'qq-qr-img', alt: 'QQ 登录二维码',
                src: `${BRIDGE}/qr.svg?t=${state.qrStamp}`,
              })
            : h('span', { className: 'qq-muted', key: 'hint' }, '点击「获取二维码」，然后用手机 QQ 扫码'),
        ]),
        state.notice ? h('p', { className: 'qq-muted', key: 'n' }, state.notice) : null,
        h('p', { className: 'qq-muted', key: 'm' },
          '二维码由插件本地生成，不会上传到任何第三方服务。若无法生成，请确认 NapCat 已启动、端口正确，且 napcat.webuiToken 与 NapCat 的登录令牌一致。'),
        setup ? h('p', { className: 'qq-muted', key: 's' }, h('span', null, [
          '也可以使用独立控制台：',
          h('a', { href: setup, target: '_blank', rel: 'noreferrer' }, setup),
        ])) : null,
      ]);
      // setState is reserved for future controlled use inside the panel shell.
      void setState;
    }

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
      return h(Card, { title: '发送测试消息' }, [
        h('div', { className: 'qq-row', key: 'r1' }, [
          h(Field, { label: '类型', key: 't' }, [
            h('select', { className: 'qq-input', value: form.messageType, onChange: update('messageType') }, [
              h('option', { key: 'g', value: 'group' }, '群消息'),
              h('option', { key: 'p', value: 'private' }, '私聊消息'),
            ]),
          ]),
          form.messageType === 'private'
            ? h(Field, { label: 'QQ 号', key: 'u' },
                h('input', { className: 'qq-input', value: form.userId, onChange: update('userId'), placeholder: '如 10001' }))
            : h(Field, { label: '群号', key: 'g' },
                h('input', { className: 'qq-input', value: form.groupId, onChange: update('groupId'), placeholder: '如 123456' })),
        ]),
        h(Field, { label: '内容', key: 'c' },
          h('input', { className: 'qq-input', value: form.text, onChange: update('text'), placeholder: '要发送的文本' })),
        h(Button, { key: 'b', onClick: send, disabled: !valid || state.busy === 'send' }, '发送'),
      ]);
    }

    function DiagPanel({ state }) {
      const s = state.status;
      return h(Card, {
        title: '诊断',
        extra: h('div', { className: 'qq-row', key: 'x' }, [
          h(Button, { key: 't', ghost: true, disabled: state.busy === 'llmTest', onClick: () => state.action('llmTest') }, '测试模型接口'),
          h(Button, { key: 'r', ghost: true, onClick: () => state.action('resetStats') }, '清空统计'),
          h(Button, { key: 'c', ghost: true, onClick: () => state.action('clearLog') }, '清空日志'),
        ]),
      }, [
        state.testResult
          ? h('p', {
              key: 'tr', className: state.testResult.ok ? 'qq-ok' : 'qq-error',
            }, state.testResult.ok
              ? `模型接口正常（${state.testResult.ms} ms）：${state.testResult.reply}`
              : `模型接口异常：${state.testResult.error}`)
          : null,
        h('div', { className: 'qq-log', key: 'log' },
          (s && s.log && s.log.length)
            ? s.log.slice().reverse().map((line) => h('div', { className: 'qq-log-line', key: line.at + ':' + line.message }, [
                h('span', { className: 'qq-log-time', key: 't' }, new Date(line.at).toLocaleTimeString()),
                h('span', { className: 'qq-log-msg', key: 'm' }, line.message),
              ]))
            : h('span', { className: 'qq-muted' }, '暂无日志')),
      ]);
    }

    function ConfigPanel({ state }) {
      const s = state.status;
      if (!s) return null;
      const trigger = s.trigger || {};
      const allow = s.allow || {};
      return h(Card, { title: '当前配置（只读）' }, [
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

    /** Long-term memory: what the bot remembers about each sender. */
    function MemoryPanel({ state }) {
      const mem = state.status && state.status.memory;
      const [open, setOpen] = React.useState('');
      const [facts, setFacts] = React.useState([]);
      const [loading, setLoading] = React.useState('');

      if (!mem) return null;

      const senders = mem.senders || [];

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
        title: '长期记忆',
        extra: h('div', { className: 'qq-row', key: 'x' }, [
          h(Button, {
            key: 's', ghost: true, disabled: state.busy === 'memSave',
            onClick: () => state.action('memSave'),
          }, '立即保存'),
          h(Button, {
            key: 'c', ghost: true, className: 'qq-btn-danger',
            disabled: state.busy === 'memClearAll',
            onClick: () => state.action('memClearAll'),
          }, '清空全部'),
        ]),
      }, [
        h('div', { className: 'qq-row', key: 'stats' }, [
          h(Pill, { key: 'on', tone: mem.enabled ? 'ok' : 'warn' }, mem.enabled ? '已启用' : '已关闭'),
          h('span', { className: 'qq-muted', key: 'n' }, `记住了 ${mem.senders} 个会话 / ${mem.facts} 条信息`),
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
                          onClick: () => state.action('memNewTopic', { key: row.key }).then(() => refreshOpen(row.key)),
                        }, '换个话题（清上下文）'),
                        h(Button, {
                          key: 'del', ghost: true, className: 'qq-btn-danger',
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

    // ---------- panel root ----------

    function QqBotPanel({ compact }) {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [qrUrl, setQrUrl] = React.useState('');
      const [qrStamp, setQrStamp] = React.useState(0);
      const [testResult, setTestResult] = React.useState(null);
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
            setNotice(result.ok ? `已启动 NapCat（pid=${result.pid}），等待 WebUI 就绪后可扫码登录。` : `启动失败：${result.error || '未知错误'}`);
            refresh();
          }
        } catch (err) {
          setNotice(`失败：${err.message || String(err)}`);
          if (name === 'llmTest') setTestResult({ ok: false, error: err.message });
        } finally {
          setBusy('');
        }
      }, [refresh]);

      const state = { status, error, busy, notice, qrUrl, qrStamp, testResult, action, refresh };

      return h('div', { className: `qq-panel${compact ? ' qq-panel-compact' : ''}` }, [
        h(StatusPanel, { key: 'status', state, onRefresh: refresh }),
        h(InstallPanel, { key: 'install', state }),
        h(LoginPanel, { key: 'login', state, setState: () => {} }),
        h(SendPanel, { key: 'send', state }),
        h(MemoryPanel, { key: 'memory', state }),
        h(DiagPanel, { key: 'diag', state }),
        h(ConfigPanel, { key: 'config', state }),
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
      '.qq-panel{display:grid;gap:16px;padding:16px;max-width:920px;color:inherit}',
      '.qq-panel-compact{padding:8px;max-width:none}',
      '.qq-card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 4%,transparent)}',
      '.qq-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}',
      '.qq-card-head h3{margin:0;font-size:14px;font-weight:600}',
      '.qq-card-body{padding:12px 16px;display:grid;gap:10px}',
      '.qq-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.qq-btn{border:1px solid transparent;border-radius:8px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;background:#38bdf8;color:#08131f}',
      '.qq-btn:disabled{opacity:.5;cursor:default}',
      '.qq-btn-ghost{background:transparent;color:inherit;border-color:color-mix(in srgb,currentColor 30%,transparent)}',
      '.qq-btn-danger{background:#ef4444;color:#fff}',
      '.qq-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:color-mix(in srgb,currentColor 10%,transparent)}',
      '.qq-pill-ok{color:#22c55e}.qq-pill-warn{color:#f59e0b}.qq-pill-err{color:#ef4444}',
      '.qq-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:13px}',
      '.qq-dl dt{opacity:.65}.qq-dl dd{margin:0;word-break:break-all}',
      '.qq-field{display:grid;gap:4px;font-size:13px}',
      '.qq-input{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:6px 8px;background:transparent;color:inherit;font-size:13px;min-width:160px}',
      '.qq-qr{display:grid;place-items:center;min-height:220px;background:#fff;border-radius:12px;padding:12px}',
      '.qq-qr-img{width:240px;height:240px;image-rendering:pixelated}',
      '.qq-log{max-height:220px;overflow:auto;font-size:12px;display:grid;gap:2px;background:color-mix(in srgb,currentColor 6%,transparent);border-radius:8px;padding:8px}',
      '.qq-log-line{display:grid;grid-template-columns:74px 1fr;gap:8px}',
      '.qq-log-time{opacity:.55}',
      '.qq-muted{opacity:.65;font-size:12px;margin:0}',
      '.qq-error{color:#ef4444;font-size:13px;margin:0}',
      '.qq-ok{color:#22c55e;font-size:13px;margin:0}',
      'a{color:inherit}',
      'code{font-size:12px;word-break:break-all}',
      '.qq-btn-xs{padding:2px 6px;font-size:11px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 30%,transparent)}',
      '.qq-mem-list{display:grid;gap:6px}',
      '.qq-mem-row{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;overflow:hidden}',
      '.qq-mem-head{display:grid;grid-template-columns:auto auto 1fr auto;gap:10px;align-items:center;width:100%;text-align:left;background:transparent;border:0;color:inherit;font-size:13px;padding:8px 10px;cursor:pointer}',
      '.qq-mem-head:hover{background:color-mix(in srgb,currentColor 6%,transparent)}',
      '.qq-mem-key{font-weight:600}',
      '.qq-mem-caret{opacity:.6}',
      '.qq-mem-body{padding:8px 10px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);display:grid;gap:8px}',
      '.qq-mem-facts{margin:0;padding-left:18px;display:grid;gap:4px;font-size:13px}',
      '.qq-mem-facts li{display:flex;gap:8px;align-items:center;justify-content:space-between}',
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

    function Icon() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
        h('path', {
          d: 'M12 3c-3.6 0-6.2 2.2-6.2 5.6 0 3.1 2.3 5.1 5.6 5.1 1 0 1.6-.4 1.6-1s-.6-1-1.6-1c-2.1 0-3.6-1.3-3.6-3.1 0-1.9 1.7-3.6 4.2-3.6 2.6 0 4.3 1.4 4.3 3.2 0 1.1-.6 1.9-1.4 2.6-.6.5-1 1-1 1.7 0 .7.5 1.1 1.2 1.1 1.2 0 2.4-1.6 3.1-3.2.3-.4.6-.9.8-1.4.9-1.9 1.5-4 1.5-6C20.5 5.7 17 3 12 3zM5.4 20c-.8 0-1.4.6-1.4 1.4S4.6 22.8 5.4 22.8h13.2c.8 0 1.4-.6 1.4-1.4s-.6-1.4-1.4-1.4H5.4z',
          fill: 'currentColor',
        }));
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
