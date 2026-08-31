/**
 * config.mjs — dsh-task-notify 配置解析。
 *
 * SPEC 5.3 三层优先级（高 → 低）：
 *   1. cordis patch 显式 input（apply 的第二参）
 *   2. ~/.dsh/settings.yaml 顶层 `task-notify:` 键
 *   3. 环境变量 DSH_TASK_NOTIFY_*
 *   4. 内置默认值
 *
 * 解析规则：
 *   - 深度合并普通对象；数组整体替换（notifyOn / webhook.headers 例外见下）。
 *   - 未知键忽略并 warn；enabled 非布尔容错（"true"/"false"/0/1 等）。
 *   - settings.yaml 读取/解析失败时降级为该层缺失并 warn，绝不抛出。
 *   - 返回深度冻结的规范化配置。
 *
 * v0.2 新增 icons 段（SPEC §7.3）：{ enabled: true, urlTemplate: "" }，
 * 遵守同一三层合并；env 键 DSH_TASK_NOTIFY_ICONS_ENABLED / _URL_TEMPLATE。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parseDocument, stringify } from 'yaml';

/** 默认 settings.yaml 路径。 */
export const DEFAULT_SETTINGS_PATH = join(homedir(), '.dsh', 'settings.yaml');

/** 内置默认值（SPEC 5.3 schema）。深拷贝后作为合并基底，绝不直接暴露可变引用。 */
export function defaultConfig() {
  return {
    enabled: true,
    notifyOn: ['idle', 'error', 'blocked'],
    agents: 'root',
    coalesceWindowMs: 2000,
    maxBodyLength: 120,
    desktop: { enabled: 'auto', sound: true, backend: 'auto', clickUrl: '', notifierPath: '' },
    bark: { enabled: false, server: 'https://api.day.app', deviceKey: '', sound: '' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
    serverchan: { enabled: false, sendKey: '' },
    webhook: { enabled: false, url: '', headers: {} },
    // SPEC §7.3：图形图标。enabled 默认 true（总开关）；urlTemplate 为空表示
    // 未配置远程图标 URL，payload.iconUrl 渲染为 ""。
    icons: { enabled: true, urlTemplate: '' },
    // v0.3：通知排版。time 控制正文尾部时间样式（hidden | short | full），
    // showDuration 在 payload 带 durationMs 时追加 "用时 X" 后缀。
    format: { time: 'short', showDuration: true },
  };
}

/** 各层级允许出现的键（未知键忽略 + warn）。通道段内部键单独校验。 */
const KNOWN_TOP_KEYS = new Set([
  'enabled', 'notifyOn', 'agents', 'coalesceWindowMs', 'maxBodyLength',
  'desktop', 'bark', 'ntfy', 'serverchan', 'webhook', 'icons', 'format',
]);
const KNOWN_SECTION_KEYS = {
  desktop: new Set(['enabled', 'sound', 'backend', 'clickUrl', 'notifierPath']),
  bark: new Set(['enabled', 'server', 'deviceKey', 'sound']),
  ntfy: new Set(['enabled', 'server', 'topic', 'token']),
  serverchan: new Set(['enabled', 'sendKey']),
  webhook: new Set(['enabled', 'url', 'headers']),
  icons: new Set(['enabled', 'urlTemplate']),
  format: new Set(['time', 'showDuration']),
};

/**
 * 读取并解析 settings.yaml。
 * @param {string} path yaml 文件路径
 * @param {(msg: string) => void} [warn] 警告收集回调
 * @returns {object|null} 解析出的顶层对象；文件不存在或内容非法时返回 null（不抛出）。
 */
export function loadSettings(path, warn = () => {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      warn(`settings.yaml 读取失败（${path}）：${describe(error)}，已忽略该配置层`);
    }
    return null; // ENOENT 属正常情况：用户可能没有 settings.yaml
  }
  let doc;
  try {
    const parsed = parseDocument(raw);
    // 检查解析错误（新 yaml 包不抛出，而是收集错误）
    if (parsed.errors && parsed.errors.length > 0) {
      warn(`settings.yaml 解析失败（${path}）：${parsed.errors[0].message}，已忽略该配置层`);
      return null;
    }
    doc = parsed.toJS();
  } catch (error) {
    warn(`settings.yaml 解析失败（${path}）：${describe(error)}，已忽略该配置层`);
    return null;
  }
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) {
    warn(`settings.yaml 顶层必须是映射（${path}），已忽略该配置层`);
    return null;
  }
  return doc;
}

/**
 * 解析最终配置（SPEC 5.3）。
 * @param {object} [input] cordis patch 显式传入的 input（最高优先级）
 * @param {NodeJS.ProcessEnv|object} [env] 环境变量对象，默认 process.env
 * @param {string|null} [settingsPath] settings.yaml 路径；传 undefined 用默认路径，
 *   传 null 跳过 settings 层（测试与确定性场景用）
 * @returns {object} 深度冻结的规范化配置
 */
export function resolveConfig(input = {}, env = process.env, settingsPath) {
  const { config } = resolveConfigDetailed(input, env, settingsPath);
  return config;
}

/**
 * 同 {@link resolveConfig}，但额外返回警告列表（便于测试断言，不必 mock console）。
 * 导出的 resolveConfig 会把 warnings 逐条经 console.warn 输出（此时还没有 ctx.logger）。
 */
export function resolveConfigDetailed(input = {}, env = process.env, settingsPath) {
  /** @type {string[]} */
  const warnings = [];
  const warn = (msg) => warnings.push(`[task-notify] ${msg}`);

  // ---- 层 4：内置默认值（深拷贝基底）----
  const merged = structuredClone(defaultConfig());

  // ---- 层 3：环境变量 ----
  applyEnvLayer(merged, env ?? {}, warn);

  // ---- 层 2：settings.yaml 的 task-notify 键 ----
  if (settingsPath !== null) {
    const file = typeof settingsPath === 'string' && settingsPath.length > 0
      ? (isAbsolute(settingsPath) ? settingsPath : join(process.cwd(), settingsPath))
      : DEFAULT_SETTINGS_PATH;
    const doc = loadSettings(file, warn);
    const section = doc === null ? undefined : doc['task-notify'];
    if (section !== undefined && !isPlainObject(section)) {
      warn('settings.yaml 的 task-notify 键必须是映射，已忽略');
    } else if (isPlainObject(section)) {
      mergeSection(merged, section, 'settings.yaml', warn);
    }
  }

  // ---- 层 1：cordis patch 显式 input ----
  if (input !== undefined && input !== null && !isPlainObject(input)) {
    warn(`patch input 必须是对象，收到 ${typeName(input)}，已忽略`);
  } else if (isPlainObject(input)) {
    mergeSection(merged, input, 'patch input', warn);
  }

  normalizeInPlace(merged, warn);
  const config = deepFreeze(merged);

  // 有 warn 渠道的调用方走 resolveConfigDetailed；直接调用则输出到 console。
  if (warnings.length > 0) for (const line of warnings) console.warn(line);
  return { config, warnings };
}

/* ------------------------------------------------------------------ */
/* 环境变量层                                                          */
/* ------------------------------------------------------------------ */

/**
 * 支持的 DSH_TASK_NOTIFY_* 变量 → [目标段, 目标键, 值变换]。
 * 注释即文档：新增变量在此表登记即可。
 */
const ENV_MAP = [
  ['DSH_TASK_NOTIFY_ENABLED', [], 'enabled', coerceBool],
  ['DSH_TASK_NOTIFY_NOTIFY_ON', [], 'notifyOn', coerceEventList],
  ['DSH_TASK_NOTIFY_AGENTS', [], 'agents', coerceAgents],
  ['DSH_TASK_NOTIFY_COALESCE_WINDOW_MS', [], 'coalesceWindowMs', coerceNonNegInt],
  ['DSH_TASK_NOTIFY_MAX_BODY_LENGTH', [], 'maxBodyLength', coerceNonNegInt],
  ['DSH_TASK_NOTIFY_DESKTOP_ENABLED', ['desktop'], 'enabled', coerceDesktopMode],
  ['DSH_TASK_NOTIFY_DESKTOP_SOUND', ['desktop'], 'sound', coerceBool],
  // v0.3.1：macOS 双后端（osascript | terminal-notifier）与点击跳转 URL
  ['DSH_TASK_NOTIFY_DESKTOP_BACKEND', ['desktop'], 'backend', coerceBackend],
  ['DSH_TASK_NOTIFY_DESKTOP_CLICK_URL', ['desktop'], 'clickUrl', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_DESKTOP_NOTIFIER_PATH', ['desktop'], 'notifierPath', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_BARK_ENABLED', ['bark'], 'enabled', coerceBool],
  ['DSH_TASK_NOTIFY_BARK_SERVER', ['bark'], 'server', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_BARK_DEVICE_KEY', ['bark'], 'deviceKey', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_BARK_SOUND', ['bark'], 'sound', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_NTFY_ENABLED', ['ntfy'], 'enabled', coerceBool],
  ['DSH_TASK_NOTIFY_NTFY_SERVER', ['ntfy'], 'server', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_NTFY_TOPIC', ['ntfy'], 'topic', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_NTFY_TOKEN', ['ntfy'], 'token', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_SERVERCHAN_ENABLED', ['serverchan'], 'enabled', coerceBool],
  ['DSH_TASK_NOTIFY_SERVERCHAN_SEND_KEY', ['serverchan'], 'sendKey', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_WEBHOOK_ENABLED', ['webhook'], 'enabled', coerceBool],
  ['DSH_TASK_NOTIFY_WEBHOOK_URL', ['webhook'], 'url', coerceTrimmedString],
  ['DSH_TASK_NOTIFY_WEBHOOK_HEADERS', ['webhook'], 'headers', coerceHeadersJson],
  // SPEC §7.3：icons 段
  ['DSH_TASK_NOTIFY_ICONS_ENABLED', ['icons'], 'enabled', coerceBool],
  ['DSH_TASK_NOTIFY_ICONS_URL_TEMPLATE', ['icons'], 'urlTemplate', coerceTrimmedString],
  // v0.3：format 段
  ['DSH_TASK_NOTIFY_FORMAT_TIME', ['format'], 'time', coerceTimeStyle],
  ['DSH_TASK_NOTIFY_FORMAT_SHOW_DURATION', ['format'], 'showDuration', coerceBool],
];

function applyEnvLayer(target, env, warn) {
  for (const [name, path, key, transform] of ENV_MAP) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue; // 空串视同未设置
    const result = transform(raw);
    if (!result.ok) {
      warn(`环境变量 ${name}=${JSON.stringify(raw)} 不合法（${result.reason}），已忽略`);
      continue;
    }
    assign(target, path, key, result.value);
  }
}

/* ------------------------------------------------------------------ */
/* 合并与规范化                                                        */
/* ------------------------------------------------------------------ */

/** 把一个「同构部分覆盖」对象深度合并进 target（数组整体替换），未知键 warn+忽略。 */
function mergeSection(target, source, layerLabel, warn) {
  for (const [key, value] of Object.entries(source)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      warn(`${layerLabel}：未知键 "${key}" 已忽略`);
      continue;
    }
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      mergeLeafObject(current, value, key, layerLabel, warn);
    } else {
      target[key] = tryClone(value);
    }
  }
}

function mergeLeafObject(current, incoming, sectionName, layerLabel, warn) {
  for (const [key, value] of Object.entries(incoming)) {
    const known = KNOWN_SECTION_KEYS[sectionName];
    if (!known || !known.has(key)) {
      warn(`${layerLabel}：${sectionName} 段未知键 "${key}" 已忽略`);
      continue;
    }
    current[key] = tryClone(value); // 数组（如 headers 不会出现数组）整体替换语义同样适用
  }
}

/**
 * 就地规范化：类型容错的最后一道关。
 * 三层各自可能写入错误类型的值（例如 settings 里 enabled: "yes"），
 * 这里统一做宽容转换；无法转换的回退默认值并 warn。
 */
function normalizeInPlace(cfg, warn) {
  cfg.enabled = withFallback(coerceBool(cfg.enabled), true, 'enabled', warn);

  const events = coerceEventList(cfg.notifyOn);
  if (!events.ok) {
    warn(`notifyOn：${events.reason}，已回退默认值`);
    cfg.notifyOn = defaultConfig().notifyOn;
  } else {
    cfg.notifyOn = events.value;
  }

  cfg.agents = withFallback(coerceAgents(cfg.agents), 'root', 'agents', warn);
  cfg.coalesceWindowMs = withFallback(coerceNonNegInt(cfg.coalesceWindowMs), 2000, 'coalesceWindowMs', warn);
  cfg.maxBodyLength = withFallback(coerceNonNegInt(cfg.maxBodyLength), 120, 'maxBodyLength', warn);

  cfg.desktop.enabled = withFallback(coerceDesktopMode(cfg.desktop?.enabled), 'auto', 'desktop.enabled', warn);
  cfg.desktop.sound = withFallback(coerceBool(cfg.desktop?.sound), true, 'desktop.sound', warn);
  // v0.3.1：macOS 后端选择与点击跳转。后端非法值回退 'auto' 并 warn，
  // 保证用户写错也不至于完全发不出通知。
  cfg.desktop.backend = withFallback(coerceBackend(cfg.desktop?.backend), 'auto', 'desktop.backend', warn);
  cfg.desktop.clickUrl = withFallback(coerceTrimmedString(cfg.desktop?.clickUrl), '', 'desktop.clickUrl', warn);
  cfg.desktop.notifierPath = withFallback(coerceTrimmedString(cfg.desktop?.notifierPath), '', 'desktop.notifierPath', warn);

  cfg.bark = normalizeChannel(cfg.bark, KNOWN_SECTION_KEYS.bark, 'bark', warn, {
    server: 'https://api.day.app',
  });
  cfg.ntfy = normalizeChannel(cfg.ntfy, KNOWN_SECTION_KEYS.ntfy, 'ntfy', warn, {
    server: 'https://ntfy.sh',
  });
  cfg.serverchan = normalizeChannel(cfg.serverchan, KNOWN_SECTION_KEYS.serverchan, 'serverchan', warn);
  cfg.webhook = normalizeChannel(cfg.webhook, KNOWN_SECTION_KEYS.webhook, 'webhook', warn);
  cfg.webhook.headers = normalizeHeaders(cfg.webhook.headers, warn);

  // SPEC §7.3：icons 段。与通道段不同，enabled 默认 true（总开关），因此
  // 不复用 normalizeChannel（其 enabled 默认 false），单独归一化。
  if (!isPlainObject(cfg.icons)) {
    warn('icons 段不是对象，已回退默认值');
    cfg.icons = { ...defaultConfig().icons };
  }
  cfg.icons.enabled = withFallback(coerceBool(cfg.icons.enabled), true, 'icons.enabled', warn);
  cfg.icons.urlTemplate = withFallback(
    coerceTrimmedString(cfg.icons.urlTemplate),
    '',
    'icons.urlTemplate',
    warn,
  );

  // v0.3：format 段。与通道段不同，showDuration 默认 true，单独归一化。
  if (!isPlainObject(cfg.format)) {
    warn('format 段不是对象，已回退默认值');
    cfg.format = { ...defaultConfig().format };
  }
  cfg.format.time = withFallback(coerceTimeStyle(cfg.format.time), 'short', 'format.time', warn);
  cfg.format.showDuration = withFallback(coerceBool(cfg.format.showDuration), true, 'format.showDuration', warn);
}

function normalizeChannel(section, knownKeys, name, warn, stringDefaults = {}) {
  if (!isPlainObject(section)) {
    warn(`${name} 段不是对象，已回退默认值`);
    section = { ...defaultConfig()[name] };
  }
  section.enabled = withFallback(coerceBool(section.enabled), false, `${name}.enabled`, warn);
  for (const key of knownKeys) {
    if (key === 'enabled') continue;
    if (key === 'headers') continue; // headers 由 normalizeHeaders 单独处理（对象而非字符串）
    const fallback = stringDefaults[key] ?? '';
    section[key] = withFallback(coerceTrimmedString(section[key]), fallback, `${name}.${key}`, warn);
  }
  return section;
}

function normalizeHeaders(headers, warn) {
  if (headers === undefined || headers === null || headers === '') return {};
  if (!isPlainObject(headers)) {
    warn(`webhook.headers 必须是字符串映射，已忽略`);
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = String(v);
  return out;
}

/* ------------------------------------------------------------------ */
/* 类型容错原语                                                        */
/* ------------------------------------------------------------------ */

/** @returns {{ok: true, value}|{ok: false, reason: string}} */
function coerceBool(v) {
  if (typeof v === 'boolean') return ok(v);
  if (v === 'true' || v === '1' || v === 1 || v === 'yes' || v === 'on') return ok(true);
  if (v === 'false' || v === '0' || v === 0 || v === 'no' || v === 'off') return ok(false);
  if (v === '' || v === null || v === undefined) return fail('缺少布尔值');
  return fail(`无法把 ${typeName(v)} 解释为布尔值`);
}

function coerceNonNegInt(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) return fail(`需要非负整数`);
  return ok(n);
}

function coerceTrimmedString(v) {
  if (typeof v === 'string') return ok(v.trim());
  if (typeof v === 'number' || typeof v === 'boolean') return ok(String(v));
  return fail(`需要字符串`);
}

function coerceAgents(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'root' || s === 'all') return ok(s);
  return fail(`agents 只接受 "root" 或 "all"`);
}

function coerceDesktopMode(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'auto' || s === 'on' || s === 'off') return ok(s);
  return fail(`desktop.enabled 只接受 auto | on | off`);
}

/** v0.3.1：macOS 通知后端。auto=有 terminal-notifier 就用它，否则 osascript。 */
function coerceBackend(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'auto' || s === 'osascript' || s === 'terminal-notifier') return ok(s);
  return fail('desktop.backend 只接受 auto | osascript | terminal-notifier');
}

/** v0.3：format.time 合法值。 */
function coerceTimeStyle(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'hidden' || s === 'short' || s === 'full') return ok(s);
  return fail('format.time 只接受 hidden | short | full');
}

const KNOWN_EVENTS = new Set(['idle', 'error', 'blocked', 'goal-completed']);

function coerceEventList(v) {
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) return fail(`notifyOn 需要数组或逗号分隔字符串`);
  /** @type {string[]} */
  const out = [];
  for (const item of v) {
    const s = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!KNOWN_EVENTS.has(s)) return fail(`未知事件 "${String(item)}"`);
    if (!out.includes(s)) out.push(s);
  }
  return ok(out);
}

function coerceHeadersJson(v) {
  if (isPlainObject(v)) return ok(v);
  try {
    const parsed = JSON.parse(String(v));
    if (isPlainObject(parsed)) return ok(parsed);
  } catch { /* fallthrough */ }
  return fail(`需要 JSON 对象字符串，如 '{"X-Token":"abc"}'`);
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function typeName(v) {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}
function ok(value) { return { ok: true, value }; }
function fail(reason) { return { ok: false, reason }; }
function describe(error) { return error instanceof Error ? error.message : String(error); }

function withFallback(result, fallback, label, warn) {
  if (result.ok) return result.value;
  warn(`${label}：${result.reason}，已回退默认值 ${JSON.stringify(fallback)}`);
  return fallback;
}

function assign(target, path, key, value) {
  let node = target;
  for (const segment of path) node = node[segment];
  node[key] = value;
}

function tryClone(v) {
  return isPlainObject(v) ? structuredClone(v) : v;
}

function deepFreeze(value) {
  if (isPlainObject(value)) for (const child of Object.values(value)) deepFreeze(child);
  else if (Array.isArray(value)) value.forEach(deepFreeze);
  return Object.freeze(value);
}
