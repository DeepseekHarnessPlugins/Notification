/**
 * menu-core.mjs — 菜单控制的纯逻辑部分（无 I/O、无时钟，全部可单测）。
 *
 * 菜单编辑的是 settings.yaml 里 task-notify 段的「原始值」；展示层负责把
 * 缺省键渲染成默认值提示。所有函数返回新对象，绝不原地改入参——保存与否
 * 由交互壳决定，放弃退出时天然零副作用。
 */

export const KNOWN_EVENTS = ['idle', 'error', 'blocked', 'goal-completed'];
export const TIME_STYLE_VALUES = ['hidden', 'short', 'full'];
export const DESKTOP_MODES = ['auto', 'on', 'off'];

/** 菜单可编辑的通道段及其关键字段（label 用于交互提示）。 */
export const CHANNEL_SECTIONS = Object.freeze([
  { key: 'desktop', label: '桌面通知', fields: ['enabled', 'sound'] },
  { key: 'bark', label: 'Bark (iOS)', fields: ['enabled', 'server', 'deviceKey', 'sound'] },
  { key: 'ntfy', label: 'ntfy (Android/iOS)', fields: ['enabled', 'server', 'topic'] },
  { key: 'serverchan', label: 'Server酱 (微信)', fields: ['enabled', 'sendKey'] },
  { key: 'webhook', label: '通用 Webhook', fields: ['enabled', 'url'] },
]);

const clone = (v) => (v && typeof v === 'object' ? structuredClone(v) : v);

/**
 * 在 notifyOn 列表里切换一个事件的启用状态；列表不存在视为全关后开启该项。
 * 返回新数组，元素顺序遵循 KNOWN_EVENTS 的规范顺序。
 */
export function toggleEvent(section, event) {
  const current = Array.isArray(section?.notifyOn) ? section.notifyOn : [];
  const has = current.includes(event);
  const next = has ? current.filter((e) => e !== event) : [...current, event];
  return { ...section, notifyOn: KNOWN_EVENTS.filter((e) => next.includes(e)) };
}

/** 把 path（如 ['bark','deviceKey']）指向的叶子设为 value，返回新 section。 */
export function setField(section, path, value) {
  if (!Array.isArray(path) || path.length === 0) return section;
  const out = { ...clone(section ?? {}) };
  let node = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    node[key] = node[key] && typeof node[key] === 'object' ? { ...node[key] } : {};
    node = node[key];
  }
  node[path[path.length - 1]] = clone(value);
  return out;
}

/** 读取 path 叶子的当前值；缺省返回 fallback（用于展示默认值）。 */
export function getField(section, path, fallback) {
  let node = section;
  for (const key of path) {
    if (node === undefined || node === null || typeof node !== 'object') return fallback;
    node = node[key];
  }
  return node === undefined ? fallback : node;
}

/**
 * 循环切换：current 在 values 里取下一个（不在列表里则取第一个）。
 * 返回新 section，path 指向的叶子被更新。
 */
export function cycleField(section, path, values) {
  const current = getField(section, path, undefined);
  const idx = values.indexOf(current);
  const next = values[(idx + 1) % values.length];
  return setField(section, path, next);
}

/** 渲染 notifyOn 为 "idle✓ error✗ …" 一行摘要（未配置键按未启用显示）。 */
export function describeNotifyOn(section) {
  const current = Array.isArray(section?.notifyOn) ? section.notifyOn : [];
  return KNOWN_EVENTS.map((e) => e + (current.includes(e) ? '✓' : '✗')).join(' ');
}

/** 布尔字段的开关摘要。undefined 显示为默认值提示。 */
export function describeBool(value, defaultLabel) {
  if (value === undefined) return defaultLabel + '(默认)';
  return value ? '开' : '关';
}
