// Exercise the new features against the LIVE Harness-hosted plugin (port
// 6700). Sends a few real OneBot events over the WebSocket and checks that
// the built-in commands are answered and that context is being tracked.

import assert from 'node:assert/strict';

const url = process.argv[2] || 'ws://127.0.0.1:6700/onebot';
const ws = new WebSocket(url, { headers: { 'X-Self-Id': '999001' } });

let seq = 0;
const queue = [];
const replies = [];
let done = false;
const timer = setTimeout(() => {
  console.error('timeout waiting for replies');
  process.exit(2);
}, 20000);

function sendEvent(text) {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'private', user_id: 4242, self_id: 999001,
    message_id: Date.now() + (seq += 1), message: text,
  }));
}

function finish() {
  if (done) return;
  done = true;
  clearTimeout(timer);
  ws.close();

  const texts = replies.map((r) => r.message);
  const help = texts.find((t) => t.indexOf('/help') >= 0 && t.indexOf('我可以做这些') >= 0);
  const status = texts.find((t) => t.indexOf('机器人运行中') >= 0);
  const memEmpty = texts.find((t) => t.indexOf('还没有记住') >= 0);
  // The /help text itself mentions "/new 换个话题", so a plain '话题' match
  // would falsely pass on the help reply. Require one of /new's own phrases.
  const newTopic = texts.find((t) =>
    t.indexOf('刚才聊的内容我已经放下了') >= 0 ||
    t.indexOf('本来就没有进行中的话题') >= 0 ||
    t.indexOf('好的，我们换个话题') >= 0);

  assert.ok(help, `/help should be answered, got: ${JSON.stringify(texts)}`);
  assert.ok(status, `/status should be answered, got: ${JSON.stringify(texts)}`);
  assert.ok(memEmpty, `/memory with nothing remembered should say so, got: ${JSON.stringify(texts)}`);
  assert.ok(newTopic, `/new should be answered, got: ${JSON.stringify(texts)}`);

  console.log('✓ /help    ->', help.split('\n')[0]);
  console.log('✓ /status  ->', status.split('\n')[0]);
  console.log('✓ /memory  ->', memEmpty);
  console.log('✓ /new     ->', newTopic);
  console.log('\nLive command round-trip through the Harness-hosted plugin PASSED.');
  process.exit(0);
}

ws.addEventListener('message', (ev) => {
  const obj = JSON.parse(ev.data);
  if (!obj.action) return;
  // ack so the bridge resolves its pending call
  ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: obj.echo }));
  replies.push({ action: obj.action, message: obj.params && obj.params.message });

  const next = queue.shift();
  if (next) sendEvent(next);
  else if (replies.length >= 4) finish();
});

ws.addEventListener('open', () => {
  queue.push('/memory', '/new', '/status');
  sendEvent('/help');
});

ws.addEventListener('error', (e) => { console.error('WS error:', e.message || e); process.exit(3); });
