// Harness-native model backend for the QQ bot.
//
// Instead of an external OpenAI-compatible endpoint (which needs its own API
// key), this drives the model the user already selected *inside* DeepSeek
// Harness, through the Host `llm` service:
//
//   ctx.llm.stream({ provider, model, system, messages, maxTokens, ... })
//     -> AsyncIterable<StreamChunk>
//
// Images are handed to the model the way Harness itself does it: the bytes are
// committed with `ctx.attachments.saveImages()` and the resulting
// ImageAttachmentRef is placed in an `image` content block. No key, no
// endpoint, no extra dependency.
//
// Two things are deliberately defensive, because the exact runtime shape is a
// moving target:
//   1. Whether the selected model can actually see images is asked via
//      `ctx.llm.resolveModelInfo()` (inputModalities). When it cannot, the
//      images are dropped and the text question is still answered.
//   2. If a call that carries images fails, it is retried once as text-only.
//      A model that silently rejects images must not lose the whole turn.

import { downloadImage } from './vision.js';

const NL = String.fromCharCode(10);

/** ImageMediaType values `ctx.attachments.saveImages` accepts. */
const SUPPORTED_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Common aliases that are not in ImageMediaType but map cleanly onto one. */
const MEDIA_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};

/**
 * Ask the Harness-selected model.
 *
 * @param {{llm?: any, agentDefaultModel?: any, attachments?: any}} refs
 *   Host service references captured by index.js (any of them may be missing
 *   when the host does not provide the service).
 * @param {object} config - the `llm` config block
 * @param {{text?: string, images?: string[], history?: Array<any>,
 *   memory?: string[], extraSystem?: string}} input
 * @param {(msg: string) => void} [log]
 * @returns {Promise<string>} the assistant reply text
 */
export async function askHarness(refs, config, input, log = () => {}) {
  const llm = refs && refs.llm;
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('未接入 Harness 模型服务 (ctx.llm)，请升级 Harness 或改用外部接口 (llm.mode: external)');
  }

  const cfg = config || {};
  const selection = resolveSelection(refs, cfg);
  if (!selection.provider || !selection.model) {
    throw new Error('Harness 还没有选择默认模型：请先在 Harness 里选一个模型（或配置 llm.provider / llm.model）');
  }

  const maxTokens = clampInt(cfg.maxTokens, 1, 32768, 1024);
  const timeoutMs = clampInt(cfg.timeoutMs, 1000, 600000, 60000);
  const temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.4;

  const system = buildSystem(cfg, input);

  // Images: only worth downloading when the model can actually take them.
  const urls = (input.images || []).filter(Boolean).slice(0, 4);
  const wantsImages = urls.length > 0;
  let imageBlocks = [];
  let skippedImages = 0;

  if (wantsImages) {
    const canSee = await supportsImages(llm, selection, log);
    if (canSee) {
      const prepared = await prepareImages(refs, urls, cfg, log);
      imageBlocks = prepared.blocks;
      skippedImages = prepared.skipped;
    } else if (cfg.textOnlyFallbackOnVision !== false) {
      // The selected model cannot see images: drop them and still answer the
      // text part, telling the model to say so if it was asked about the image.
      skippedImages = urls.length;
      log(`当前模型 ${selection.provider}/${selection.model} 不支持图片输入，改为只回答文字`);
    } else {
      // Policy says refuse instead: a clear error beats a silent half-answer.
      throw new Error('当前选择的模型不支持图片输入，无法处理图片消息');
    }
  }

  const content = [];
  const text = String(input.text || '').trim();
  if (text) content.push({ type: 'text', text });
  for (const block of imageBlocks) content.push(block);
  // Tagged so the text-only retry below can drop this note again — once the
  // images are gone, telling the model about them is just noise.
  const skippedNote = { type: 'text', text: `（对方还发了 ${skippedImages} 张图片，但当前模型看不了图片，请直接回答文字问题；如果对方是在问图片内容，请说明你看不到图片。）` };
  if (skippedImages > 0 && text) {
    content.push(skippedNote);
  }
  if (content.length === 0) content.push({ type: 'text', text: '（用户未输入内容）' });

  // RequestUserInput: { role: 'user', content: ContentBlock[] }.
  // History is folded into the system prompt as plain text on purpose — the
  // RequestMessage union has no assistant variant without fabricating message
  // ids and sources, and a text recap is understood by every adapter.
  const messages = [{ role: 'user', content }];

  let answer;
  try {
    answer = await runStream(llm, { ...selection, system, messages, maxTokens, temperature, timeoutMs });
  } catch (err) {
    if (imageBlocks.length === 0) throw err;
    // Retry once without images: the model may reject them at request time
    // even when resolveModelInfo advertised image input.
    log(`携带图片的模型调用失败（${err.message}），改为纯文字重试`);
    const retryContent = [];
    for (const block of content) {
      // Keep only the real user text; drop the image blocks and the
      // "there were images you can't see" note, which no longer applies.
      if (block.type !== 'text') continue;
      if (block === skippedNote) continue;
      retryContent.push(block);
    }
    if (retryContent.length === 0) {
      retryContent.push({ type: 'text', text: text || '（用户未输入内容）' });
    }
    answer = await runStream(llm, {
      ...selection,
      system,
      messages: [{ role: 'user', content: retryContent }],
      maxTokens,
      temperature,
      timeoutMs,
    });
  }

  if (!answer) throw new Error('模型没有返回可识别的文字内容');
  return answer;
}

/**
 * Provider + model: an explicit patch override wins, otherwise whatever the
 * user picked in Harness.
 */
function resolveSelection(refs, cfg) {
  const picked = refs && refs.agentDefaultModel && typeof refs.agentDefaultModel.currentSelection === 'function'
    ? safe(() => refs.agentDefaultModel.currentSelection())
    : null;
  const provider = String((cfg && cfg.provider) || picked?.provider || '').trim();
  const model = String((cfg && cfg.model) || picked?.model || '').trim();
  const reasoningEffort = String((cfg && cfg.reasoningEffort) || picked?.reasoningEffort || '').trim();
  return { provider, model, reasoningEffort };
}

/**
 * Does the selected model accept images? Unknown is treated as "yes": the
 * text-only retry in askHarness covers a wrong guess.
 */
async function supportsImages(llm, selection, log) {
  if (typeof llm.resolveModelInfo !== 'function') return true;
  try {
    const info = await llm.resolveModelInfo(selection.provider, selection.model);
    const mods = info && info.inputModalities;
    if (Array.isArray(mods) && mods.length > 0) return mods.indexOf('image') >= 0;
  } catch (err) {
    log(`无法确认模型的图片能力（${err && err.message ? err.message : err}），按支持处理`);
  }
  return true;
}

/**
 * Download each image and commit it as a Harness attachment so it can be
 * referenced from a request content block.
 *
 * @returns {Promise<{blocks: Array<{type:'image',attachment:any}>, skipped: number}>}
 */
async function prepareImages(refs, urls, cfg, log) {
  const attachments = refs && refs.attachments;
  if (!attachments || typeof attachments.saveImages !== 'function') {
    log('缺少附件服务 (ctx.attachments)，本次不带图片');
    return { blocks: [], skipped: urls.length };
  }

  const maxImageBytes = clampInt(cfg.maxImageBytes, 1024, 64 * 1024 * 1024, 8 * 1024 * 1024);
  const allowPrivate = cfg.allowPrivateImages === true;

  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        return await downloadImage(url, {
          maxBytes: maxImageBytes,
          timeoutMs: Math.min(clampInt(cfg.timeoutMs, 1000, 600000, 60000), 45000),
          allowPrivate,
        });
      } catch (err) {
        log(`图片下载失败: ${err.message}`);
        return null;
      }
    }),
  );

  const inputs = [];
  let skipped = 0;
  for (const img of results) {
    if (!img || !img.dataUri) { skipped += 1; continue; }
    const mediaType = normalizeMedia(img.mime);
    if (!mediaType) { skipped += 1; continue; }
    const base64 = img.dataUri.indexOf(',') >= 0 ? img.dataUri.slice(img.dataUri.indexOf(',') + 1) : img.dataUri;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) { skipped += 1; continue; }
    inputs.push({ data: new Uint8Array(buf), mediaType, name: 'qq-image' });
  }
  if (inputs.length === 0) return { blocks: [], skipped: skipped || urls.length };

  let refs2 = [];
  try {
    refs2 = await attachments.saveImages(inputs);
  } catch (err) {
    log(`图片保存失败: ${err.message}`);
    return { blocks: [], skipped: urls.length };
  }

  const blocks = [];
  for (const ref of refs2 || []) {
    if (ref) blocks.push({ type: 'image', attachment: ref });
  }
  skipped += inputs.length - blocks.length;
  return { blocks, skipped };
}

function normalizeMedia(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (SUPPORTED_MEDIA.indexOf(m) >= 0) return m;
  if (MEDIA_ALIASES[m]) return MEDIA_ALIASES[m];
  return null;
}

/** Run one stream and collect the assistant text. */
async function runStream(llm, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let out = '';
  const blockTexts = [];
  try {
    const iterable = llm.stream({
      provider: options.provider,
      model: options.model,
      system: options.system,
      messages: options.messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      signal: controller.signal,
    });
    for await (const chunk of iterable) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        out += chunk.text;
      } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        blockTexts.push(chunk.block.text);
      } else if (chunk.type === 'finish') {
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // Adapters that only emit whole blocks (no deltas) still get their text.
  if (!out && blockTexts.length > 0) out = blockTexts.join('');
  return out.trim();
}

/**
 * System prompt: base prompt + per-turn guidance + remembered facts + a short
 * recap of the recent exchange.
 */
function buildSystem(cfg, input) {
  const parts = [String(cfg.systemPrompt || '').trim() || '你是 QQ 里的智能助手，请用简洁、友好的中文回答问题。'];

  const extra = String(input.extraSystem || '').trim();
  if (extra) parts.push(extra);

  const memory = Array.isArray(input.memory) ? input.memory.filter(Boolean).slice(-20) : [];
  if (memory.length > 0) {
    parts.push('以下是你在之前的对话里了解到的关于这位用户的信息，请自然地运用它们，但不要逐条复述，也不要主动提到"我记得"：');
    for (const fact of memory) parts.push(`- ${String(fact)}`);
  }

  const recap = recapHistory(input.history);
  if (recap) {
    parts.push('这是你们最近几轮的对话（仅供理解语境，不要复述）：');
    parts.push(recap);
  }
  return parts.join(NL);
}

function recapHistory(history) {
  if (!Array.isArray(history)) return '';
  const lines = [];
  for (const turn of history.slice(-12)) {
    if (!turn) continue;
    if (typeof turn.content === 'string' && turn.content.trim()) {
      const role = turn.role === 'assistant' ? '你' : '用户';
      lines.push(`${role}：${turn.content.trim()}`);
      continue;
    }
    const user = typeof turn.user === 'string' ? turn.user.trim() : '';
    const bot = typeof turn.bot === 'string' ? turn.bot.trim() : '';
    if (user) lines.push(`用户：${user}`);
    if (bot) lines.push(`你：${bot}`);
  }
  return lines.join(NL);
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
