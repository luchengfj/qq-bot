// Standalone smoke test — run with: node test/smoke.mjs
// Exercises the transport + parsing without hitting any real LLM endpoint.

import assert from 'node:assert/strict';
import { OneBotBridge } from '../lib/onebot.js';
import { parseMessage } from '../lib/message.js';
import { BotLogic, normalizeConfig } from '../lib/bot.js';
import { buildSendParams } from '../lib/onebot.js';

const PORT = 16700; // avoid clashing with the real config port

// ---- 1. Message parsing (CQ string + array) ----
{
  const cq = '看这个[CQ:image,file=abc.jpg,url=https://example.com/pic.jpg] 好看吗[CQ:at,qq=999]';
  const p = parseMessage(cq);
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0], 'https://example.com/pic.jpg');
  assert.ok(p.text.includes('看这个') && p.text.includes('好看吗'));
  assert.ok(p.atList.includes('999'));

  const arr = [
    { type: 'text', data: { text: '这张图说了啥' } },
    { type: 'image', data: { url: 'https://example.com/a.png' } },
    { type: 'at', data: { qq: '12345' } },
  ];
  const p2 = parseMessage(arr);
  assert.equal(p2.text, '这张图说了啥');
  assert.equal(p2.images[0], 'https://example.com/a.png');
  assert.ok(p2.atList.includes('12345'));
  console.log('✓ message parsing (CQ string + array)');
}

// ---- 2. buildSendParams ----
{
  const g = buildSendParams({ message_type: 'group', group_id: 555, user_id: 42 }, 'hi', { atSender: true });
  assert.equal(g.message_type, 'group');
  assert.equal(g.group_id, 555);
  assert.ok(g.message.startsWith('[CQ:at,qq=42]'));
  const pm = buildSendParams({ message_type: 'private', user_id: 42 }, 'hi');
  assert.equal(pm.message_type, 'private');
  assert.equal(pm.user_id, 42);
  console.log('✓ buildSendParams (group @sender / private)');
}

// ---- 3. BotLogic trigger rules ----
{
  const cfg = normalizeConfig({ trigger: { groupRequiresAt: true, privateAlways: true } });
  const bot = new BotLogic(cfg, () => {});
  assert.equal(bot.shouldAnswer({ post_type: 'message', message_type: 'private', user_id: 1, message: 'x' }).answer, true);
  assert.equal(bot.shouldAnswer({ post_type: 'message', message_type: 'group', group_id: 9, user_id: 1, self_id: 999, message: 'hello' }).answer, false);
  assert.equal(bot.shouldAnswer({ post_type: 'message', message_type: 'group', group_id: 9, user_id: 1, self_id: 999, message: '[CQ:at,qq=999] 讲讲' }).answer, true);
  assert.equal(bot.shouldAnswer({ post_type: 'notice', message_type: 'private', user_id: 1 }).answer, false);
  console.log('✓ BotLogic trigger rules (group @self / private / ignore notice)');
}

// ---- 4. Live bridge: /health + WS handshake + echo reply round-trip ----
{
  const cfg = normalizeConfig({ port: PORT, host: '127.0.0.1', path: '/onebot' });
  const bridge = new OneBotBridge(cfg);
  bridge.on('error', (e) => console.error('bridge error:', e.message));
  await bridge.start();
  try {
    // health
    const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.plugin, '@local/qq-bot');
    console.log('✓ /health endpoint');

    // connect WS client (Node 24 global WebSocket)
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/onebot`, {
      headers: { 'X-Self-Id': '999' },
    });
    const gotActions = [];
    ws.addEventListener('message', (ev) => {
      const obj = JSON.parse(ev.data);
      if (obj.action) {
        gotActions.push(obj);
        // Simulate the OneBot framework echoing a successful API response.
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: obj.echo }));
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    console.log('✓ WebSocket handshake (reverse WS client connected)');

    // push a private message event, expect a send_msg action back
    bridge.on('event', (event, replyFn) => {
      replyFn('pong 回答');
    });
    ws.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 7,
      message: '你好 [CQ:image,url=https://example.com/x.jpg]', message_id: 100, self_id: 999,
    }));

    const deadline = Date.now() + 3000;
    while (gotActions.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(gotActions.length >= 1, 'expected a send_msg action from the bridge');
    assert.equal(gotActions[0].action, 'send_msg');
    assert.equal(gotActions[0].params.user_id, 7);
    assert.equal(gotActions[0].params.message, 'pong 回答');
    console.log('✓ event → reply action round-trip (with echo ack)');

    ws.close();
  } finally {
    await bridge.stop();
  }
}

console.log('\nAll smoke tests passed.');
