import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cycleField,
  describeNotifyOn,
  getField,
  setField,
  toggleEvent,
} from './menu-core.mjs';

describe('toggleEvent', () => {
  test('从未配置开始：第一次切换只开启该事件', () => {
    const next = toggleEvent({}, 'idle');
    assert.deepEqual(next.notifyOn, ['idle']);
  });
  test('已有列表中移除/再加入，且输出遵循规范顺序', () => {
    let s = toggleEvent({ notifyOn: ['idle', 'error'] }, 'error');
    assert.deepEqual(s.notifyOn, ['idle']);
    s = toggleEvent(s, 'goal-completed');
    assert.deepEqual(s.notifyOn, ['idle', 'goal-completed']);
  });
  test('不改原对象', () => {
    const orig = { notifyOn: ['idle'] };
    toggleEvent(orig, 'error');
    assert.deepEqual(orig.notifyOn, ['idle']);
  });
});

describe('setField / getField / cycleField', () => {
  test('深路径写入并保留兄弟键', () => {
    const s = setField({ bark: { enabled: false, server: 'https://api.day.app' } }, ['bark', 'deviceKey'], 'k1');
    assert.equal(s.bark.deviceKey, 'k1');
    assert.equal(s.bark.server, 'https://api.day.app');
  });
  test('中间节点不是对象时安全重建', () => {
    const s = setField({ ntfy: 'oops' }, ['ntfy', 'topic'], 't');
    assert.equal(s.ntfy.topic, 't');
  });
  test('getField 缺省回退', () => {
    assert.equal(getField({}, ['bark', 'deviceKey'], '(默认空)'), '(默认空)');
    assert.equal(getField({ enabled: true }, ['enabled'], false), true);
  });
  test('cycleField 循环推进，未知值从头开始', () => {
    let s = { format: { time: 'hidden' } };
    s = cycleField(s, ['format', 'time'], ['hidden', 'short', 'full']);
    assert.equal(s.format.time, 'short');
    s = cycleField(s, ['format', 'time'], ['hidden', 'short', 'full']);
    assert.equal(s.format.time, 'full');
    s = cycleField(s, ['format', 'time'], ['hidden', 'short', 'full']);
    assert.equal(s.format.time, 'hidden');
    assert.equal(cycleField({}, ['format', 'time'], ['hidden', 'short', 'full']).format.time, 'hidden');
  });
});

describe('describeNotifyOn', () => {
  test('按规范顺序渲染勾选状态', () => {
    assert.equal(describeNotifyOn({ notifyOn: ['error'] }), 'idle✗ error✓ blocked✗ goal-completed✗');
    assert.equal(describeNotifyOn({}), 'idle✗ error✗ blocked✗ goal-completed✗');
  });
});
