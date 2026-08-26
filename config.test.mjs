/**
 * config.test.mjs — resolveConfig 三层优先级与类型容错（SPEC 5.3 / 6.3）。
 * settings 层用临时目录写真实 yaml 文件验证；不触碰用户 ~/.dsh/settings.yaml。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, resolveConfigDetailed, loadSettings, defaultConfig } from './config.mjs';

/** 建一个一次性临时目录，测试结束自动清理。 */
function withTempSettings(t, content, filename = 'settings.yaml') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-notify-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, filename);
  if (content !== null) writeFileSync(path, content, 'utf8');
  return path;
}

const EMPTY_ENV = Object.freeze({});

test('默认值：无 input、空 env、settings 不存在 → 返回内置默认且深度冻结', () => {
  const config = resolveConfig(undefined, EMPTY_ENV, '/nonexistent/dsh/settings.yaml');

  assert.equal(config.enabled, true);
  assert.deepEqual(config.notifyOn, ['idle', 'error', 'blocked']);
  assert.equal(config.agents, 'root');
  assert.equal(config.coalesceWindowMs, 2000);
  assert.equal(config.maxBodyLength, 120);
  assert.equal(config.desktop.enabled, 'auto');
  assert.equal(config.desktop.sound, true);
  assert.equal(config.bark.enabled, false);
  assert.equal(config.bark.server, 'https://api.day.app');
  assert.equal(config.ntfy.server, 'https://ntfy.sh');
  assert.equal(config.serverchan.sendKey, '');
  assert.equal(config.webhook.url, '');
  assert.deepEqual(config.webhook.headers, {});
  // SPEC §7.3：icons 段默认值
  assert.equal(config.icons.enabled, true);
  assert.equal(config.icons.urlTemplate, '');

  // 冻结断言（含嵌套层）
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.desktop), true);
  assert.equal(Object.isFrozen(config.bark), true);
  assert.equal(Object.isFrozen(config.icons), true);
  assert.throws(() => { 'use strict'; config.enabled = false; }, TypeError);
  assert.throws(() => { 'use strict'; config.icons.enabled = false; }, TypeError);
});

test('settings 覆盖默认值：yaml 的 task-notify 键生效', (t) => {
  const path = withTempSettings(t, `
task-notify:
  enabled: false
  notifyOn: [idle, blocked]
  coalesceWindowMs: 5000
  bark:
    enabled: true
    deviceKey: dev-key-123
  icons:
    urlTemplate: https://host/icons/{event}.svg
`);
  const config = resolveConfig({}, EMPTY_ENV, path);
  assert.equal(config.enabled, false);
  assert.deepEqual(config.notifyOn, ['idle', 'blocked']); // 数组整体替换
  assert.equal(config.coalesceWindowMs, 5000);
  assert.equal(config.bark.enabled, true); // 段内深合并：未写 server 仍为默认
  assert.equal(config.bark.deviceKey, 'dev-key-123');
  assert.equal(config.bark.server, 'https://api.day.app');
  // icons 段内深合并：只写 urlTemplate，enabled 保持默认 true（SPEC §7.3）
  assert.equal(config.icons.urlTemplate, 'https://host/icons/{event}.svg');
  assert.equal(config.icons.enabled, true);
});

test('env 覆盖默认值：DSH_TASK_NOTIFY_* 各键生效', () => {
  const config = resolveConfig({}, {
    DSH_TASK_NOTIFY_ENABLED: 'false',
    DSH_TASK_NOTIFY_NOTIFY_ON: 'idle,error',
    DSH_TASK_NOTIFY_AGENTS: 'all',
    DSH_TASK_NOTIFY_COALESCE_WINDOW_MS: '7000',
    DSH_TASK_NOTIFY_MAX_BODY_LENGTH: '64',
    DSH_TASK_NOTIFY_BARK_DEVICE_KEY: 'env-key',
    DSH_TASK_NOTIFY_WEBHOOK_HEADERS: '{"X-Token":"abc"}',
    DSH_TASK_NOTIFY_ICONS_ENABLED: 'false',
    DSH_TASK_NOTIFY_ICONS_URL_TEMPLATE: 'https://env.example.com/{event}.png',
  }, null);

  assert.equal(config.enabled, false);
  assert.deepEqual(config.notifyOn, ['idle', 'error']);
  assert.equal(config.agents, 'all');
  assert.equal(config.coalesceWindowMs, 7000);
  assert.equal(config.maxBodyLength, 64);
  assert.equal(config.bark.deviceKey, 'env-key');
  assert.deepEqual(config.webhook.headers, { 'X-Token': 'abc' });
  // SPEC §7.3：icons env 键
  assert.equal(config.icons.enabled, false);
  assert.equal(config.icons.urlTemplate, 'https://env.example.com/{event}.png');
});

test('icons 段三层优先级：patch input > settings > env > 默认', (t) => {
  const path = withTempSettings(t, `
task-notify:
  icons:
    enabled: false
    urlTemplate: https://settings.example.com/{event}.svg
`);

  // 三层同设 → input 赢
  const all = resolveConfigDetailed({
    icons: { enabled: true, urlTemplate: 'https://input.example.com/{event}.svg' },
  }, {
    DSH_TASK_NOTIFY_ICONS_ENABLED: 'true',
    DSH_TASK_NOTIFY_ICONS_URL_TEMPLATE: 'https://env.example.com/{event}.svg',
  }, path);
  assert.equal(all.config.icons.urlTemplate, 'https://input.example.com/{event}.svg');
  assert.equal(all.config.icons.enabled, true);

  // 去 input → settings 压过 env
  const noInput = resolveConfigDetailed({}, { DSH_TASK_NOTIFY_ICONS_URL_TEMPLATE: 'https://env.example.com/{event}.svg' }, path);
  assert.equal(noInput.config.icons.urlTemplate, 'https://settings.example.com/{event}.svg');
  assert.equal(noInput.config.icons.enabled, false);

  // 无 settings、无 input → env 生效；enabled 未设 → 默认 true
  const envOnly = resolveConfigDetailed({}, { DSH_TASK_NOTIFY_ICONS_URL_TEMPLATE: 'https://env.example.com/{event}.svg' }, null);
  assert.equal(envOnly.config.icons.urlTemplate, 'https://env.example.com/{event}.svg');
  assert.equal(envOnly.config.icons.enabled, true);

  // 全去 → 默认
  const none = resolveConfig({}, {}, null);
  assert.deepEqual({ ...none.icons }, defaultConfig().icons);
});

test('优先级顺序：patch input > settings > env > 默认（SPEC 5.3）', (t) => {
  const path = withTempSettings(t, `
task-notify:
  coalesceWindowMs: 111
  agents: all
`);

  // 三层同设 → input 赢
  const all = resolveConfigDetailed({ coalesceWindowMs: 333 }, {
    DSH_TASK_NOTIFY_COALESCE_WINDOW_MS: '222',
  }, path);
  assert.equal(all.config.coalesceWindowMs, 333);

  // 去 input → settings(111) 压过 env(222)
  const noInput = resolveConfigDetailed({}, { DSH_TASK_NOTIFY_COALESCE_WINDOW_MS: '222' }, path);
  assert.equal(noInput.config.coalesceWindowMs, 111);

  // 去 input、无 settings → env(222) 压过默认
  const envOnly = resolveConfigDetailed({}, { DSH_TASK_NOTIFY_COALESCE_WINDOW_MS: '222' }, null);
  assert.equal(envOnly.config.coalesceWindowMs, 222);

  // 有 settings、无 env：settings 独有的键生效
  const onlySettings = resolveConfigDetailed({}, {}, path);
  assert.equal(onlySettings.config.coalesceWindowMs, 111);
  assert.equal(onlySettings.config.agents, 'all');

  // 全去 → 默认
  const none = resolveConfig({}, {}, null);
  assert.equal(none.coalesceWindowMs, defaultConfig().coalesceWindowMs);
});

test('坏 YAML 容错：解析失败降级为该层缺失 + warn，绝不抛出', (t) => {
  const path = withTempSettings(t, 'task-notify: [unclosed: bracket\n  - oops: {{{');
  const { config, warnings } = resolveConfigDetailed({}, EMPTY_ENV, path);

  assert.equal(config.coalesceWindowMs, defaultConfig().coalesceWindowMs); // 回落默认
  assert.equal(config.bark.enabled, false);
  assert.ok(warnings.some((w) => w.includes('settings.yaml 解析失败')), `应包含解析失败警告，实际：${JSON.stringify(warnings)}`);
});

test('settings 里 task-notify 键缺失/非映射 → 静默/告警跳过', (t) => {
  const missingKey = withTempSettings(t, 'other-plugin:\n  foo: 1\n');
  const okMissing = resolveConfigDetailed({}, EMPTY_ENV, missingKey);
  assert.equal(okMissing.config.maxBodyLength, 120);
  assert.ok(!okMissing.warnings.some((w) => w.includes('task-notify')));

  const wrongShape = withTempSettings(t, 'task-notify: "just a string"\n');
  const warned = resolveConfigDetailed({}, EMPTY_ENV, wrongShape);
  assert.equal(warned.config.maxBodyLength, 120);
  assert.ok(warned.warnings.some((w) => w.includes('task-notify 键必须是映射')));
});

test('类型容错：enabled 字符串、非法 notifyOn、负数窗口、未知 agents/desktop 模式', (t) => {
  const { config, warnings } = resolveConfigDetailed({
    enabled: 'false',                 // 字符串布尔
    notifyOn: ['IDLE', 'nope'],       // 大小写归一 + 非法项整体拒绝回退默认
    coalesceWindowMs: '-5',           // 负数 → 回退
    maxBodyLength: 'abc',             // 非数字 → 回退
    agents: 'sometimes',              // 非法枚举 → 回退 root
    desktop: { enabled: 'ON' },       // 合法枚举大小写宽容
    bark: { enabled: 'true', sound: null },
  }, EMPTY_ENV, null);

  assert.equal(config.enabled, false);
  assert.deepEqual(config.notifyOn, ['idle', 'error', 'blocked']); // 含非法项 → 整体回退默认并 warn
  assert.equal(config.coalesceWindowMs, 2000);
  assert.equal(config.maxBodyLength, 120);
  assert.equal(config.agents, 'root');
  assert.equal(config.desktop.enabled, 'on');
  assert.equal(config.bark.enabled, true);
  assert.ok(warnings.some((w) => w.includes('coalesceWindowMs')));
  assert.ok(warnings.some((w) => w.includes('agents')));
});

test('未知键忽略并 warn（顶层与通道段内都检查）', () => {
  const { config, warnings } = resolveConfigDetailed({
    hackerMode: true,
    bark: { deviceKey: 'k', typoKey: 1 },
    icons: { typoKey: 1 },
  }, EMPTY_ENV, null);

  assert.equal(config.hackerMode, undefined);
  assert.equal(config.bark.deviceKey, 'k');
  assert.equal(config.bark.typoKey, undefined);
  assert.equal(config.icons.typoKey, undefined);
  assert.ok(warnings.some((w) => w.includes('"hackerMode"')));
  assert.ok(warnings.some((w) => w.includes('"typoKey"')));
});

test('icons 段类型容错：enabled 字符串宽容、非对象段回退默认并 warn', () => {
  // enabled: "yes" → true；urlTemplate 数字 → 转字符串
  const tolerant = resolveConfigDetailed({ icons: { enabled: 'yes', urlTemplate: 42 } }, EMPTY_ENV, null);
  assert.equal(tolerant.config.icons.enabled, true);
  assert.equal(tolerant.config.icons.urlTemplate, '42');
  assert.equal(tolerant.warnings.length, 0);

  // 整段非对象 → 回退默认 + warn；段内非法值 → 回退默认 + warn
  const bad = resolveConfigDetailed({
    icons: 'not-an-object',
  }, { DSH_TASK_NOTIFY_ICONS_ENABLED: 'sometimes' }, null);
  assert.deepEqual({ ...bad.config.icons }, defaultConfig().icons);
  assert.ok(bad.warnings.some((w) => w.includes('icons 段不是对象')));
  assert.ok(bad.warnings.some((w) => w.includes('DSH_TASK_NOTIFY_ICONS_ENABLED')));

  const badField = resolveConfigDetailed({ icons: { enabled: 'sometimes' } }, EMPTY_ENV, null);
  assert.equal(badField.config.icons.enabled, true); // 回退默认
  assert.ok(badField.warnings.some((w) => w.includes('icons.enabled')));
});

test('notifyOn 接受逗号分隔字符串（env 场景）并去重', () => {
  const config = resolveConfig({ notifyOn: 'idle, idle ,goal-completed' }, EMPTY_ENV, null);
  assert.deepEqual([...config.notifyOn], ['idle', 'goal-completed']);
});

test('loadSettings：ENOENT 静默返回 null，目录缺失也不抛', () => {
  const warns = [];
  assert.equal(loadSettings('/nonexistent/dir/settings.yaml', (m) => warns.push(m)), null);
  assert.equal(warns.length, 0); // ENOENT 属正常情况

  assert.equal(loadSettings('/nonexistent/deeper/path/y.yaml', (m) => warns.push(m)), null);
});

test('webhook.headers 非 JSON 字符串被拒绝并 warn', () => {
  const { config, warnings } = resolveConfigDetailed({}, {
    DSH_TASK_NOTIFY_WEBHOOK_HEADERS: 'not-json{',
  }, null);
  assert.deepEqual(config.webhook.headers, {});
  assert.ok(warnings.some((w) => w.includes('DSH_TASK_NOTIFY_WEBHOOK_HEADERS')));
});

/* ---- v0.3：format 段 ---- */

test('format 段默认值：time=short、showDuration=true', () => {
  const config = resolveConfig({}, {}, null);
  assert.deepEqual({ ...config.format }, { time: 'short', showDuration: true });
});

test('format 段三层合并：env 与 patch input 均生效', () => {
  const viaEnv = resolveConfig({}, { DSH_TASK_NOTIFY_FORMAT_TIME: 'full', DSH_TASK_NOTIFY_FORMAT_SHOW_DURATION: 'false' }, null);
  assert.equal(viaEnv.format.time, 'full');
  assert.equal(viaEnv.format.showDuration, false);

  const viaPatch = resolveConfig({ format: { time: 'hidden' } }, {}, null);
  assert.equal(viaPatch.format.time, 'hidden');
  assert.equal(viaPatch.format.showDuration, true); // 未覆盖键保持默认
});

test('format.time 非法值回退默认并 warn', () => {
  const { config, warnings } = resolveConfigDetailed({ format: { time: 'sometimes' } }, {}, null);
  assert.equal(config.format.time, 'short');
  assert.ok(warnings.some((w) => w.includes('format.time')));
});

test('format 段不是对象时整体回退默认', () => {
  const { config, warnings } = resolveConfigDetailed({ format: 'short' }, {}, null);
  assert.deepEqual({ ...config.format }, { time: 'short', showDuration: true });
  assert.ok(warnings.some((w) => w.includes('format 段')));
});
