// End-to-end tests for long-term memory + reply shaping.
// Run: node test/memory_e2e.mjs

import { ConversationMemory, conversationKey, similarity } from '../lib/memory.js';
import {
  cleanReply,
  collapseBlankLines,
  extractFacts,
  matchMemoryCommand,
  stripPreamble,
  truncateReply,
} from '../lib/reply.js';
import { BotLogic, normalizeConfig } from '../lib/bot.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

const noop = () => {};

/** Flatten one OpenAI-style message content into plain text. */
function textOf(message) {
  if (!message) return '';
  const content = message.content;
  if (Array.isArray(content)) return content.map((part) => part && part.text ? String(part.text) : '').join('');
  return String(content === undefined || content === null ? '' : content);
}

// --------------------------------------------------------------- reply.js ----

check(
  'stripPreamble removes the canned opening',
  stripPreamble('作为一个人工智能助手，我可以帮你写代码。') === '我可以帮你写代码。',
);
check(
  'stripPreamble leaves normal text alone',
  stripPreamble('可以，用 Node 内置模块就行。') === '可以，用 Node 内置模块就行。',
);
check(
  'stripPreamble leaves a preamble without separator',
  stripPreamble('当然可以帮你') === '当然可以帮你',
);

check(
  'collapseBlankLines squeezes blank runs',
  collapseBlankLines('a\n\n\n\nb') === 'a\n\nb',
  collapseBlankLines('a\n\n\n\nb'),
);
check(
  'collapseBlankLines trims edges',
  collapseBlankLines('\n\n  a  \n\n') === '  a',
  JSON.stringify(collapseBlankLines('\n\n  a  \n\n')),
);

const long = '第一句话。第二句话。第三句话。第四句话。';
check('truncateReply cuts at a sentence boundary', truncateReply(long, 7) === '第一句话。', truncateReply(long, 7));
check('truncateReply keeps short text', truncateReply('短', 100) === '短');
check(
  'cleanReply combines both',
  cleanReply('作为一个人工智能助手，\n\n\n你好！', {}) === '你好！',
  JSON.stringify(cleanReply('作为一个人工智能助手，\n\n\n你好！', {})),
);
check(
  'cleanReply applies maxChars',
  cleanReply(long, { maxChars: 7 }) === '第一句话。',
  cleanReply(long, { maxChars: 7 }),
);

const facts = extractFacts('我叫小明，我喜欢喝咖啡。今天天气不错。');
check('extractFacts finds the name', facts.some((f) => f.indexOf('我叫小明') >= 0), facts);
check('extractFacts finds the preference', facts.some((f) => f.indexOf('喜欢') >= 0), facts);
check(
  'extractFacts ignores chatter',
  extractFacts('今天天气不错').length === 0,
  extractFacts('今天天气不错'),
);
check(
  'extractFacts ignores questions',
  extractFacts('我叫什么名字？').length === 0,
  extractFacts('我叫什么名字？'),
);

check('matchMemoryCommand clear', matchMemoryCommand('忘记我') === 'clear');
check('matchMemoryCommand clear inline', matchMemoryCommand('请你忘记我吧') === 'clear');
check('matchMemoryCommand list', matchMemoryCommand('我的记忆') === 'list');
check('matchMemoryCommand none', matchMemoryCommand('你好') === null);

check('similarity identical', similarity('abc', 'abc') === 1);
check('similarity substring', similarity('abcdef', 'abc') > 0.8);
check('similarity unrelated', similarity('我喜欢猫', '明天要下雨') < 0.4, similarity('我喜欢猫', '明天要下雨'));

// -------------------------------------------------------------- memory.js ----

const mem = new ConversationMemory({ enabled: true, maxFacts: 5, ttlDays: 30 });
const k1 = conversationKey({ message_type: 'private', user_id: 10001 });
const k2 = conversationKey({ message_type: 'group', user_id: 10001, group_id: 555 });

check('private key', k1 === 'private:10001', k1);
check('group key', k2 === 'group:555:10001', k2);
check('private/group are separate', k1 !== k2);

mem.remember(k1, '我叫小明');
mem.remember(k1, '我喜欢喝咖啡');
check('facts stored', mem.facts(k1).length === 2, mem.facts(k1));

mem.remember(k1, '我叫小红');
const after = mem.facts(k1);
check('same-subject fact replaced', after.length === 2 && after.some((f) => f.indexOf('小红') >= 0), after);
check('old name gone', !after.some((f) => f.indexOf('小明') >= 0), after);

check('group memory is isolated', mem.facts(k2).length === 0, mem.facts(k2));

check('hasMemory true', mem.hasMemory(k1) === true);
check('hasMemory false for unknown', mem.hasMemory('private:999') === false);

check('forget removes one fact', mem.forget(k1, '咖啡') === 1, mem.facts(k1));
check('clear removes the sender', mem.clear(k1) === true);
check('facts empty after clear', mem.facts(k1).length === 0);

// Cap enforcement.
const capped = new ConversationMemory({ enabled: true, maxFacts: 3 });
for (let i = 0; i < 10; i += 1) capped.remember('private:1', `事实${i}: 这是第 ${i} 条`);
check('maxFacts enforced', capped.facts('private:1').length === 3, capped.facts('private:1').length);

// Disabled memory stores nothing.
const off = new ConversationMemory({ enabled: false });
off.remember('private:1', '我叫小明');
check('disabled memory stores nothing', off.facts('private:1').length === 0);

// TTL expiry.
const ttl = new ConversationMemory({ enabled: true, ttlDays: 1 });
const now = Date.now();
ttl.remember('private:1', '我叫小明', { now });
check(
  'ttl expires old entries',
  ttl.facts('private:1', { now: now + 2 * 24 * 60 * 60 * 1000 }).length === 0,
);

// Persistence round-trip.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-mem-'));
const file = path.join(dir, 'memory.json');
const p1 = new ConversationMemory({ enabled: true, file, autoSaveMs: 1000 });
p1.remember('private:42', '我叫小明');
p1.remember('private:42', '我住在杭州');
const saved = await p1.save();
check('save writes the file', saved === true && fs.existsSync(file), { saved, exists: fs.existsSync(file) });

const p2 = new ConversationMemory({ enabled: true, file });
const loaded = await p2.load();
check('load restores facts', loaded === true && p2.facts('private:42').length === 2, p2.facts('private:42'));
p2.dispose();

// A missing file is not an error.
const p3 = new ConversationMemory({ enabled: true, file: path.join(dir, 'nope.json') });
check('load of missing file is false', (await p3.load()) === false);

// A corrupt file must not throw.
const bad = path.join(dir, 'bad.json');
fs.writeFileSync(bad, '{ not json', 'utf8');
const p4 = new ConversationMemory({ enabled: true, file: bad });
let threw = false;
try {
  await p4.load();
} catch {
  threw = true;
}
check('corrupt file ignored', threw === false && p4.facts('private:1').length === 0);

fs.rmSync(dir, { recursive: true, force: true });

// ------------------------------------------------------------- bot logic ----

const cfg = normalizeConfig({
  llm: { mode: 'external', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
  memory: { enabled: true },
});

const bot = new BotLogic(cfg, noop);

// Memory command: nothing remembered yet.
let out = '';
await bot.handle(
  { post_type: 'message', message_type: 'private', user_id: 7, message: '我的记忆' },
  async (t) => { out = t; },
);
check('empty memory answer', out.indexOf('还没有记住') >= 0, out);

// Teach it something, then ask again.
await bot.handle(
  { post_type: 'message', message_type: 'private', user_id: 7, message: '我叫小明，记住了' },
  async () => {},
);
check('fact learned', bot.memory.facts(conversationKey({ message_type: 'private', user_id: 7 })).length > 0);

out = '';
await bot.handle(
  { post_type: 'message', message_type: 'private', user_id: 7, message: '我的记忆' },
  async (t) => { out = t; },
);
check('memory list answer', out.indexOf('小明') >= 0, out);

// Group context must not see the private fact.
out = '';
await bot.handle(
  { post_type: 'message', message_type: 'group', group_id: 9, user_id: 7, self_id: 1, message: [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' 我的记忆' } }] },
  async (t) => { out = t; },
);
check('group does not see private facts', out.indexOf('还没有记住') >= 0, out);

// Clear command.
out = '';
await bot.handle(
  { post_type: 'message', message_type: 'private', user_id: 7, message: '忘记我' },
  async (t) => { out = t; },
);
check('clear command answer', out.indexOf('忘记') >= 0, out);
check('facts gone after clear', bot.memory.facts(conversationKey({ message_type: 'private', user_id: 7 })).length === 0);

// Memory disabled → no facts stored.
const botOff = new BotLogic(normalizeConfig({ memory: { enabled: false } }), noop);
await botOff.handle(
  { post_type: 'message', message_type: 'private', user_id: 8, message: '我叫小红' },
  async () => {},
);
check('disabled memory stores nothing via bot', botOff.memory.facts('private:8').length === 0);

// ------------------------------------------------------------------ vision ----
// The remembered facts must reach the model request.

import http from 'node:http';

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '你好，小明！' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const memCfg = normalizeConfig({
  llm: { mode: 'external', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' },
  memory: { enabled: true },
});
const memBot = new BotLogic(memCfg, noop);
await memBot.handle(
  { post_type: 'message', message_type: 'private', user_id: 3, message: '我叫小明' },
  async () => {},
);
seen.length = 0;
await memBot.handle(
  { post_type: 'message', message_type: 'private', user_id: 3, message: '今天怎么样' },
  async () => {},
);
server.close();

const sent = seen[0];
// External (OpenAI-compatible) backend: messages[0] is the system turn,
// then the optional history turns, then the current user content.
const roles = (sent?.messages || []).map((m) => m.role);
check('model: system turn first', roles[0] === 'system', JSON.stringify(roles));
check('model: current turn is last', roles[roles.length - 1] === 'user', JSON.stringify(roles));
const sys = String(sent.messages[0]?.content || '');
check('facts injected into system prompt', sys.indexOf('小明') >= 0, sys.slice(0, 200));
check('system prompt still has base instruction', sys.indexOf('QQ') >= 0);
const userTurns = sent.messages.filter((m) => m.role === 'user');
check('previous question present', textOf(userTurns[userTurns.length - 2]).indexOf('我叫小明') >= 0,
  JSON.stringify(roles));
const blocks = userTurns[userTurns.length - 1].content;
check('content is a block array', Array.isArray(blocks), JSON.stringify(blocks).slice(0, 120));
check('current question present in content',
  blocks.map((b) => b.text || '').join('').indexOf('今天怎么样') >= 0,
  JSON.stringify(blocks).slice(0, 200));

console.log(`\n${fail === 0 ? 'ALL_MEMORY_PASS' : 'MEMORY_FAILURES'} ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
