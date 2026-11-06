// @local/qq-bot — DeepSeek Harness Host plugin entry point.
//
// 「零下载」QQ 机器人通道：插件不再下载 / 安装 / 启动 NapCat，也不再做扫码登录。
// 它现在做两件事：
//   1. 面板内「直聊测试」：不装任何东西就能验证收图、答题、记忆、指令、分段回复。
//   2. 连接真实 QQ：作为 OneBot v11 客户端，主动连到用户已有的任意 OneBot 实现
//      （正向 WebSocket）；同时仍保留反向 WebSocket / HTTP 上报服务端。
//
// 完全自包含（仅 Node 内置模块），所有资源都注册在 ctx.effect 内，卸载时清理干净。

import { OneBotBridge } from './lib/onebot.js';
import { BotLogic, normalizeConfig } from './lib/bot.js';
import { makeBridgeRoutes, createLogRing, createStats } from './lib/bridge.js';
import { ForwardManager } from './lib/forward.js';
import { ChatSimulator } from './lib/simulator.js';

export const name = '@local/qq-bot';

/**
 * @param {import('cordis').Context} ctx
 * @param {Record<string, any>} config - row.config from the patch (may be {})
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config || {});
  // Ring buffer shown in the DSH panel (and served over the bridge).
  const logRing = createLogRing(200);
  const stats = createStats();

  const log = (msg) => {
    const line = `[qq-bot] ${msg}`;
    logRing.push(String(msg));
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
      `llm=${cfg.llm.mode})`,
  );

  const bridge = new OneBotBridge(cfg);
  const logic = new BotLogic(cfg, log);

  // Hand the Host model services to the bot logic. `ctx.get` is the sanctioned
  // way to read an already-registered service; it returns null when the host
  // doesn't provide it, so every reference stays optional.
  const pick = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : (ctx[name] ?? null);
    } catch {
      return null;
    }
  };
  logic.llm = pick('llm');
  logic.agentDefaultModel = pick('agentDefaultModel');
  logic.attachments = pick('attachments');
  if (cfg.llm.mode === 'harness') {
    log(
      `模型来源: Harness 内置 (${logic.llm ? 'llm 服务已就绪' : 'llm 服务缺失'}` +
        `${logic.agentDefaultModel ? '，跟随 Harness 默认模型' : ''})`,
    );
  }

  // Long-term memory is loaded asynchronously; the bot works without it.
  logic.loadMemory().catch((err) => log(`记忆加载失败: ${err.message}`));

  bridge.on('log', log);
  bridge.on('error', (err) => log(`服务器错误: ${err.message}`));

  // Forward WebSocket manager: connect OUT to an already-running OneBot v11
  // server. No download / install / launch of any QQ client happens here.
  const forward = new ForwardManager(bridge, log);
  forward.init(cfg.forward);
  forward.on('connected', () => log('真实 QQ 通道已就绪（正向 WebSocket）'));

  // In-panel direct chat: exercises the same BotLogic pipeline as real QQ
  // messages, without requiring any external software.
  const simulator = new ChatSimulator(logic, log, { memory: logic.memory });

  // Each incoming event gets a reply function bound to its source. The bot
  // logic stays transport-agnostic; it never throws out of this handler.
  bridge.on('event', (event, replyFn) => {
    stats.received += 1;
    stats.lastAt = Date.now();
    logic.handle(event, replyFn).then((result) => {
      if (result && result.ok) stats.answered += 1;
      else {
        stats.failed += 1;
        stats.lastError = (result && result.error) || '未知错误';
      }
    }).catch((err) => {
      // Defensive guard: handle() is designed not to throw, but never let an
      // exception escape an event emitter and crash the host.
      stats.failed += 1;
      stats.lastError = err && err.message ? err.message : String(err);
      log(`处理事件时发生意外错误: ${stats.lastError}`);
    });
  });

  // Expose state + controls to the DSH Web UI panel (client.js fetches these
  // same-origin routes). webServer is optional: without it the panel simply
  // has no data, but the OneBot endpoint and panel chat still work.
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const routes = makeBridgeRoutes({
        cfg,
        bridge,
        log,
        logRing,
        stats,
        memory: logic.memory,
        forward,
        simulator,
        llm: logic.llm,
        agentDefaultModel: logic.agentDefaultModel,
        attachments: logic.attachments,
      });
      const disposers = [];
      for (const route of routes) {
        try {
          disposers.push(sctx.webServer.register(route));
        } catch (err) {
          log(`注册面板接口失败 ${route.path}: ${err.message}`);
        }
      }
      log(`面板接口已注册: ${routes.length} 个路由 (/api/qq-bot/*)`);
      return () => {
        for (const dispose of disposers) {
          try { dispose(); } catch { /* ignore */ }
        }
      };
    }, 'qq-bot: 面板接口');
  });

  // ctx.effect runs the callback immediately; the callback MUST return a
  // disposer, which the host calls on unload/reload. We start listening on the
  // next tick so apply() returns synchronously (some loaders expect that).
  ctx.effect(() => {
    let stopped = false;
    const disposer = () => {
      if (stopped) return;
      stopped = true;
      log('正在关闭 QQ 机器人通道…');
      // Flush long-term memory before the process/plugin goes away.
      try { logic.dispose(); } catch { /* ignore */ }
      forward.dispose();
      bridge.stop().catch((err) => log(`关闭时出错: ${err.message}`));
    };

    bridge.start()
      .then((addr) => {
        const a = addr && typeof addr === 'object' ? addr : { port: cfg.port };
        log(`OneBot 服务已启动: ${cfg.host}:${a.port}${cfg.path}`);
        log(`健康检查: http://127.0.0.1:${a.port}/health`);
        log(`反向 WebSocket 地址: ws://127.0.0.1:${a.port}${cfg.path}`);
      })
      .catch((err) => {
        log(`启动失败: ${err.message}`);
      });

    return disposer;
  }, 'qq-bot: OneBot 服务');

  log('插件已加载（零下载模式）。可直接在 DSH 面板「直聊测试」里发消息；接真实 QQ 只需填一个已有的 OneBot 正向 WebSocket 地址。');
}
