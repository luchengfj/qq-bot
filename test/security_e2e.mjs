// Security / parser regression tests.
//
// Covers the fixes from the independent review:
//   1. SSRF: image URLs come from chat events and must never reach loopback,
//      link-local (cloud metadata) or private ranges — including via redirect.
//   2. @全体成员: atList must keep 'all' so trigger rules can see it.
//   3. file:// image refs are rejected instead of failing the whole turn.
//   4. base64:// image refs are converted to data URIs.
//   5. CQ values containing a raw ']' must not truncate the code.

import http from 'node:http';
import assert from 'node:assert/strict';
import { downloadImage, assertPublicImageUrl } from '../lib/vision.js';
import { parseMessage, parseCqString, pickImageUrl, base64ToDataUri } from '../lib/message.js';
import { BotLogic, normalizeConfig } from '../lib/bot.js';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
const noop = () => {};

async function main() {
  // ---------- 1. SSRF guard ----------
  const blocked = [
    'http://127.0.0.1/x.png',
    'http://localhost/x.png',
    'http://169.254.169.254/latest/meta-data/iam/',
    'http://10.1.2.3/x.png',
    'http://192.168.0.10/x.png',
    'http://172.20.0.1/x.png',
    'http://[::1]/x.png',
    'http://[fd00::1]/x.png',
    'file:///C:/secret.png',
    'ftp://example.com/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicImageUrl(url), undefined, `should block ${url}`);
  }
  console.log(`✓ SSRF guard blocks ${blocked.length} internal / non-http URLs`);

  for (const url of ['https://example.com/a.png', 'http://8.8.8.8/a.png']) {
    await assertPublicImageUrl(url);
  }
  console.log('✓ SSRF guard allows ordinary public http(s) URLs');

  // ---------- 2. Redirect re-validation (public host → 127.0.0.1) ----------
  const inner = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  const innerPort = await listen(inner);
  const evil = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${innerPort}/p.png` });
    res.end();
  });
  const evilPort = await listen(evil);
  try {
    await assert.rejects(
      () => downloadImage(`http://127.0.0.1:${evilPort}/start.png`, { maxBytes: 1 << 20, allowPrivate: true }),
      /内网|禁止|内网地址/,
      'redirect to loopback must be re-validated',
    );
    console.log('✓ redirect hop to a private address is re-validated and refused');
  } finally {
    await close(evil);
    await close(inner);
  }

  // ---------- 3. @全体成员 visible to trigger rules ----------
  const arr = parseMessage([
    { type: 'text', data: { text: '大家好' } },
    { type: 'at', data: { qq: 'all' } },
  ]);
  assert.ok(arr.atList.includes('all'), "array 'at' segment must keep 'all'");
  const cq = parseCqString('大家好[CQ:at,qq=all]');
  assert.ok(cq.atList.includes('all'), "CQ 'at' must keep 'all'");
  console.log("✓ @全体成员 ('all') is preserved in atList (array + CQ)");

  const bot = new BotLogic(
    normalizeConfig({ trigger: { groupRequiresAt: true, privateAlways: true } }),
    noop,
  );
  const atAll = { post_type: 'message', message_type: 'group', group_id: 1, user_id: 2,
    self_id: 999, message_id: 11, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: 'hi' } }] };
  assert.equal(bot.shouldAnswer(atAll).answer, true, 'group @all message should trigger');
  console.log('✓ group message that @s everyone still triggers the bot');

  // ---------- 4. file:// rejected, base64:// converted ----------
  assert.equal(pickImageUrl({ file: 'file:///C:/secret.png' }), null, 'file:// must be rejected');
  const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const converted = pickImageUrl({ file: `base64://${b64}` });
  assert.ok(converted && converted.startsWith('data:image/png;base64,'), 'base64:// must become a data URI');
  assert.ok(base64ToDataUri(b64).startsWith('data:image/png;base64,'));
  console.log('✓ file:// refs rejected, base64:// refs converted to data URIs');

  // ---------- 5. CQ values with escaped commas / brackets ----------
  // OneBot escapes , [ ] inside values, so a URL holding a comma must survive.
  const escaped = parseCqString('看图[CQ:image,file=a&#93;b,url=https://x/y.png,z=1&#44;2]done');
  assert.equal(escaped.images.length, 1, 'image with escaped ] in its value must parse');
  assert.equal(escaped.images[0], 'https://x/y.png');
  assert.ok(escaped.text.includes('看图') && escaped.text.includes('done'), 'surrounding text kept');
  const cqParams = parseCqString('[CQ:at,qq=123][CQ:face,id=1]');
  assert.deepEqual(cqParams.atList, ['123']);
  assert.ok(cqParams.text.includes('[表情]'));
  console.log('✓ CQ values with escaped ] / , parse without truncating');

  // ---------- 6. Whitelist does not pass when the id is missing ----------
  const strict = new BotLogic(normalizeConfig({ allow: { users: ['7'] } }), noop);
  const noId = { post_type: 'message', message_type: 'private', message_id: 12, message: 'hi' };
  assert.equal(strict.shouldAnswer(noId).answer, false, 'missing user_id must not bypass allow.users');
  const strictGroup = new BotLogic(normalizeConfig({ allow: { groups: ['5'] } }), noop);
  const noGroupId = { post_type: 'message', message_type: 'group', user_id: 3, message_id: 13, message: 'hi' };
  assert.equal(strictGroup.shouldAnswer(noGroupId).answer, false, 'missing group_id must not bypass allow.groups');
  console.log('✓ whitelist denies events whose user_id / group_id is missing');

  console.log('\nAll security / parser tests passed.');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
