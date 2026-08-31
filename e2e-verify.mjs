/**
 * e2e-verify.mjs — 对已安装的 dsh-task-notify 做真实链路验证。
 *
 * 与 npm test 的区别：npm test 用 overrides 注入假通道/假时钟；本脚本走生产路径，
 * 用真实的 resolveConfig 读真实的 ~/.dsh/settings.yaml，真实的 channels/index.mjs
 * 装载真实通道，真实的 coalesceWindowMs 计时。
 *
 * 两趟：
 *   A. dry-run  —— createChannels 换成捕获型通道，不发通知，只断言 payload 组装。
 *   B. live     —— 完全不注入 overrides，真实 macOS osascript 弹一条系统通知。
 *
 * 用法：node e2e-verify.mjs [--live]   （不带 --live 只跑 A）
 */

import { readFileSync } from 'node:fs';
import { resolveConfig, resolveConfigDetailed } from './config.mjs';

// 关键：从已安装路径导入，而非源码
const INSTALLED = '/Users/paimon/.dsh/profiles/web/node_modules/dsh-task-notify';
const mod = await import(`${INSTALLED}/index.mjs`);
const { apply, isRootAgent, deriveBody, renderIconUrl } = mod;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** 最小 cordis ctx 模拟：足够跑通 apply() 的全部契约调用点。 */
function makeCtx() {
  const listeners = new Map();
  const disposers = [];
  const logs = { info: [], warn: [] };
  const ctx = {
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    effect(fn, label) {
      try {
        const disposer = fn();
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        logs.warn.push(`[effect:${label}] ${error.message}`);
      }
      return () => {};
    },
  };
  return { ctx, listeners, disposers, logs };
}

/** 一个形状足够真实的顶层代理：有 session 标题事件 + 用户消息。 */
const rootAgent = {
  id: 'sess-abc-12345',
  options: { subagentDepth: 0 },
  session: {
    header: { delegationDepth: 0, origin: 'host' },
    events: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修一下 dsh-task-notify' }] } },
      { type: 'session/title', data: { title: '修复任务通知插件' } },
    ],
  },
};
const childAgent = {
  id: 'sess-child-999',
  options: { subagentDepth: 1 },
  session: { header: { delegationDepth: 1, parentSession: 'sess-abc-12345', origin: 'subagent' }, events: [] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 前置：配置解析（读真实 settings.yaml）                                */
/* ------------------------------------------------------------------ */

const cfg = resolveConfig(undefined, process.env);
check('config.enabled 开启', cfg.enabled === true, `enabled=${cfg.enabled}`);
check('config.notifyOn 已无 completed', !cfg.notifyOn.includes('completed'), `notifyOn=${cfg.notifyOn.join(',')}`);
check('settings.yaml 的 task-notify 段被读取（含 goal-completed opt-in）',
  cfg.notifyOn.includes('goal-completed') && cfg.notifyOn.length === 4,
  cfg.notifyOn.join(','));
check('config.desktop.enabled=auto', cfg.desktop.enabled === 'auto', cfg.desktop.enabled);
check('config.format 段存在', cfg.format?.time === 'short' && cfg.format?.showDuration === true,
  `${cfg.format?.time}/${cfg.format?.showDuration}`);
check('KNOWN_EVENTS 白名单拒绝 completed（回退默认 + warn）',
  (() => {
    const { config, warnings } = resolveConfigDetailed({ notifyOn: ['completed'] }, {}, null);
    return config.notifyOn.length === 3 && warnings.some((w) => w.includes('未知事件 "completed"'));
  })(),
  (() => {
    const { warnings } = resolveConfigDetailed({ notifyOn: ['completed'] }, {}, null);
    return warnings.find((w) => w.includes('未知事件')) ?? '未触发告警';
  })());

/* ------------------------------------------------------------------ */
/* 前置：代理判定                                                        */
/* ------------------------------------------------------------------ */

check('isRootAgent(root)=true', isRootAgent(rootAgent) === true);
check('isRootAgent(child)=false', isRootAgent(childAgent) === false);
check('deriveBody 取 session/title', deriveBody(rootAgent, rootAgent.id) === '修复任务通知插件');
check('renderIconUrl 无模板时为空串', renderIconUrl(cfg.icons, 'idle') === '');

/* ------------------------------------------------------------------ */
/* A. dry-run：捕获型通道，断言 payload                                  */
/* ------------------------------------------------------------------ */

async function runDryRun() {
  const captured = [];
  const { ctx, listeners, disposers, logs } = makeCtx();

  apply(ctx, {}, {
    createChannels: async () => [{
      name: 'capture',
      send: (payload) => { captured.push(payload); },
    }],
  });

  check('A1: 注册了 agent/status 监听', typeof listeners.get('agent/status') === 'function');

  const handler = listeners.get('agent/status');
  handler({ agent: rootAgent, status: 'idle' });                 // 目标事件
  handler({ agent: childAgent, status: 'idle' });                // 子代理 → 过滤
  handler({ agent: rootAgent, status: 'running' });              // 非目标事件 → 过滤
  if (cfg.notifyOn.includes('goal-completed')) {
    handler({ agent: rootAgent, status: 'goal-completed' });     // 窗口内第二个目标事件
  } else {
    handler({ agent: rootAgent, status: 'goal-completed' });     // 未 opt-in → 过滤
  }
  handler(null);                                                  // 空 payload → 不抛

  await sleep(cfg.coalesceWindowMs + 700);
  check('A2: 合并窗口内同会话只发一次', captured.length === 1, `captured=${captured.length}`);

  const p = captured[0] ?? {};
  check('A3: event 为窗口内最后的目标事件',
    p.event === (cfg.notifyOn.includes('goal-completed') ? 'goal-completed' : 'idle'), p.event);
  check('A4: title 非空', typeof p.title === 'string' && p.title.trim() !== '', p.title);
  check('A5: body 含会话标题', typeof p.body === 'string' && p.body.includes('修复任务通知插件'), p.body);
  check('A6: sessionId/agentId 一致', p.sessionId === 'sess-abc-12345' && p.agentId === 'sess-abc-12345',
    `${p.sessionId}/${p.agentId}`);
  check('A7: durationMs 为有限数字', Number.isFinite(p.durationMs) && p.durationMs >= 0, `${p.durationMs}ms`);
  check('A8: iconUrl 为空串', p.iconUrl === '', JSON.stringify(p.iconUrl));
  check('A9: 无 warn 日志', logs.warn.length === 0, logs.warn.join(' | '));

  // effect 清理
  disposers.forEach((d) => d());
  const capturedAfter = captured.length;
  handler({ agent: rootAgent, status: 'idle' });
  await sleep(cfg.coalesceWindowMs + 500);
  check('A10: dispose 后不再分发', captured.length === capturedAfter,
    `${capturedAfter} → ${captured.length}`);
}

/* ------------------------------------------------------------------ */
/* B. live：真实 macOS 通知                                             */
/* ------------------------------------------------------------------ */

async function runLive() {
  const { ctx, listeners, logs } = makeCtx();
  apply(ctx, {}); // 零 overrides：真实 resolveConfig + 真实通道
  check('B1: 生产路径注册了监听', typeof listeners.get('agent/status') === 'function');

  const handler = listeners.get('agent/status');
  handler({ agent: rootAgent, status: 'idle' });
  await sleep(cfg.coalesceWindowMs + 2500); // 通道是子进程，留足时间

  const fail = logs.warn.filter((w) => w.includes('发送失败'));
  const ok = logs.info.filter((w) => w.includes('发送成功'));
  check('B2: 桌面通道真实发送', ok.length > 0 || fail.length === 0,
    ok.length > 0 ? `${ok.length} 个通道成功` : (fail[0] ?? '无日志（桌面可能被禁用）'));
  if (fail.length) check('B2: 无发送失败', false, fail.join(' | '));
}

/* ------------------------------------------------------------------ */

try {
  await runDryRun();
  if (process.argv.includes('--live')) await runLive();
} catch (error) {
  check('未捕获异常', false, error.stack);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n────────────────────────────────────────`);
console.log(`total ${results.length}  pass ${results.length - failed.length}  fail ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  process.exitCode = 1;
}
