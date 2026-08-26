/**
 * self-test.mjs — 逐通道真实发送样例通知（SPEC 5.8）。
 *
 * 用法：
 *   node self-test.mjs                          # 全部「已启用」通道各发一条
 *   node self-test.mjs --channel bark           # 只发指定通道
 *   node self-test.mjs --channel desktop        # desktop = macos|windows 按平台匹配
 *
 * 行为：加载真实配置（settings.yaml + env）→ 构造样例 payload（含 iconUrl，
 * SPEC §7.4）→ 走 channels/index.mjs 的真实通道实现（真 run/httpPost）→
 * 逐通道打印 ✓/✗ 与错误信息。退出码：全部成功（或无启用通道时提示）0/1。
 *
 * 注意：本脚本会真的发通知。bark/ntfy 等推送会到达手机，请知悉。
 */

import { execFile } from 'node:child_process';
import { resolveConfig } from './config.mjs';
import { renderIconUrl } from './index.mjs';

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  let channel;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--channel' || arg === '-c') channel = argv[++i];
    else if (arg.startsWith('--channel=')) channel = arg.slice('--channel='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return { channel: typeof channel === 'string' && channel.trim() !== '' ? channel.trim().toLowerCase() : undefined };
}

function printHelp() {
  console.log(`
dsh-task-notify self-test

用法：
  node self-test.mjs [--channel desktop|macos|windows|bark|ntfy|serverchan|webhook]

不带 --channel 时向所有已启用通道各发一条样例通知。
配置来源与生产一致：cordis input 缺省 + ~/.dsh/settings.yaml + DSH_TASK_NOTIFY_*。
`.trim());
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const { channel: wanted } = parseArgs(process.argv.slice(2));

  // 与生产同源的配置解析（patch input 层为空对象）。
  const config = resolveConfig({}, process.env);

  // 动态加载并行工作流产出的模块；缺失时报错退出而非崩溃堆栈。
  /** @type {any} */
  let format;
  try {
    format = await import('./format.mjs');
  } catch (error) {
    console.error('✗ format.mjs 加载失败：%s', error?.message ?? error);
    return 1;
  }
  /** @type {any} */
  let channelsModule;
  try {
    channelsModule = await import('./channels/index.mjs');
  } catch (error) {
    console.error('✗ channels/index.mjs 加载失败：%s', error?.message ?? error);
    return 1;
  }

  const deps = makeRealDeps();
  const ts = Date.now();
  // SPEC §7.4：payload 携带渲染后的远程图标 URL（禁用/未配置为空串）。
  const iconUrl = renderIconUrl(config.icons, 'idle');
  const samplePayload = Object.freeze({
    event: 'idle',
    title: format.formatTitle('idle'),
    body: format.formatBody(
      `task-notify 自检（self-test）@ ${new Date(ts).toLocaleString()} —— 收到即表示通道链路正常`,
      config.maxBodyLength,
    ),
    sessionId: 'selftest000-0000-0000',
    agentId: 'selftest000-0000-0000',
    ts,
    iconUrl,
  });

  // desktop 通道的本地 PNG 图标解析状态（windows 用；macOS 不接图）。
  let desktopIcon = '(未知)';
  try {
    const { resolveIconPath } = await import('./paths.mjs');
    desktopIcon = resolveIconPath(samplePayload.event) ?? '(缺失)';
  } catch {
    /* paths.mjs 缺失时仅影响展示，不影响自检主流程 */
  }

  let channels;
  try {
    channels = channelsModule.createChannels(config, deps);
  } catch (error) {
    console.error('✗ createChannels 失败：%s', error?.message ?? error);
    return 1;
  }
  if (!Array.isArray(channels) || channels.length === 0) {
    console.error('✗ 没有可用通道：请检查 settings.yaml 的 task-notify 各通道 enabled 配置。');
    return 1;
  }

  const selected = wanted === undefined
    ? channels
    : channels.filter((c) => matchesChannel(c?.name, wanted));
  if (selected.length === 0) {
    console.error(
      '✗ 未找到匹配的通道 "%s"。当前已启用通道：%s',
      wanted,
      channels.map((c) => c?.name ?? '?').join(', '),
    );
    return 1;
  }

  console.log(
    '→ 样例通知 event=%s title=%j body=%j\n  icon=%s desktopIcon=%s',
    samplePayload.event,
    samplePayload.title,
    samplePayload.body,
    iconUrl === '' ? '未配置' : iconUrl,
    desktopIcon,
  );

  let failed = 0;
  for (const channel of selected) {
    const name = channel?.name ?? '?';
    if (typeof channel?.send !== 'function') {
      console.error(`✗ ${name}：通道缺少 send() 方法`);
      failed++;
      continue;
    }
    try {
      await Promise.resolve(channel.send(samplePayload)).then(
        () => console.log(`✓ ${name}`),
        (error) => {
          console.error(`✗ ${name}：%s`, error?.message ?? error);
          failed++;
        },
      );
    } catch (error) {
      console.error(`✗ ${name}：%s`, error?.message ?? error);
      failed++;
    }
  }

  console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 个通道失败。`);
  return failed === 0 ? 0 : 1;
}

/** desktop 是逻辑名：按平台映射到 macos / windows 通道实现。 */
function matchesChannel(name, wanted) {
  const n = String(name ?? '').toLowerCase();
  if (wanted === 'desktop') return n === 'desktop' || n === 'macos' || n === 'windows';
  return n === wanted || n.includes(wanted);
}

/** 真实 Deps（SPEC 5.2）：run=execFile 数组传参；httpPost=fetch+8s AbortController。 */
const HTTP_TIMEOUT_MS = 8000;

function makeRealDeps() {
  return {
    run: (file, args, opts = {}) =>
      new Promise((resolve, reject) => {
        execFile(file, Array.isArray(args) ? args : [String(args)], { windowsHide: true, ...opts }, (error, stdout, stderr) => {
          if (error) {
            error.stdout = typeof stdout === 'string' ? stdout : '';
            error.stderr = typeof stderr === 'string' ? stderr : '';
            reject(error);
          } else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      }),
    httpPost: async (url, init = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`请求超过 ${HTTP_TIMEOUT_MS}ms 超时`)), HTTP_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return { status: response.status, text: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    logger: { info: (m) => console.log(String(m)), warn: (m) => console.warn(String(m)) },
    now: () => Date.now(),
  };
}

process.exit(await main());
