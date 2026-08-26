/**
 * index.test.mjs — apply() 事件接线验证。
 *
 * 手法：
 *   - 假 ctx：EventTarget 式桩，记录 on/effect 调用并允许测试手动派发事件；
 *   - 假通道：经 overrides（apply 第三参，@internal 测试缝）注入记录器，
 *     不碰 Worker-A 的 channels/ 与真实网络；
 *   - overrides.config 直通已解析配置（defaultConfig 派生），单测与
 *     开发机 ~/.dsh/settings.yaml 完全解耦；
 *   - mock timers 驱动 coalesce 窗口，零真实等待。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, renderIconUrl } from './index.mjs';
import { defaultConfig } from './config.mjs';

/* ------------------------------------------------------------------ */
/* 测试基建                                                            */
/* ------------------------------------------------------------------ */

/** 基于 SPEC 5.3 默认值派生一份完整测试配置（深合并部分覆盖）。 */
function fullConfig(partial = {}) {
  const base = structuredClone(defaultConfig());
  for (const [key, value] of Object.entries(partial)) {
    if (base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      Object.assign(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return Object.freeze(base);
}

/** cordis ctx 桩：记录 on/effect；emit(name, payload) 手动触发已注册监听。 */
function makeFakeCtx() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  const effects = [];
  const logs = { info: [], warn: [] };
  return {
    listeners,
    effects,
    logs,
    logger: {
      info: (msg) => logs.info.push(String(msg)),
      warn: (msg) => logs.warn.push(String(msg)),
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return () => listeners.get(name).splice(listeners.get(name).indexOf(handler), 1);
    },
    effect(factory, label) {
      effects.push({ dispose: factory(), label });
    },
    emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) handler(payload);
    },
    runDisposers() {
      for (const effect of effects) effect.dispose();
    },
  };
}

/** 记录型假通道工厂。send 行为由每通道 options 控制（正常/同步抛/异步拒）。 */
function makeRecordingChannels(specs) {
  const sent = [];
  const channels = specs.map((spec) => ({
    name: spec.name,
    send: async (payload) => {
      sent.push({ channel: spec.name, payload });
      if (spec.mode === 'throw-sync') throw new Error(`${spec.name} 同步爆炸`);
      if (spec.mode === 'reject') throw new Error(`${spec.name} 异步爆炸`);
      if (spec.mode === 'hang') return new Promise(() => {}); // 永不落定
    },
  }));
  return { channels, sent };
}

/** 构造模拟 agent 对象（字段名依据 index.mjs 文件头研究结论）。 */
function makeAgent(overrides = {}) {
  const {
    id = 'sess-root-1234-abcd',
    delegationDepth = 0,
    subagentDepth,
    parentSession,
    origin = 'user',
    events = [],
  } = overrides;
  return {
    id,
    options: subagentDepth === undefined ? {} : { subagentDepth },
    session: {
      header: {
        delegationDepth,
        ...(parentSession !== undefined ? { parentSession } : {}),
        origin,
      },
      events,
    },
  };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ */
/* enabled / 注册行为                                                  */
/* ------------------------------------------------------------------ */

test('enabled:false 时 apply 不注册任何监听与清理', () => {
  const ctx = makeFakeCtx();
  apply(ctx, {}, { config: fullConfig({ enabled: false }) });
  assert.equal(ctx.listeners.size, 0);
  assert.equal(ctx.effects.length, 0);
});

test('默认配置下 apply 注册 agent/status 监听与一个清理 effect', () => {
  const ctx = makeFakeCtx();
  apply(ctx, {}, { config: fullConfig(), channels: [] });
  assert.ok(ctx.listeners.has('agent/status'));
  assert.equal(ctx.listeners.get('agent/status').length, 1);
  assert.equal(ctx.effects.length, 1);
});

/* ------------------------------------------------------------------ */
/* notifyOn 过滤                                                       */
/* ------------------------------------------------------------------ */

test('status 不在 notifyOn 中 → 不通知', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);
  apply(ctx, {}, { config: fullConfig({ notifyOn: ['idle'], coalesceWindowMs: 10 }), channels });

  ctx.emit('agent/status', { agent: makeAgent(), status: 'running' }); // 本安装版真实值之一
  await flushMicrotasks();
  t.mock.timers.tick(50);
  await flushMicrotasks();
  assert.equal(sent.length, 0);

  ctx.emit('agent/status', { agent: makeAgent(), status: 'idle' });
  await flushMicrotasks();
  t.mock.timers.tick(10);
  await flushMicrotasks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.event, 'idle');
});

/* ------------------------------------------------------------------ */
/* root 过滤                                                           */
/* ------------------------------------------------------------------ */

test('agents:root（默认）→ 子代理被过滤、顶层代理放行', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);
  apply(ctx, {}, { config: fullConfig({ coalesceWindowMs: 10 }), channels });

  // 子代理：header.delegationDepth=1 + parentSession + origin=subagent
  ctx.emit('agent/status', {
    agent: makeAgent({ id: 'child-aa', delegationDepth: 1, parentSession: 'p1', origin: 'subagent' }),
    status: 'idle',
  });
  // 子代理变体：仅 runtime subagentDepth=2（resumed 子代理的判据）
  ctx.emit('agent/status', { agent: makeAgent({ id: 'child-bb', subagentDepth: 2 }), status: 'idle' });
  // 顶层代理：depth 0 且无父痕迹
  ctx.emit('agent/status', { agent: makeAgent({ id: 'root-cc' }), status: 'idle' });

  await flushMicrotasks();
  t.mock.timers.tick(10);
  await flushMicrotasks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.sessionId, 'root-cc');
});

test('agents:all → 子代理也通知', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }, { name: 'rec2' }]);
  apply(ctx, {}, { config: fullConfig({ agents: 'all', coalesceWindowMs: 10 }), channels });

  ctx.emit('agent/status', {
    agent: makeAgent({ id: 'child-aa', delegationDepth: 1, origin: 'subagent' }),
    status: 'error',
  });
  await flushMicrotasks();
  t.mock.timers.tick(10);
  await flushMicrotasks();
  assert.equal(sent.length, 2); // 两个通道各一条
  assert.deepEqual(sent.map((s) => s.channel).sort(), ['rec', 'rec2']);
  assert.equal(sent[0].payload.event, 'error');
});

/* ------------------------------------------------------------------ */
/* coalesce 合并                                                       */
/* ------------------------------------------------------------------ */

test('同会话窗口内两次 idle → 只发最后一次 payload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);
  apply(ctx, {}, { config: fullConfig({ coalesceWindowMs: 100 }), channels });

  ctx.emit('agent/status', { agent: makeAgent({ id: 'same-session' }), status: 'idle' });
  ctx.emit('agent/status', { agent: makeAgent({ id: 'same-session' }), status: 'idle' });

  await flushMicrotasks();
  t.mock.timers.tick(100);
  await flushMicrotasks();
  assert.equal(sent.length, 1); // 合并为一次
});

test('不同会话各自独立发送', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);
  apply(ctx, {}, { config: fullConfig({ coalesceWindowMs: 100 }), channels });

  ctx.emit('agent/status', { agent: makeAgent({ id: 'session-one---' }), status: 'idle' });
  ctx.emit('agent/status', { agent: makeAgent({ id: 'session-two---' }), status: 'idle' });
  await flushMicrotasks();
  t.mock.timers.tick(100);
  await flushMicrotasks();
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((s) => s.payload.sessionId).sort(),
    ['session-one---', 'session-two---'],
  );
});

/* ------------------------------------------------------------------ */
/* 通道故障隔离                                                         */
/* ------------------------------------------------------------------ */

test('单通道同步抛错/异步拒绝不影响宿主与其他通道，仅产生 warn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([
    { name: 'bad-sync', mode: 'throw-sync' },
    { name: 'good', mode: 'ok' },
    { name: 'bad-async', mode: 'reject' },
  ]);
  apply(ctx, {}, { config: fullConfig({ coalesceWindowMs: 5 }), channels });

  assert.doesNotThrow(() => {
    ctx.emit('agent/status', { agent: makeAgent(), status: 'idle' });
  });

  await flushMicrotasks();
  t.mock.timers.tick(5);
  await flushMicrotasks();

  assert.equal(sent.filter((s) => s.channel === 'good').length, 1); // 好通道照常收到
  const warns = ctx.logs.warn;
  assert.ok(warns.some((w) => w.includes('bad-sync')), `应有 bad-sync 的 warn：${JSON.stringify(warns)}`);
  assert.ok(warns.some((w) => w.includes('bad-async')));
});

test('事件处理器绝不向宿主抛错：畸形 payload 与畸形 agent 都被吞掉并 warn', async () => {
  const ctx = makeFakeCtx();
  apply(ctx, {}, { config: fullConfig(), channels: [] });

  assert.doesNotThrow(() => ctx.emit('agent/status', undefined));
  assert.doesNotThrow(() => ctx.emit('agent/status', { agent: null, status: 'idle' }));
  assert.doesNotThrow(() => ctx.emit('agent/status', { agent: makeAgent(), status: 42 }));
  assert.doesNotThrow(() => ctx.emit('agent/status', {
    agent: {
      id: { toString() { throw new Error('id 炸了'); } },
      session: {},
    },
    status: 'idle',
  }));
  await flushMicrotasks();
});

/* ------------------------------------------------------------------ */
/* payload 形状                                                        */
/* ------------------------------------------------------------------ */

test('payload 符合 SPEC 5.1/7.4：event/title/body/sessionId/agentId/ts/iconUrl；标题折叠优先', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);

  // 会话日志同时有用户消息与标题事件 → body 取标题
  const titledAgent = makeAgent({
    events: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我重构通知插件' }] } },
      { type: 'session/title', data: { title: '重构通知插件' } },
    ],
  });
  apply(ctx, {}, { config: fullConfig({ maxBodyLength: 120, coalesceWindowMs: 5 }), channels });
  ctx.emit('agent/status', { agent: titledAgent, status: 'idle' });
  await flushMicrotasks();
  t.mock.timers.tick(5);
  await flushMicrotasks();

  assert.equal(sent.length, 1);
  const p = sent[0].payload;
  assert.equal(p.event, 'idle');
  assert.equal(p.title, '任务完成'); // 无 emoji（SPEC §7.1）；内置兜底与 format.mjs 同规格
  assert.equal(p.body, '重构通知插件');
  assert.equal(p.sessionId, 'sess-root-1234-abcd');
  assert.equal(p.agentId, 'sess-root-1234-abcd'); // Agent.id 即 SessionId
  assert.equal(typeof p.ts, 'number');
  // 默认 icons 段：enabled=true 但 urlTemplate 为空 → iconUrl 为空串
  assert.equal(p.iconUrl, '');
});

test('无标题无用户消息 → body 降级「会话 <前8位>」；超长文本按 maxBodyLength 截断', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);

  apply(ctx, {}, { config: fullConfig({ maxBodyLength: 12, coalesceWindowMs: 5 }), channels });

  const bareAgent = makeAgent({ id: 'abcdefgh-ijkl' }); // 无日志事件
  ctx.emit('agent/status', { agent: bareAgent, status: 'blocked' });
  const longTextAgent = makeAgent({
    id: 'zzzzzzzz-zzzz',
    events: [{
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这是一段远远超过十二个字符长度的用户输入文本' }] },
    }],
  });
  ctx.emit('agent/status', { agent: longTextAgent, status: 'idle' });

  await flushMicrotasks();
  t.mock.timers.tick(5);
  await flushMicrotasks();

  const byId = Object.fromEntries(sent.map((s) => [s.payload.sessionId, s.payload]));
  assert.equal(byId['abcdefgh-ijkl'].body, '会话 abcdefgh');
  assert.equal(byId['abcdefgh-ijkl'].title, '需要确认'); // blocked 文案（无 emoji）
  assert.ok(byId['abcdefgh-ijkl'].body.length <= 12 + '会话 '.length);
  assert.equal(byId['zzzzzzzz-zzzz'].body.length, 12); // 截断含省略号共 12 字符
  assert.ok(byId['zzzzzzzz-zzzz'].body.endsWith('…'));
});

/* ------------------------------------------------------------------ */
/* iconUrl 渲染（SPEC §7.3/§7.4）                                       */
/* ------------------------------------------------------------------ */

test('配置 urlTemplate 时 payload.iconUrl 按模板渲染 {event} 占位符', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);

  apply(ctx, {}, {
    config: fullConfig({
      coalesceWindowMs: 5,
      notifyOn: ['idle', 'error', 'blocked', 'goal-completed'],
      icons: { enabled: true, urlTemplate: 'https://host/icons/{event}.svg' },
    }),
    channels,
  });

  ctx.emit('agent/status', { agent: makeAgent({ id: 'icon-session-a' }), status: 'idle' });
  ctx.emit('agent/status', { agent: makeAgent({ id: 'icon-session-b' }), status: 'goal-completed' });
  await flushMicrotasks();
  t.mock.timers.tick(5);
  await flushMicrotasks();

  const byId = Object.fromEntries(sent.map((s) => [s.payload.sessionId, s.payload]));
  assert.equal(byId['icon-session-a'].iconUrl, 'https://host/icons/idle.svg');
  // encodeURIComponent 后再替换进模板（连字符编码不变，属预期）
  assert.equal(byId['icon-session-b'].iconUrl, 'https://host/icons/goal-completed.svg');
});

test('icons.enabled=false 时 payload.iconUrl 为空串，即使 urlTemplate 已配置', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);

  apply(ctx, {}, {
    config: fullConfig({
      coalesceWindowMs: 5,
      icons: { enabled: false, urlTemplate: 'https://host/icons/{event}.svg' },
    }),
    channels,
  });

  ctx.emit('agent/status', { agent: makeAgent(), status: 'error' });
  await flushMicrotasks();
  t.mock.timers.tick(5);
  await flushMicrotasks();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.iconUrl, '');
});

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

test('effect 清理后：pending 清空、后续事件不再产生通知', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  const { channels, sent } = makeRecordingChannels([{ name: 'rec' }]);
  apply(ctx, {}, { config: fullConfig({ coalesceWindowMs: 1000 }), channels });

  ctx.emit('agent/status', { agent: makeAgent(), status: 'idle' });
  ctx.runDisposers(); // 卸载插件

  t.mock.timers.tick(60_000);
  await flushMicrotasks();
  assert.equal(sent.length, 0); // pending 已清空，窗口到期也不发

  ctx.emit('agent/status', { agent: makeAgent(), status: 'idle' });
  t.mock.timers.tick(60_000);
  await flushMicrotasks();
  assert.equal(sent.length, 0); // disposed 后 push 被忽略
});

test('in-flight 发送在 dispose 后不被中断且失败不产生未处理拒绝', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeFakeCtx();
  let rejectSend;
  const slowChannel = [{
    name: 'slow',
    send: () => new Promise((_, reject) => { rejectSend = reject; }),
  }];
  apply(ctx, {}, { config: fullConfig({ coalesceWindowMs: 1 }), channels: slowChannel });

  ctx.emit('agent/status', { agent: makeAgent(), status: 'idle' });
  await flushMicrotasks();
  t.mock.timers.tick(1);
  await flushMicrotasks();

  ctx.runDisposers(); // 先卸载
  // in-flight 发送随后失败：必须被 dispatch 链路的 catch 吞掉，不得 unhandledRejection
  rejectSend(new Error('迟到的失败'));
  await flushMicrotasks();
  await flushMicrotasks();
  // 若实现错误，上面的未处理拒绝会让 node --test 以非零码退出
});

/* ------------------------------------------------------------------ */
/* renderIconUrl 纯函数（SPEC §7.4）                                    */
/* ------------------------------------------------------------------ */

const TEMPLATE = 'https://host/icons/{event}.svg';

test('renderIconUrl：enabled + 非空模板 → 替换 {event}（全部出现位置）', () => {
  assert.equal(renderIconUrl({ enabled: true, urlTemplate: TEMPLATE }, 'idle'), 'https://host/icons/idle.svg');
  assert.equal(
    renderIconUrl({ enabled: true, urlTemplate: 'https://h/{event}/x?e={event}' }, 'blocked'),
    'https://h/blocked/x?e=blocked',
  );
});

test('renderIconUrl：对事件名做 encodeURIComponent', () => {
  assert.equal(
    renderIconUrl({ enabled: true, urlTemplate: TEMPLATE }, 'a b&c=d'),
    'https://host/icons/a%20b%26c%3Dd.svg',
  );
});

test('renderIconUrl：禁用 / 缺段 / 模板为空 / 畸形配置 → 一律空串', () => {
  assert.equal(renderIconUrl({ enabled: false, urlTemplate: TEMPLATE }, 'idle'), '');
  assert.equal(renderIconUrl(undefined, 'idle'), '');
  assert.equal(renderIconUrl(null, 'idle'), '');
  assert.equal(renderIconUrl('nope', 'idle'), '');
  assert.equal(renderIconUrl({}, 'idle'), ''); // enabled 未设 → 视为关
  assert.equal(renderIconUrl({ enabled: true }, 'idle'), ''); // 模板缺失
  assert.equal(renderIconUrl({ enabled: true, urlTemplate: '   ' }, 'idle'), ''); // 空白模板
  assert.equal(renderIconUrl({ enabled: true, urlTemplate: 42 }, 'idle'), ''); // 非字符串模板
  assert.equal(defaultConfig().icons.enabled, true); // 默认配置本身是开启的
  assert.equal(renderIconUrl(defaultConfig().icons, 'error'), ''); // 但默认无模板 → ""
});
