// @local/qq-bot — DeepSeek Harness Host plugin entry point.
//
// This plugin turns this Harness into a QQ bot "channel": it opens a OneBot v11
// reverse-WebSocket / HTTP endpoint that NapCat, Lagrange, LLOneBot, or
// go-cqhttp can connect to. Incoming QQ messages (including images) are parsed
// and answered through a configurable OpenAI-compatible chat/vision endpoint,
// and the reply is sent back to QQ.
//
// It is fully self-contained (Node built-ins only) and drives its own LLM call,
// so it does not depend on any particular Harness internal Agent API. Everything
// is registered inside ctx.effect so it is torn down cleanly on unload/reload.

import { OneBotBridge } from './lib/onebot.js';
import { BotLogic, normalizeConfig } from './lib/bot.js';
import { SetupConsole } from './lib/setup.js';

export const name = '@local/qq-bot';

/**
 * @param {import('cordis').Context} ctx
 * @param {Record<string, any>} config - row.config from the patch (may be {})
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config || {});
  const log = (msg) => {
    const line = `[qq-bot] ${msg}`;
    // Prefer the host logger when available; always mirror to console.
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(line);
      else console.log(line);
    } catch {
      console.log(line);
    }
  };

  log(
    `初始化: 监听 ${cfg.host}:${cfg.port}${cfg.path} (replyVia=${cfg.replyVia}, ` +
      `llm=${cfg.llm.model} @ ${cfg.llm.baseUrl})`,
  );

  const bridge = new OneBotBridge(cfg);
  const logic = new BotLogic(cfg, log);

  // Setup console: /setup + /api/* for QQ 扫码登录 and 一键接入.
  try {
    bridge.setup = new SetupConsole(cfg, bridge, log);
  } catch (err) {
    log(`控制台初始化失败: ${err.message}`);
  }

  bridge.on('log', log);
  bridge.on('error', (err) => log(`服务器错误: ${err.message}`));

  // Each incoming event gets a reply function bound to its source. The bot
  // logic stays transport-agnostic; it never throws out of this handler.
  bridge.on('event', (event, replyFn) => {
    logic.handle(event, replyFn).catch((err) => {
      // Defensive guard: handle() is designed not to throw, but never let an
      // exception escape an event emitter and crash the host.
      log(`处理事件时发生意外错误: ${err && err.message ? err.message : String(err)}`);
    });
  });

  // ctx.effect runs the callback immediately; the callback MUST return a
  // disposer, which the host calls on unload/reload. We start listening on the
  // next tick so apply() returns synchronously (some loaders expect that).
  ctx.effect(() => {
    let stopped = false;
    const disposer = () => {
      if (stopped) return;
      stopped = true;
      log('正在关闭 OneBot 服务…');
      bridge.stop().catch((err) => log(`关闭时出错: ${err.message}`));
    };

    bridge.start()
      .then((addr) => {
        const a = addr && typeof addr === 'object' ? addr : { port: cfg.port };
        log(`OneBot 服务已启动: ${cfg.host}:${a.port}${cfg.path}`);
        log(`健康检查: http://127.0.0.1:${a.port}/health`);
        log(`扫码登录 / 一键接入控制台: http://127.0.0.1:${a.port}/setup`);
      })
      .catch((err) => {
        log(`启动失败: ${err.message}`);
      });

    return disposer;
  }, 'qq-bot: OneBot 服务');

  log('插件已加载。请在 NapCat/Lagrange 中配置反向 WebSocket 客户端连接到此地址。');
}
