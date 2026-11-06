// E2E test for lib/simulator.js — ChatSimulator with a STUB logic object.
// Self-contained: node built-ins + repo lib modules only. No external deps.

import assert from 'node:assert/strict';
import { ChatSimulator } from '../lib/simulator.js';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('PASS', name);
  } catch (err) {
    fail += 1;
    console.log('FAIL', name, '—', err && err.message ? err.message : String(err));
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('PASS', name);
  } catch (err) {
    fail += 1;
    console.log('FAIL', name, '—', err && err.message ? err.message : String(err));
  }
}

// Stub logic that validates the OneBot v11 private event and its context.
function makeLogic() {
  return {
    seen: null,
    async handle(event, replyFn, context) {
      this.seen = { event, context };
      assert.equal(event.post_type, 'message');
      assert.equal(event.message_type, 'private');
      assert.equal(event.user_id, 10001);
      assert.ok(Array.isArray(event.message), 'message is an array of segments');
      assert.ok(event.message.some((s) => s.type === 'text' && typeof s.data.text === 'string'),
        'message array contains a text segment');
      assert.equal(typeof context.hint, 'string');
      assert.ok(context.hint.length > 0, 'context.hint is a non-empty string');
      await replyFn('回复一');
      await replyFn('回复二');
      return { ok: true };
    },
  };
}

async function main() {
  // (a) send('你好') -> ok, two replies, history has 3 items with fields.
  await asyncCheck('send("你好") returns ok + 2 replies + 3 history items', async () => {
    const logic = makeLogic();
    const sim = new ChatSimulator(logic, () => {});
    const res = await sim.send('你好');
    assert.equal(res.ok, true);
    assert.deepEqual(res.replies, ['回复一', '回复二']);
    const h = sim.history();
    assert.equal(h.length, 3, 'user + 2 bot messages');
    assert.equal(h[0].role, 'user');
    assert.equal(h[0].text, '你好');
    assert.equal(h[1].role, 'bot');
    assert.equal(h[1].text, '回复一');
    assert.equal(h[2].role, 'bot');
    assert.equal(h[2].text, '回复二');
    for (const item of h) {
      assert.equal(typeof item.id, 'string');
      assert.ok(item.id.length > 0, 'id present');
      assert.equal(typeof item.at, 'number');
      assert.ok(item.at > 0, 'at present');
      assert.equal(typeof item.images, 'number');
      assert.ok('images' in item, 'images field present');
    }
  });

  // (b) image-only send produces an image segment + user text '[图片]'.
  await asyncCheck('image-only send builds image segment and [图片] user text', async () => {
    const logic = {
      seen: null,
      async handle(event, replyFn) {
        this.seen = event;
        await replyFn('收到图片');
        return { ok: true };
      },
    };
    const sim = new ChatSimulator(logic, () => {});
    const res = await sim.send('', 'https://example.com/a.png');
    assert.equal(res.ok, true);
    const ev = logic.seen;
    const imgSeg = ev.message.find((s) => s.type === 'image');
    assert.ok(imgSeg, 'image segment exists');
    assert.equal(imgSeg.data.url, 'https://example.com/a.png');
    assert.equal(ev.message.some((s) => s.type === 'text'), false, 'no text segment for image-only');
    assert.equal(ev.raw_message, '[图片]');
    const h = sim.history();
    assert.equal(h[0].role, 'user');
    assert.equal(h[0].text, '[图片]');
    assert.equal(h[0].images, 1);
  });

  // (c) empty send -> ok:false, exact error, empty replies, no history growth.
  await asyncCheck('empty send("", "") rejects with exact error and no history growth', async () => {
    const logic = makeLogic();
    const sim = new ChatSimulator(logic, () => {});
    const before = sim.history().length;
    const res = await sim.send('', '');
    assert.equal(res.ok, false);
    assert.equal(res.error, '请输入消息内容或图片地址');
    assert.deepEqual(res.replies, []);
    assert.equal(sim.history().length, before, 'history did not grow');
    assert.equal(logic.seen, null, 'logic.handle was NOT called');
  });

  // (d) logic that never calls replyFn -> a fallback reply is still pushed.
  await asyncCheck('silent logic still yields a fallback reply', async () => {
    const logic = {
      async handle() { return { ok: true }; },
    };
    const sim = new ChatSimulator(logic, () => {});
    const res = await sim.send('你好');
    assert.equal(res.replies.length, 1, 'exactly one fallback reply');
    assert.ok(res.replies[0] && res.replies[0].length > 0, 'fallback reply is non-empty');
    assert.equal(sim.history().length, 2, 'user + fallback bot message');
    assert.equal(sim.history()[1].role, 'bot');
  });

  // (e) logic that throws -> replies contain '抱歉，处理失败：...', ok false.
  await asyncCheck('throwing logic yields 抱歉，处理失败： reply and ok:false', async () => {
    const logic = {
      async handle() { throw new Error('boom-测试'); },
    };
    const sim = new ChatSimulator(logic, () => {});
    const res = await sim.send('你好');
    assert.equal(res.ok, false);
    assert.equal(res.replies.length, 1);
    assert.ok(res.replies[0].startsWith('抱歉，处理失败：'), 'reply has failure prefix');
    assert.ok(res.replies[0].includes('boom-测试'), 'reply includes the error message');
  });

  // (f) clear() empties history and calls memory.clearHistory('private:10001').
  check('clear() empties history and calls memory.clearHistory(key)', () => {
    const cleared = [];
    const memory = { clearHistory: (key) => cleared.push(key) };
    const sim = new ChatSimulator(makeLogic(), () => {}, { memory });
    sim.messages.push({ id: 'x', role: 'user', text: 'seed', at: 1, images: 0 });
    assert.equal(sim.history().length, 1);
    const res = sim.clear();
    assert.deepEqual(res, { ok: true });
    assert.equal(sim.history().length, 0, 'history emptied');
    assert.deepEqual(cleared, ['private:10001']);
    assert.equal(sim.key, 'private:10001', 'key getter');
  });

  // (g) history is capped at <= 200 messages.
  await asyncCheck('history is capped (<=200) after >200 sends', async () => {
    const logic = {
      async handle(_event, replyFn) {
        await replyFn('ok');
        return { ok: true };
      },
    };
    const sim = new ChatSimulator(logic, () => {});
    for (let i = 0; i < 130; i += 1) {
      await sim.send(`msg-${i}`);
    }
    // 130 sends * 2 messages (user + 1 bot) = 260 > 200.
    assert.ok(sim.history().length <= 200, `history length ${sim.history().length} <= 200`);
    assert.equal(sim.history().length, 200, 'history is exactly capped at 200');
    // Oldest entries were evicted (FIFO), newest retained.
    assert.equal(sim.history()[0].text, 'msg-30', 'oldest retained is msg-30 (FIFO cap)');
    assert.equal(sim.history()[199].text, 'ok', 'newest retained is the last bot reply');
  });

  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log('FAIL fatal —', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
