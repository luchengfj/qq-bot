// Tests for lib/harness-llm.js — the Harness-native model backend.
//
// Everything is exercised against fake `llm` / `agentDefaultModel` /
// `attachments` services that follow the shapes found in the Harness bundle
// (GenerateOptions, RequestUserInput, ImageAttachmentRef, StreamChunk). No
// real model is called, so these tests run offline and in CI.

import http from 'node:http';
import assert from 'node:assert/strict';
import { askHarness } from '../lib/harness-llm.js';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

/** A tiny PNG served on loopback so downloadImage has something real to do. */
async function startImageServer() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/a.png` };
}

/** Fake llm service that records the last GenerateOptions and streams text. */
function makeLlm(options = {}) {
  const calls = [];
  const llm = {
    calls,
    async resolveModelInfo(provider, model) {
      if (options.resolveError) throw new Error(options.resolveError);
      return options.modalities
        ? { provider, id: model, name: model, inputModalities: options.modalities }
        : { provider, id: model, name: model };
    },
    async *stream(opts) {
      calls.push(opts);
      if (options.streamError && (!options.onlyFirst || calls.length === 1)) {
        throw new Error(options.streamError);
      }
      for (const piece of options.pieces || ['你好']) {
        yield { type: 'text-delta', index: 0, text: piece };
      }
      yield { type: 'finish', reason: 'stop' };
    },
  };
  return llm;
}

function makeAttachments() {
  const saved = [];
  return {
    saved,
    async saveImages(inputs) {
      for (const input of inputs) saved.push(input);
      return inputs.map((input, i) => ({
        attachmentId: `att-${i}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
        name: input.name,
      }));
    },
  };
}

const baseCfg = {
  mode: 'harness',
  systemPrompt: '你是助手',
  maxTokens: 512,
  timeoutMs: 5000,
  maxImageBytes: 1024 * 1024,
  allowPrivateImages: true,
};

const main = async () => {
  const { server, url } = await startImageServer();

  console.log('harness-llm: 服务缺失与模型未选');

  await checkAsync('缺少 ctx.llm 时给出可操作的错误', async () => {
    await assert.rejects(
      () => askHarness({}, baseCfg, { text: '你好' }),
      /未接入 Harness 模型服务/,
    );
  });

  await checkAsync('有 llm 但没有选择模型时报错', async () => {
    await assert.rejects(
      () => askHarness({ llm: makeLlm() }, baseCfg, { text: '你好' }),
      /还没有选择默认模型/,
    );
  });

  console.log('harness-llm: 模型选择');

  await checkAsync('跟随 Harness 当前选择的模型', async () => {
    const llm = makeLlm();
    const picked = {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    };
    const out = await askHarness({ llm, agentDefaultModel: picked }, baseCfg, { text: '你好' });
    assert.equal(out, '你好');
    assert.equal(llm.calls[0].provider, 'deepseek');
    assert.equal(llm.calls[0].model, 'deepseek-chat');
  });

  await checkAsync('配置里的 provider/model 覆盖 Harness 选择', async () => {
    const llm = makeLlm();
    const picked = { currentSelection: () => ({ provider: 'a', model: 'b' }) };
    await askHarness(
      { llm, agentDefaultModel: picked },
      { ...baseCfg, provider: 'override-p', model: 'override-m' },
      { text: '你好' },
    );
    assert.equal(llm.calls[0].provider, 'override-p');
    assert.equal(llm.calls[0].model, 'override-m');
  });

  console.log('harness-llm: 请求结构');

  await checkAsync('messages 是 RequestUserInput，content 为内容块数组', async () => {
    const llm = makeLlm();
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await askHarness({ llm, agentDefaultModel: picked }, baseCfg, { text: '在吗' });
    const call = llm.calls[0];
    assert.equal(call.messages.length, 1);
    assert.equal(call.messages[0].role, 'user');
    assert.ok(Array.isArray(call.messages[0].content));
    assert.deepEqual(call.messages[0].content[0], { type: 'text', text: '在吗' });
    // No fabricated ids/sources — those belong to persisted Message, not input.
    assert.equal(call.messages[0].id, undefined);
    assert.equal(call.messages[0].source, undefined);
  });

  await checkAsync('system 里带上长期记忆与最近对话', async () => {
    const llm = makeLlm();
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await askHarness(
      { llm, agentDefaultModel: picked },
      baseCfg,
      {
        text: '那它呢',
        memory: ['用户叫小明', '用户住在杭州'],
        history: [{ user: '天空是什么颜色', bot: '蓝色' }],
        extraSystem: '请简短回答',
      },
    );
    const system = llm.calls[0].system;
    assert.ok(system.includes('你是助手'), '基础提示词');
    assert.ok(system.includes('请简短回答'), '临时指引');
    assert.ok(system.includes('- 用户叫小明'), '记忆条目');
    assert.ok(system.includes('用户：天空是什么颜色'), '历史用户轮');
    assert.ok(system.includes('你：蓝色'), '历史助手轮');
  });

  await checkAsync('maxTokens / temperature / signal 传递', async () => {
    const llm = makeLlm();
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await askHarness(
      { llm, agentDefaultModel: picked },
      { ...baseCfg, maxTokens: 777, temperature: 0.1 },
      { text: 'x' },
    );
    assert.equal(llm.calls[0].maxTokens, 777);
    assert.equal(llm.calls[0].temperature, 0.1);
    assert.ok(llm.calls[0].signal instanceof AbortSignal);
  });

  console.log('harness-llm: 图片处理');

  await checkAsync('模型支持图片：下载并作为附件传入', async () => {
    const llm = makeLlm({ modalities: ['text', 'image'] });
    const attachments = makeAttachments();
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await askHarness(
      { llm, agentDefaultModel: picked, attachments },
      baseCfg,
      { text: '看图', images: [url] },
    );
    assert.equal(attachments.saved.length, 1, '保存了一张图');
    assert.equal(attachments.saved[0].mediaType, 'image/png');
    const content = llm.calls[0].messages[0].content;
    const imageBlock = content.find((b) => b.type === 'image');
    assert.ok(imageBlock, '存在 image 内容块');
    assert.equal(imageBlock.attachment.attachmentId, 'att-0');
    assert.equal(imageBlock.attachment.mediaType, 'image/png');
  });

  await checkAsync('模型不支持图片：不传图，并提示模型说明看不到', async () => {
    const llm = makeLlm({ modalities: ['text'] });
    const attachments = makeAttachments();
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await askHarness(
      { llm, agentDefaultModel: picked, attachments },
      baseCfg,
      { text: '这是什么', images: [url] },
    );
    assert.equal(attachments.saved.length, 0, '不应该保存附件');
    const content = llm.calls[0].messages[0].content;
    assert.ok(!content.some((b) => b.type === 'image'), '不应有 image 块');
    const note = content.map((b) => b.text || '').join('');
    assert.ok(note.includes('看不了图片'), `应提示看不到图片，实际: ${note}`);
  });

  await checkAsync('缺少附件服务时不带图片，但仍回答文字', async () => {
    const llm = makeLlm({ modalities: ['text', 'image'] });
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    const out = await askHarness({ llm, agentDefaultModel: picked }, baseCfg, {
      text: '你好',
      images: [url],
    });
    assert.equal(out, '你好');
    const content = llm.calls[0].messages[0].content;
    assert.ok(!content.some((b) => b.type === 'image'));
  });

  await checkAsync('带图调用失败时自动降级为纯文字重试', async () => {
    const llm = makeLlm({
      modalities: ['text', 'image'],
      streamError: '模型拒绝了图片',
      onlyFirst: true,
      pieces: ['文字重试成功'],
    });
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    const out = await askHarness({ llm, agentDefaultModel: picked, attachments: makeAttachments() }, baseCfg, {
      text: '讲个笑话',
      images: [url],
    });
    assert.equal(out, '文字重试成功');
    assert.equal(llm.calls.length, 2, '应重试一次');
    const retry = llm.calls[1].messages[0].content;
    assert.ok(!retry.some((b) => b.type === 'image'), '重试不带图片');
    assert.deepEqual(retry[0], { type: 'text', text: '讲个笑话' });
  });

  await checkAsync('无图时失败不会重试', async () => {
    const llm = makeLlm({ streamError: 'boom' });
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await assert.rejects(
      () => askHarness({ llm, agentDefaultModel: picked }, baseCfg, { text: 'x' }),
      /boom/,
    );
    assert.equal(llm.calls.length, 1);
  });

  console.log('harness-llm: 流式结果收集');

  await checkAsync('拼接 text-delta 片段', async () => {
    const llm = makeLlm({ pieces: ['你', '好', '呀'] });
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    const out = await askHarness({ llm, agentDefaultModel: picked }, baseCfg, { text: 'x' });
    assert.equal(out, '你好呀');
  });

  await checkAsync('只有整块 block-end 时也能取到文本', async () => {
    const llm = {
      async resolveModelInfo() { return {}; },
      async *stream() {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '整块返回' } };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    const out = await askHarness({ llm, agentDefaultModel: picked }, baseCfg, { text: 'x' });
    assert.equal(out, '整块返回');
  });

  await checkAsync('模型返回空内容时报错', async () => {
    const llm = makeLlm({ pieces: ['   '] });
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await assert.rejects(
      () => askHarness({ llm, agentDefaultModel: picked }, baseCfg, { text: 'x' }),
      /没有返回可识别的文字内容/,
    );
  });

  await checkAsync('resolveModelInfo 报错时按支持图片处理', async () => {
    const llm = makeLlm({ resolveError: '无法查询模型信息' });
    const attachments = makeAttachments();
    const picked = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    await askHarness({ llm, agentDefaultModel: picked, attachments }, baseCfg, {
      text: '看图',
      images: [url],
    });
    assert.equal(attachments.saved.length, 1, '未知能力时仍尝试带图');
  });

  server.close();

  console.log(`\n${fail === 0 ? 'ALL_HARNESS_PASS' : 'HARNESS_FAILURES'} ${pass}/${pass + fail}`);
  if (fail > 0) process.exitCode = 1;
};

main().catch((err) => {
  console.error('测试脚本异常:', err);
  process.exitCode = 1;
});
