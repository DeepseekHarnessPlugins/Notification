#!/usr/bin/env node
/**
 * menu.mjs - 任务通知交互式设置菜单（npm run menu）。
 *
 * 直接编辑 ~/.dsh/settings.yaml 的 task-notify 段：展示时把未设置的键渲染为
 * 默认值，保存时只写回改过的原始段。注意：YAML 注释会在保存时丢失（保存前
 * 会自动备份 settings.yaml.bak-<时间戳>）。测试通知只走选中的通道。
 *
 * 纯逻辑在 menu-core.mjs（可单测）；本文件只做 I/O 与菜单循环。
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import yaml from 'js-yaml';
import { DEFAULT_SETTINGS_PATH, defaultConfig, loadSettings } from './config.mjs';
import {
  CHANNEL_SECTIONS,
  DESKTOP_MODES,
  TIME_STYLE_VALUES,
  cycleField,
  describeBool,
  describeNotifyOn,
  getField,
  setField,
  toggleEvent,
} from './menu-core.mjs';

const SECTION_KEY = 'task-notify';
const HTTP_TIMEOUT_MS = 8000;
const RUN_TIMEOUT_MS = 10000;

/* ---------- 展示 ---------- */

const defaults = () => structuredClone(defaultConfig());

function show(section) {
  const d = defaults();
  const eff = (path, fb) => getField(section, path, getField(d, path, fb));
  console.log('');
  console.log('======== 任务通知设置 ========');
  console.log(' 1) 总开关        :', describeBool(getField(section, ['enabled'], undefined), '开'));
  console.log(' 2) 通知事件      :', describeNotifyOn(section));
  console.log(' 3) 通知对象      :', eff(['agents'], 'root'), '(root=仅顶层 / all=全部)');
  console.log(' 4) 桌面通知      :', eff(['desktop', 'enabled'], 'auto'), '| 声音:', describeBool(eff(['desktop', 'sound'], true), '开'));
  console.log(' 5) 时间样式      :', eff(['format', 'time'], 'short'), '(hidden | short | full)');
  console.log(' 6) 用时后缀      :', describeBool(eff(['format', 'showDuration'], true), '开'));
  console.log(' 7) 正文长度上限  :', eff(['maxBodyLength'], 120));
  console.log(' 8) 合并窗口(ms)  :', eff(['coalesceWindowMs'], 2000));
  for (const ch of CHANNEL_SECTIONS) {
    const on = eff([ch.key, 'enabled'], false);
    const extra = ch.fields.filter((f) => f !== 'enabled')
      .map((f) => f + '=' + JSON.stringify(eff([ch.key, f], '')))
      .join(' ');
    console.log('    ' + ch.key.padEnd(10) + ':', on ? '启用' : '关闭', extra);
  }
  console.log(' c) 通道配置/测试   s) 保存退出   q) 不保存退出');
  console.log('------------------------------');
}

/* ---------- 交互动作 ---------- */

/** 循环切换，但从「显示的生效值」（未配置时取默认值）起跳，避免首跳跳变。 */
function cycleFromEffective(section, path, values) {
  const current = getField(section, path, getField(defaults(), path, values[0]));
  const idx = values.indexOf(current);
  return setField(section, path, values[(idx + 1) % values.length]);
}

async function ask(rl, prompt) {
  return (await rl.question(prompt)).trim();
}

async function configureChannel(rl, section, key) {
  const meta = CHANNEL_SECTIONS.find((c) => c.key === key);
  section = cycleField(section, [key, 'enabled'], [false, true]);
  const enabled = getField(section, [key, 'enabled'], false);
  console.log(meta.label + (enabled ? ' 已启用' : ' 已关闭'));
  if (!enabled) return section;

  for (const field of meta.fields) {
    if (field === 'enabled') continue;
    const cur = JSON.stringify(getField(section, [key, field], ''));
    const v = await ask(rl, '  ' + field + ' [当前 ' + cur + '] 回车保持，输入新值: ');
    if (v !== '') section = setField(section, [key, field], v);
  }
  return section;
}

/** 组装真实 Deps 并向指定通道发送一条样例通知。 */
async function sendTest(channelKey) {
  const doc = loadSettings(DEFAULT_SETTINGS_PATH, (m) => console.warn(m)) ?? {};
  const raw = doc[SECTION_KEY];
  const cfg = structuredClone(defaultConfig());
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) cfg[k] = v;
  }
  const { createChannels } = await import('./channels/index.mjs');
  const logger = { info: (m) => console.log('  [i]', m), warn: (m) => console.log('  [w]', m) };
  const run = (file, args2, opts = {}) => new Promise((resolve, reject) => {
    execFile(file, args2, { timeout: RUN_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
  });
  const httpPost = async (url, init = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', ...init, signal: ac.signal });
      return { status: res.status, text: await res.text() };
    } finally { clearTimeout(timer); }
  };
  const channels = await createChannels(cfg, { run, httpPost, logger, now: () => Date.now() });
  const targets = channels.filter((c) => c && (!channelKey || c.name === channelKey));
  if (!targets.length) { console.log('  没有匹配的启用通道，请先开启。'); return; }
  const payload = {
    event: 'idle',
    title: '任务完成',
    body: 'menu 测试通知 · ' + new Date().toLocaleTimeString(),
    ts: Date.now(),
    iconUrl: '',
  };
  for (const c of targets) {
    try { await c.send(payload); console.log('  [ok] 通道 "' + c.name + '" 发送成功'); }
    catch (e) { console.log('  [x] 通道 "' + c.name + '" 发送失败:', e.message); }
  }
}

/* ---------- 保存 ---------- */

function save(section) {
  let doc = {};
  try {
    const parsed = yaml.load(readFileSync(DEFAULT_SETTINGS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
  } catch { /* 文件不存在或为空，从空文档开始 */ }

  if (Object.keys(doc).length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(DEFAULT_SETTINGS_PATH, DEFAULT_SETTINGS_PATH + '.bak-' + stamp);
  }
  doc[SECTION_KEY] = section;
  writeFileSync(DEFAULT_SETTINGS_PATH, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
  console.log('已写入 ' + DEFAULT_SETTINGS_PATH);
  console.log('(提示：原文件注释不会被保留；如需回滚可用同目录 .bak-* 备份)');
}

/* ---------- 输入源 ----------
 * Node v26 实测：管道输入下 readline/promises 的第二次 question() 永远不决
 * （ unsettled top-level await，exit 13）。非 TTY 一律预读全部 stdin 行，
 * 按队列逐条应答；耗尽后返回空串并置 eof，主循环据此未保存退出。
 * TTY 交互保持原生 readline 行为不变。
 */
async function makeIO() {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return { question: (p) => rl.question(p), close: () => rl.close(), eof: false };
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString('utf8').split('\n').map((s) => s.replace(/\r$/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let cursor = 0;
  return {
    eof: false,
    async question(prompt) {
      process.stdout.write(prompt);
      if (cursor >= lines.length) { this.eof = true; return ''; }
      const value = lines[cursor++];
      console.log(value);
      return value;
    },
    close() {},
  };
}

/* ---------- 主循环 ---------- */

async function main() {
  const doc = loadSettings(DEFAULT_SETTINGS_PATH, (m) => console.warn(m)) ?? {};
  const rawSection = doc[SECTION_KEY];
  let section = rawSection && typeof rawSection === 'object' ? { ...rawSection } : {};

  const rl = await makeIO();
  console.log('dsh-task-notify 设置菜单（编辑 ' + DEFAULT_SETTINGS_PATH + '）');

  let touched = false;
  try {
    while (true) {
      show(section);
      const line = await ask(rl, '选择> ');
      if (rl.eof && line === '') { console.log('(stdin 结束，未保存退出)'); break; }
      const choice = line.toLowerCase();
      if (choice === 'q') {
        if (touched) console.log('放弃修改退出（文件未改动）。');
        break;
      }
      if (choice === 's') {
        save(section);
        break;
      }
      if (choice === 'c') {
        const key = await ask(rl, '通道 key (' + CHANNEL_SECTIONS.map((c) => c.key).join('/') + '): ');
        if (CHANNEL_SECTIONS.some((c) => c.key === key)) {
          section = await configureChannel(rl, section, key);
          const go = await ask(rl, '发送测试通知？(y/N): ');
          if (go.toLowerCase() === 'y') await sendTest(key);
        } else {
          console.log('未知通道:', key);
        }
      } else if (choice === '1') {
        section = cycleFromEffective(section, ['enabled'], [true, false]);
      } else if (choice === '2') {
        const ev = await ask(rl, '切换事件 (idle/error/blocked/goal-completed): ');
        if (['idle', 'error', 'blocked', 'goal-completed'].includes(ev)) section = toggleEvent(section, ev);
        else console.log('未知事件:', ev);
      } else if (choice === '3') {
        section = cycleFromEffective(section, ['agents'], ['root', 'all']);
      } else if (choice === '4') {
        section = cycleFromEffective(section, ['desktop', 'enabled'], DESKTOP_MODES);
      } else if (choice === '5') {
        section = cycleFromEffective(section, ['format', 'time'], TIME_STYLE_VALUES);
      } else if (choice === '6') {
        section = cycleFromEffective(section, ['format', 'showDuration'], [true, false]);
      } else if (choice === '7') {
        const v = Number(await ask(rl, '正文长度上限 [120]: '));
        if (Number.isInteger(v) && v > 0) section = setField(section, ['maxBodyLength'], v);
        else console.log('需要正整数');
      } else if (choice === '8') {
        const v = Number(await ask(rl, '合并窗口毫秒 [2000]: '));
        if (Number.isInteger(v) && v >= 0) section = setField(section, ['coalesceWindowMs'], v);
        else console.log('需要非负整数');
      } else if (line !== '') {
        console.log('无效选择:', line);
      }
      touched = true;
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => { console.error('[task-notify] 菜单异常退出:', e.message); process.exitCode = 1; });
