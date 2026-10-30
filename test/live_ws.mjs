// Connect to the LIVE plugin server (started by the Harness on port 6700),
// push a private message event, and capture the reply action it emits.
// No API key is configured, so we expect the friendly "未配置密钥" reply,
// which still proves the full chain: Harness → plugin WS → bot logic → reply.

import assert from 'node:assert/strict';

const url = process.argv[2] || 'ws://127.0.0.1:6700/onebot';
const ws = new WebSocket(url, { headers: { 'X-Self-Id': '999001' } });
const actions = [];
const timer = setTimeout(() => { console.error('timeout waiting for reply'); process.exit(2); }, 6000);

ws.addEventListener('message', (ev) => {
  const obj = JSON.parse(ev.data);
  if (obj.action) {
    actions.push(obj);
    // ack the echo so the bridge resolves its pending call
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: obj.echo }));
    clearTimeout(timer);
    console.log('✓ received reply action from LIVE plugin:');
    console.log('  action  =', obj.action);
    console.log('  user_id =', obj.params.user_id);
    console.log('  message =', obj.params.message);
    assert.equal(obj.action, 'send_msg');
    assert.equal(obj.params.user_id, 42);
    assert.ok(/未配置|失败|抱歉/.test(obj.params.message), 'reply should be the friendly error/config message');
    ws.close();
    console.log('\nLive round-trip through the Harness-hosted plugin PASSED.');
    process.exit(0);
  }
});

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'private', user_id: 42, self_id: 999001,
    message_id: Date.now(), message: '你好，请描述这张图',
  }));
});

ws.addEventListener('error', (e) => { console.error('WS error:', e.message || e); process.exit(3); });
