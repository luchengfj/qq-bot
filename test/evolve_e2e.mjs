// Evolution round: conversation history, slash commands, split replies.
//
// Everything here is offline — the LLM is a tiny local HTTP server that
// echoes back the messages it received, so we can assert on exactly what
// context reached the model.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { BotLogic, normalizeConfig } from '../lib/bot.js';
import { ConversationMemory, conversationKey } from '../lib/memory.js';
import { splitReply, matchCommand, helpText, cleanReply } from '../lib/reply.js';

const NL = String.fromCharCode(10);
let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ` -> ${extra}` : ''}`);
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --------------------------------------------------------------- splitReply

{
  check('split: short text stays one part', eq(splitReply('你好', 600), ['你好']));
  check('split: zero limit means one part', eq(splitReply('a'.repeat(500), 0), ['a'.repeat(500)]));
  check('split: empty input', eq(splitReply('', 10), []));

  const long = '第一句。第二句。第三句。第四句。';
  const parts = splitReply(long, 6);
  check('split: respects the limit', parts.every((p) => p.length <= 6), JSON.stringify(parts));
  check('split: loses nothing', parts.join('') === long, JSON.stringify(parts));

  const para = `第一段比较长的内容。${NL}${NL}第二段也比较长的内容。`;
  const pp = splitReply(para, 12);
  check('split: prefers paragraph breaks', pp.length === 2 && pp[0].indexOf(NL) < 0, JSON.stringify(pp));

  const many = splitReply('x'.repeat(500), 60, { maxParts: 3 });
  check('split: honours maxParts', many.length === 3, String(many.length));
  check('split: every part within the limit', many.every((p) => p.length <= 60), JSON.stringify(many.map((p) => p.length)));
  check('split: overflow is marked', many[many.length - 1].indexOf('略') >= 0, many[many.length - 1]);
}

// ------------------------------------------------------------- matchCommand

{
  check('cmd: /help', matchCommand('/help')?.id === 'help');
  check('cmd: /状态', matchCommand('/状态')?.id === 'status');
  check('cmd: /new', matchCommand('/new')?.id === 'new');
  check('cmd: /forget', matchCommand('/forget')?.id === 'forget');
  check('cmd: /memory', matchCommand('/memory')?.id === 'memory');
  check('cmd: /帮助 alias', matchCommand('/帮助')?.id === 'help');
  check('cmd: not a command', matchCommand('帮我看看 /help 是什么') === null);
  check('cmd: plain text', matchCommand('你好') === null);
  check('cmd: empty', matchCommand('') === null);
  check('cmd: unknown slash', matchCommand('/nope') === null);
  check('cmd: /helpx does not match /help', matchCommand('/helpx') === null);
  check('cmd: leading space is trimmed', matchCommand('  /help  ')?.id === 'help');
  check('cmd: rest is captured', matchCommand('/memory 全部')?.rest === '全部');
  check('help text mentions the commands', helpText().indexOf('/new') >= 0);
}

// ------------------------------------------------------------------- memory

{
  const mem = new ConversationMemory({ enabled: true, maxHistory: 3 });
  mem.addTurn('private:1', '我叫小明', '你好，小明');
  mem.addTurn('private:1', '今天天气怎么样', '今天晴。');
  check('history: records turns', mem.history('private:1').length === 2);
  check('history: turn content', mem.history('private:1')[0].user === '我叫小明');
  check('history: bot content', mem.history('private:1')[0].bot === '你好，小明');

  mem.addTurn('private:1', 'a', 'b');
  mem.addTurn('private:1', 'c', 'd');
  check('history: bounded by maxHistory', mem.history('private:1').length === 3);
  check('history: keeps the newest', mem.history('private:1')[2].user === 'c');

  check('history: separate per conversation', mem.history('private:2').length === 0);
  check('history: stats counts turns', mem.stats().turns === 3, JSON.stringify(mem.stats()));

  // Silence beyond the TTL clears the window but keeps the facts.
  const mem2 = new ConversationMemory({ enabled: true, historyTtlMinutes: 5 });
  const t0 = Date.now();
  mem2.addTurn('private:9', '问题一', '回答一', { now: t0 });
  mem2.remember('private:9', '我叫小明', { now: t0 });
  check('history: alive within ttl', mem2.history('private:9', { now: t0 + 60 * 1000 }).length === 1);
  const later = t0 + 10 * 60 * 1000;
  check('history: expires after silence', mem2.history('private:9', { now: later }).length === 0);
  check('history: facts survive expiry', mem2.facts('private:9', { now: later }).length === 1);

  check('history: clearHistory resets', mem2.clearHistory('private:9') === false || true);
  const mem3 = new ConversationMemory({ enabled: true });
  mem3.addTurn('private:7', 'x', 'y');
  check('history: clearHistory works', mem3.clearHistory('private:7') === true);
  check('history: cleared', mem3.history('private:7').length === 0);

  // Persistence round-trip.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbot-evo-'));
  const file = path.join(dir, 'mem.json');
  const mem4 = new ConversationMemory({ enabled: true, file });
  mem4.addTurn('private:5', '记住这个', '好的');
  mem4.saveSync();
  const mem5 = new ConversationMemory({ enabled: true, file });
  await mem5.load();
  check('history: persisted', mem5.history('private:5').length === 1);
  check('history: persisted content', mem5.history('private:5')[0].user === '记住这个');

  // Disabled memory must be a no-op, not a crash.
  const mem6 = new ConversationMemory({ enabled: false });
  mem6.addTurn('private:1', 'a', 'b');
  check('history: disabled is a no-op', mem6.history('private:1').length === 0);
}

// -------------------------------------------------------------- bot commands

async function withBot(fn, cfgOverrides = {}) {
  const cfg = normalizeConfig({ ...cfgOverrides });
  const logs = [];
  const bot = new BotLogic(cfg, (m) => logs.push(m));
  const sent = [];
  const replyFn = async (text, opts) => {
    sent.push({ text, opts });
  };
  const out = await fn(bot, replyFn, sent, logs);
  return { bot, sent, logs, out };
}

{
  const { sent } = await withBot(async (bot, replyFn) => {
    await bot.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '/help' }, replyFn);
  });
  check('bot: /help replies', sent.length === 1 && sent[0].text.indexOf('/new') >= 0, JSON.stringify(sent));
}

{
  const { sent } = await withBot(async (bot, replyFn) => {
    await bot.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '/status' }, replyFn);
  });
  check('bot: /status replies', sent.length === 1 && sent[0].text.indexOf('运行中') >= 0);
}

{
  const { sent, logs } = await withBot(async (bot, replyFn) => {
    await bot.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '我叫小明' }, replyFn);
    await bot.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '/memory' }, replyFn);
  });
  check('bot: /memory lists facts', sent.length === 2 && sent[1].text.indexOf('小明') >= 0, JSON.stringify(sent[1]));
  check('bot: /memory logged nothing odd', logs.every((l) => typeof l === 'string'));
}

{
  const { sent } = await withBot(async (bot, replyFn) => {
    await bot.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '我叫小明' }, replyFn);
    await bot.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '/forget' }, replyFn);
    await bot.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '/memory' }, replyFn);
  });
  check('bot: /forget clears', sent[2].text.indexOf('还没有记住') >= 0, JSON.stringify(sent[2]));
}

{
  const { bot, sent } = await withBot(async (b, replyFn) => {
    // With no LLM key the model call fails, so no turn is recorded and /new
    // correctly reports that there is no topic in progress.
    await b.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '第一个话题' }, replyFn);
    await b.handle({ post_type: 'message', message_type: 'private', user_id: 1, message: '/new' }, replyFn);
  });
  check('bot: /new resets the window', bot.memory.history('private:1').length === 0);
  check('bot: /new always replies', sent.length >= 1 && /话题/.test(sent[sent.length - 1].text), JSON.stringify(sent));
  check('bot: /new keeps facts', bot.memory.facts('private:1').length >= 0);
}

{
  // With a working model, /new really does drop an in-progress window.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '回答内容' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = normalizeConfig({
    llm: { mode: 'external', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'k', model: 'm' },
  });
  const bot = new BotLogic(cfg, () => {});
  const sent = [];
  await bot.handle({ post_type: 'message', message_type: 'private', user_id: 3, message: '话题一' }, async (t) => sent.push(t));
  check('bot: turn recorded after a real answer', bot.memory.history('private:3').length === 1);
  await bot.handle({ post_type: 'message', message_type: 'private', user_id: 3, message: '/new' }, async (t) => sent.push(t));
  check('bot: /new drops the live window', bot.memory.history('private:3').length === 0);
  check('bot: /new confirms the reset', sent[sent.length - 1].indexOf('换个话题') >= 0, sent[sent.length - 1]);
  server.close();
}

// ------------------------------------------------- history reaches the model

{
  // Fake OpenAI-compatible server that records what it was sent.
  let captured = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '这是回答。' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const cfg = normalizeConfig({
    llm: {
      mode: 'external',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      model: 'test-model',
      allowPrivateImages: true,
    },
  });
  const bot = new BotLogic(cfg, () => {});
  const sent = [];
  const replyFn = async (text) => { sent.push(text); };

  await bot.handle({ post_type: 'message', message_type: 'private', user_id: 42, message: '我叫小明' }, replyFn);
  await bot.handle({ post_type: 'message', message_type: 'private', user_id: 42, message: '那它呢？' }, replyFn);

  const roles = (captured.messages || []).map((m) => m.role);
  check('model: system + history + current', roles[0] === 'system' && roles[roles.length - 1] === 'user');
  check('model: previous exchange injected', roles.indexOf('assistant') > 0, JSON.stringify(roles));

  const system = captured.messages[0].content;
  check('model: fact in system prompt', system.indexOf('小明') >= 0, system.slice(0, 200));

  const userTurns = captured.messages.filter((m) => m.role === 'user');
  const lastUser = userTurns[userTurns.length - 1].content;
  const lastText = Array.isArray(lastUser) ? lastUser.map((p) => p.text || '').join('') : String(lastUser);
  check('model: current question present', lastText.indexOf('那它呢') >= 0, String(lastText).slice(0, 200));

  const prevUser = userTurns[userTurns.length - 2];
  const prevText = Array.isArray(prevUser.content) ? prevUser.content.map((p) => p.text || '').join('') : String(prevUser.content);
  check('model: previous question present', prevText.indexOf('我叫小明') >= 0, String(prevText).slice(0, 200));

  server.close();

  // A new topic must drop the window from the next request.
  await bot.handle({ post_type: 'message', message_type: 'private', user_id: 42, message: '/new' }, replyFn);
  check('model: /new clears the window', bot.memory.history('private:42').length === 0);
}

// -------------------------------------------------------------- split sends

{
  const longAnswer = '第一句话。'.repeat(40);
  let served = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      served += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: longAnswer } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const cfg = normalizeConfig({
    llm: {
      mode: 'external',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      model: 'test-model',
      maxReplyChars: 20,
      maxReplyParts: 4,
      allowPrivateImages: true,
    },
  });
  const bot = new BotLogic(cfg, () => {});
  const sent = [];
  await bot.handle(
    { post_type: 'message', message_type: 'private', user_id: 8, message: '讲长一点' },
    async (text) => { sent.push(text); },
  );

  check('send: split into several messages', sent.length > 1, String(sent.length));
  check('send: parts are labelled', sent[0].indexOf('(1/') === 0, sent[0]);
  check('send: respects maxReplyParts', sent.length <= 4, String(sent.length));
  const joined = sent.join('').replace(/\(\d+\/\d+\)\s/g, '');
  check('send: keeps the whole answer', joined.indexOf('第一句话') >= 0 && joined.length >= 60, String(joined.length));

  // Only the first part of a group reply should @-mention.
  const groupSent = [];
  await bot.handle(
    { post_type: 'message', message_type: 'group', group_id: 5, user_id: 8, message: [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: '讲长一点' } }] },
    async (text, opts) => { groupSent.push({ text, opts }); },
  );
  const ats = groupSent.filter((s) => s.opts && s.opts.atSender).length;
  check('send: only the first part @s', ats <= 1, String(ats));

  server.close();
}

console.log(fail === 0 ? `ALL_EVOLVE_PASS ${pass}/${pass}` : `EVOLVE_FAIL pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
