// End-to-end vision test with local mock servers (no real API key needed).
// Verifies: image download → base64 data URI → OpenAI-compatible request →
// reply parsing, plus the "not configured" error path.

import assert from 'node:assert/strict';
import http from 'node:http';
import { askVision, downloadImage } from '../lib/vision.js';
import { BotLogic, normalizeConfig } from '../lib/bot.js';

const BS = String.fromCharCode(92); // sanity: a single backslash

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  // ---- Mock image server: serves a tiny PNG (1x1) ----
  const imgServer = http.createServer((req, res) => {
    if (req.url === '/pic.png') {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64',
      );
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
    } else if (req.url === '/big.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(2 * 1024 * 1024)); // 2MB
    } else {
      res.writeHead(404); res.end('no');
    }
  });
  const imgPort = await listen(imgServer);

  // ---- Mock LLM server: /v1/chat/completions ----
  let lastBody = null;
  const llmServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    lastBody = JSON.parse(raw);
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '这是一只可爱的小企鹅。' } }],
      }));
    } else {
      res.writeHead(404); res.end('no');
    }
  });
  const llmPort = await listen(llmServer);

  try {
    // 1. downloadImage returns a valid data URI
    const img = await downloadImage(`http://127.0.0.1:${imgPort}/pic.png`, { maxBytes: 1024 * 1024, allowPrivate: true });
    assert.ok(img.dataUri.startsWith('data:image/png;base64,'));
    assert.ok(img.bytes > 0);
    console.log('✓ downloadImage → data URI (' + img.bytes + ' bytes, ' + img.mime + ')');

    // 2. downloadImage enforces the byte cap
    let capped = false;
    try {
      await downloadImage(`http://127.0.0.1:${imgPort}/big.bin`, { maxBytes: 1024, allowPrivate: true });
    } catch (e) {
      capped = /过大/.test(e.message);
    }
    assert.ok(capped, 'byte cap should reject a 2MB image when maxBytes=1KB');
    console.log('✓ downloadImage enforces maxBytes cap');

    // 3. askVision posts text+image to the OpenAI-compatible endpoint
    const cfg = {
      baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      apiKey: '',           // local gateway: no key required
      model: 'mock-vl',
      systemPrompt: '你是测试助手',
      maxTokens: 256,
      timeoutMs: 10000,
      maxImageBytes: 1024 * 1024,
      allowPrivateImages: true,   // test serves images from loopback
    };
    const reply = await askVision(cfg, {
      text: '图片里是什么？',
      images: [`http://127.0.0.1:${imgPort}/pic.png`],
    });
    assert.equal(reply, '这是一只可爱的小企鹅。');
    // Verify the request shape: one text part + one inline image_url data URI
    const parts = lastBody.messages[1].content;
    assert.equal(parts[0].type, 'text');
    assert.ok(parts[0].text.includes('图片里是什么'));
    assert.equal(parts[1].type, 'image_url');
    assert.ok(parts[1].image_url.url.startsWith('data:image/png;base64,'));
    assert.equal(lastBody.model, 'mock-vl');
    assert.equal(lastBody.stream, false);
    console.log('✓ askVision → OpenAI-compatible request with inline image + parsed reply');

    // 4. BotLogic.handle with a mock replyFn: image message gets answered, @sender applied on group
    const botCfg = normalizeConfig({
      llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: '', model: 'mock-vl', allowPrivateImages: true },
      trigger: { groupRequiresAt: false },
    });
    const bot = new BotLogic(botCfg, () => {});
    const replies = [];
    const replyFn = async (text, opts) => { replies.push({ text, opts }); };
    const result = await bot.handle(
      { post_type: 'message', message_type: 'group', group_id: 888, user_id: 42,
        self_id: 999, message_id: 1,
        message: [{ type: 'text', data: { text: '看看这只' } },
                  { type: 'image', data: { url: `http://127.0.0.1:${imgPort}/pic.png` } }] },
      replyFn,
    );
    assert.equal(result.ok, true);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, '这是一只可爱的小企鹅。');
    assert.equal(replies[0].opts.atSender, true, 'group reply should @sender');
    console.log('✓ BotLogic.handle (image message) → answered with @sender on group');

    // 5. Friendly error path when apiKey is missing for a hosted endpoint
    const botCfg2 = normalizeConfig({
      llm: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-vl-max-latest' },
    });
    const bot2 = new BotLogic(botCfg2, () => {});
    const errReplies = [];
    const r2 = await bot2.handle(
      { post_type: 'message', message_type: 'private', user_id: 1, message: '你好', message_id: 2 },
      async (t) => { errReplies.push(t); },
    );
    assert.equal(r2.ok, false);
    assert.ok(errReplies[0].includes('未配置视觉接口密钥'), 'friendly message should mention the missing key');
    console.log('✓ missing-key path → friendly error reply (no crash): ' + errReplies[0]);

    console.log('\nAll vision E2E tests passed.');
  } finally {
    await close(imgServer);
    await close(llmServer);
  }
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
