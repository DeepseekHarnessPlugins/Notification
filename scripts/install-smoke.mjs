// Install-path smoke for dsh-task-notify (v0.3.0):
//   - package entry loads and exports the public API
//   - apply() with a mock ctx registers the agent/status listener
//   - a synthetic event flows through to a recorded channel send
//   - the v0.3 composed body joins summary + formatted local time
import assert from 'node:assert/strict';
import { apply, name, inject } from 'dsh-task-notify';

assert.equal(name, 'task-notify');
assert.ok(Array.isArray(inject));
assert.equal(typeof apply, 'function');

const testConfig = Object.freeze({
  enabled: true,
  notifyOn: ['idle', 'error', 'blocked', 'goal-completed'],
  agents: 'root',
  coalesceWindowMs: 50,
  maxBodyLength: 120,
  desktop: { enabled: 'auto', sound: true },
  bark: { enabled: false, server: 'https://api.day.app', deviceKey: '', sound: '' },
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
  serverchan: { enabled: false, sendKey: '' },
  webhook: { enabled: false, url: '', headers: {} },
  icons: { enabled: true, urlTemplate: '' },
  format: { time: 'short', showDuration: true },
});

function makeCtx() {
  const listeners = new Map();
  const effects = [];
  const logs = { info: [], warn: [] };
  return {
    listeners, effects, logs,
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return () => listeners.get(name).splice(listeners.get(name).indexOf(handler), 1);
    },
    effect(factory, label) { effects.push({ dispose: factory(), label }); },
    emit(name, payload) { for (const h of listeners.get(name) ?? []) h(payload); },
    runDisposers() { for (const e of effects) e.dispose(); },
  };
}

// Build the expected time string from the SAME source the plugin will use:
// a frozen Date at local 14:32, then formatTime-equivalent HH:mm.
const fixedDate = new Date(2026, 7, 26, 14, 32, 0);
const expectedHH = String(fixedDate.getHours()).padStart(2, '0');
const expectedMM = String(fixedDate.getMinutes()).padStart(2, '0');
const expectedTime = expectedHH + ':' + expectedMM;

const sent = [];
const ctx = makeCtx();

// Patch Date.now BEFORE apply() so the deps closure picks it up.
const realNow = Date.now;
Date.now = () => fixedDate.getTime();
try {
  apply(ctx, {}, {
    config: testConfig,
    deps: { run: () => Promise.resolve({ stdout: '', stderr: '' }), httpPost: () => Promise.resolve({ status: 200, text: '' }), logger: ctx.logger, now: () => fixedDate.getTime() },
    channels: [{
      name: 'test-recorder',
      send: async (payload) => { sent.push(payload); },
    }],
    // No format override: apply() will async-load the real format.mjs and
    // exercise the v0.3 composeBody end-to-end.
  });
  // Wait for the async format.mjs import to settle so composeBody (not the
  // degraded fallback) is what runs.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(ctx.listeners.has('agent/status'), 'apply() must register agent/status');
  assert.equal(ctx.effects.length, 1, 'one disposal effect for coalescer');

  ctx.emit('agent/status', { agent: { id: 'sess-1' }, status: 'idle' });
  await new Promise((r) => setTimeout(r, 150)); // > coalesceWindowMs
} finally {
  Date.now = realNow;
}

assert.equal(sent.length, 1, 'one channel send expected');
const p = sent[0];
assert.equal(p.event, 'idle');
assert.equal(p.title, '任务完成', 'v0.2 locked title');
assert.ok(p.body.startsWith('会话 sess-1 · '), 'body must join summary + separator: ' + JSON.stringify(p.body));
assert.ok(p.body.endsWith(expectedTime), 'body must end with formatted local HH:mm (' + expectedTime + '): ' + JSON.stringify(p.body));
assert.equal(p.ts, fixedDate.getTime());
assert.equal(p.sessionId, 'sess-1');
assert.equal(p.iconUrl, '');

ctx.runDisposers();
console.log('[smoke] PASS  body=' + JSON.stringify(p.body));
