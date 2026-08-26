/**
 * paths.test.mjs — 图标路径解析（SPEC §7.2/§7.4）。
 *
 * 资产目录 assets/icons 由并行工作流（Worker-A2）产出，本测试绝不向其写入；
 * 「资产存在」场景用 os 临时目录 + 手写假资产模拟，「缺失」场景用空临时目录
 * 模拟。真实包目录只做一致性冒烟断言（结果与 fs 状态互斥且自洽）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ICONS_DIR,
  PACKAGE_DIR,
  iconBaseName,
  resolveIconPath,
  resolveIconSvgPath,
} from './paths.mjs';

/** 建一个一次性临时图标根目录，可选预置 <name>.png/.svg 假资产。 */
function withTempIcons(t, files = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-notify-icons-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of files) writeFileSync(join(dir, name), `<svg>${name}</svg>`, 'utf8');
  return dir;
}

/* ------------------------------------------------------------------ */
/* iconBaseName                                                        */
/* ------------------------------------------------------------------ */

test('iconBaseName：已知事件映射到自身', () => {
  assert.equal(iconBaseName('idle'), 'idle');
  assert.equal(iconBaseName('error'), 'error');
  assert.equal(iconBaseName('blocked'), 'blocked');
  assert.equal(iconBaseName('goal-completed'), 'goal-completed');
});

test('iconBaseName：未知/缺失事件回退 notify（SPEC §7.2）', () => {
  for (const weird of ['running', '', 'IDLE', null, undefined]) {
    assert.equal(iconBaseName(weird), 'notify');
  }
});

/* ------------------------------------------------------------------ */
/* 临时根目录下的解析行为（生产路径的完整模拟，含回退链）                  */
/* ------------------------------------------------------------------ */

test('resolveIconPath/SvgPath：<event> 资产存在 → 返回绝对路径', (t) => {
  const dir = withTempIcons(t, ['idle.png', 'idle.svg']);
  assert.equal(resolveIconPath('idle', dir), join(dir, 'idle.png'));
  assert.equal(resolveIconSvgPath('idle', dir), join(dir, 'idle.svg'));
});

test('<event>.png 缺失但 notify.png 存在 → 回退 notify（SPEC §7.4 缺失→notify.png）', (t) => {
  const dir = withTempIcons(t, ['notify.png', 'notify.svg']);
  assert.equal(resolveIconPath('blocked', dir), join(dir, 'notify.png'));
  assert.equal(resolveIconSvgPath('goal-completed', dir), join(dir, 'notify.svg'));
});

test('事件专属资产存在时不走回退', (t) => {
  const dir = withTempIcons(t, ['error.png', 'error.svg', 'notify.png', 'notify.svg']);
  assert.equal(resolveIconPath('error', dir), join(dir, 'error.png'));
});

test('全部缺失 → 返回 null 且不抛错（不存在的临时目录模拟）', (t) => {
  const dir = join(tmpdir(), `dsh-nonexistent-${Date.now()}-x`);
  assert.equal(resolveIconPath('idle', dir), null);
  assert.equal(resolveIconSvgPath('idle', dir), null);
  // notify 自身缺失时不再二次回退
  assert.equal(resolveIconPath('unknown-event', dir), null);
});

/* ------------------------------------------------------------------ */
/* 真实包目录冒烟：路径推导不依赖 cwd，且与磁盘状态自洽                    */
/* ------------------------------------------------------------------ */

test('PACKAGE_DIR/ICONS_DIR 基于 import.meta.url 推导，解析结果不依赖 cwd', () => {
  assert.ok(PACKAGE_DIR.endsWith('/'), '包目录应以 / 结尾');
  assert.ok(existsSync(PACKAGE_DIR));
  assert.equal(ICONS_DIR, join(PACKAGE_DIR, 'assets', 'icons'));

  // 换个工作目录再解析，结果必须逐字一致（打包安装到任意路径同理）。
  const originalCwd = process.cwd();
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-task-notify-cwd-'));
  try {
    process.chdir(scratch);
    const fromScratch = { png: resolveIconPath('idle'), svg: resolveIconSvgPath('idle') };
    process.chdir(originalCwd);
    assert.equal(resolveIconPath('idle'), fromScratch.png);
    assert.equal(resolveIconSvgPath('idle'), fromScratch.svg);
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('真实包目录：返回值与磁盘状态互斥自洽（A2 资产落地前后均成立）', () => {
  for (const [resolver, ext] of [[resolveIconPath, '.png'], [resolveIconSvgPath, '.svg']]) {
    const resolved = resolver('idle');
    if (resolved === null) {
      // 资产尚未产出：idle 与回退 notify 的对应扩展名资产都不存在
      assert.equal(existsSync(join(ICONS_DIR, `idle${ext}`)), false);
      assert.equal(existsSync(join(ICONS_DIR, `notify${ext}`)), false);
    } else {
      assert.ok(resolved.startsWith(ICONS_DIR), `${resolved} 应位于 ${ICONS_DIR} 下`);
      assert.ok(resolved.endsWith(ext));
      assert.equal(existsSync(resolved), true, '解析出的路径必须真实存在');
    }
  }
});
