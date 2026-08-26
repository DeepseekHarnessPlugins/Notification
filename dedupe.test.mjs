/**
 * dedupe.test.mjs — createCoalescer 语义验证。
 * 全部用 node:test 的 mock timers，不依赖真实时钟（SPEC 6.2）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescer } from './dedupe.mjs';

/** 开启 mock timers 的辅助：替换 setTimeout（clearTimeout 随之自动被 mock），Date.now 不受影响。 */
function enableMockTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

test('窗口内同一 sessionId 多次 push 只触发最后一次 fire 一次', (t) => {
  enableMockTimers(t);
  const coalescer = createCoalescer(1000);
  const seen = [];
  assert.equal(coalescer.push('sess-a', () => seen.push('first')), true);
  assert.equal(coalescer.push('sess-a', () => seen.push('second')), true);
  assert.equal(coalescer.size, 1);

  // 窗口未到期：不触发
  t.mock.timers.tick(999);
  assert.deepEqual(seen, []);

  // 到期：只执行最后一次 fire
  t.mock.timers.tick(1);
  assert.deepEqual(seen, ['second']);
  assert.equal(coalescer.size, 0);
});

test('push 重置窗口：后一次入队使前一次的定时器作废', (t) => {
  enableMockTimers(t);
  const coalescer = createCoalescer(1000);
  const seen = [];
  coalescer.push('s', () => seen.push('A'));
  t.mock.timers.tick(600); // 走过 60% 窗口
  coalescer.push('s', () => seen.push('B')); // 重置整个窗口
  t.mock.timers.tick(600); // 距 B 只有 600ms：A 的旧定时器已作废
  assert.deepEqual(seen, []); // 若未重置，这里 A 应已触发
  t.mock.timers.tick(400);
  assert.deepEqual(seen, ['B']);
});

test('不同 sessionId 互不影响，各自到期各自触发', (t) => {
  enableMockTimers(t);
  const coalescer = createCoalescer(500);
  const seen = [];
  coalescer.push('a', () => seen.push('a-fire'));
  t.mock.timers.tick(250);
  coalescer.push('b', () => seen.push('b-fire'));
  assert.equal(coalescer.size, 2);
  t.mock.timers.tick(250); // a 到期（累计 500ms），b 还差 250ms
  assert.deepEqual(seen, ['a-fire']);
  t.mock.timers.tick(250); // b 到期
  assert.deepEqual(seen, ['a-fire', 'b-fire']);
});

test('dispose 清空 pending 且此后 push 被忽略，dispose 幂等', (t) => {
  enableMockTimers(t);
  const coalescer = createCoalescer(300);
  let fired = 0;
  coalescer.push('x', () => fired++);
  coalescer.dispose();
  assert.equal(coalescer.disposed, true);
  assert.equal(coalescer.size, 0);
  t.mock.timers.tick(10_000);
  assert.equal(fired, 0);
  assert.equal(coalescer.push('y', () => fired++), false); // disposed 后拒绝入队
  t.mock.timers.tick(10_000);
  assert.equal(fired, 0);
  coalescer.dispose(); // 二次 dispose 不抛
});

test('fire 抛错经 onError 兜底，不再产生未捕获异常', (t) => {
  enableMockTimers(t);
  const errors = [];
  const coalescer = createCoalescer(50, Date.now, (error) => errors.push(error));
  coalescer.push('boom', () => {
    throw new Error('通道炸了');
  });
  assert.doesNotThrow(() => t.mock.timers.tick(50));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.message), /通道炸了/);
});

test('now 注入生效：每次 push 都会调用注入时钟', (t) => {
  enableMockTimers(t);
  let calls = 0;
  const coalescer = createCoalescer(200, () => {
    calls++;
    return calls;
  });
  coalescer.push('t', () => {});
  coalescer.push('u', () => {});
  assert.ok(calls >= 2, `now 应被至少调用两次，实际 ${calls}`);
  assert.equal(coalescer.size, 2);
  t.mock.timers.tick(200);
});

test('windowMs=0 时 tick(0) 即触发；非法 windowMs 回落为 0', (t) => {
  enableMockTimers(t);
  let fired = 0;
  const zero = createCoalescer(0);
  zero.push('z', () => fired++);
  t.mock.timers.tick(0);
  assert.equal(fired, 1);

  const bad = createCoalescer(Number.NaN);
  bad.push('n', () => fired++);
  t.mock.timers.tick(0);
  assert.equal(fired, 2);
});
