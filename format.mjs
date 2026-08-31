/**
 * Text formatting helpers for dsh-task-notify.
 *
 * Pure functions only — no I/O, no clock, no environment access, so every
 * helper here is trivially unit-testable. Since v0.2 (SPEC §7.1) all canned
 * headlines are emoji-free; {@link stripEmoji} stays as a defensive tool for
 * arbitrary upstream text that may still carry emoji.
 */

/** Cap applied by {@link formatBody} when `maxLen` is missing or invalid. */
export const DEFAULT_MAX_BODY_LENGTH = 120;

// SPEC §7.1 — strings are locked verbatim, no emoji anywhere.
const TITLE_BY_EVENT = Object.freeze({
  idle: "任务完成",
  completed: "任务完成",
  error: "任务出错",
  blocked: "需要确认",
  "goal-completed": "目标达成",
});

const FALLBACK_TITLE = "任务通知";

/**
 * Per-event presentation metadata (SPEC §7.2/§7.4). `icon` is the asset base
 * name under `assets/icons/` (`<icon>.svg` / `<icon>.png`); `color` mirrors
 * the locked accent of the corresponding icon. Unknown events fall back to
 * {@link FALLBACK_ICON} ("notify") — see paths.mjs.
 */
const META_BY_EVENT = Object.freeze({
  idle: Object.freeze({ color: "#34C759", icon: "idle" }),
  error: Object.freeze({ color: "#FF3B30", icon: "error" }),
  blocked: Object.freeze({ color: "#FF9500", icon: "blocked" }),
  "goal-completed": Object.freeze({ color: "#007AFF", icon: "goal-completed" }),
});

export const EVENT_META = Object.freeze(
  Object.fromEntries(
    Object.entries(META_BY_EVENT).map(([event, meta]) => [
      event,
      Object.freeze({ title: TITLE_BY_EVENT[event], ...meta }),
    ]),
  ),
);

/** Asset base name used when an event has no dedicated icon. */
export const FALLBACK_ICON = "notify";

// Emoji-ish code points only: pictograph/supplement blocks, misc symbols and
// dingbats, enclosed alphanumerics used as emoji, the clock/hourglass corner
// of Misc Technical (⏰ ⏸ ⏹ …), variation selectors, ZWJ joiners and the
// keycap combining mark. Plain ASCII, CJK text, arrows (← ↑) and typographic
// symbols like © ® ™ ⌘ are deliberately left alone.
const EMOJI_PATTERN = new RegExp(
  "[\\u{1F000}-\\u{1FAFF}" +
    "\\u{2600}-\\u{27BF}" +
    "\\u{2B00}-\\u{2BFF}" +
    "\\u{23E9}-\\u{23FA}\\u{23F0}\\u{23F3}" +
    "\\u{2139}\\u{2934}-\\u{2935}\\u{3030}\\u{303D}\\u{3297}\\u{3299}" +
    "\\u{FE00}-\\u{FE0F}\\u{200D}\\u{20E3}]",
  "gu",
);

/**
 * Map a lifecycle event name to its notification headline.
 *
 * @param {string|undefined} event One of `idle | error | blocked |
 *   goal-completed`; anything else (including undefined) falls back to a
 *   generic headline so an unknown upstream status still notifies.
 * @returns {string} Emoji-free headline, e.g. `"任务完成"` (SPEC §7.1).
 */
export function formatTitle(event) {
  return TITLE_BY_EVENT[event] ?? FALLBACK_TITLE;
}

/**
 * Normalize free-form text into a single-line notification body.
 *
 * All whitespace runs (newlines, tabs, repeated spaces) collapse to one
 * space, then the result is truncated on code-point boundaries so a cut can
 * never split a surrogate pair, with a trailing ellipsis when truncated.
 *
 * @param {string|null|undefined} text Raw body text; nullish becomes `""`,
 *   non-strings are coerced defensively.
 * @param {number} [maxLen=DEFAULT_MAX_BODY_LENGTH] Maximum character count
 *   of the result (the ellipsis counts toward it). Values below 1 or
 *   non-finite values fall back to {@link DEFAULT_MAX_BODY_LENGTH}.
 * @returns {string}
 */
export function formatBody(text, maxLen = DEFAULT_MAX_BODY_LENGTH) {
  if (text == null) return "";
  const raw = typeof text === "string" ? text : String(text);
  const normalized = raw.replace(/\s+/g, " ").trim();

  let limit = Math.floor(Number(maxLen));
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_MAX_BODY_LENGTH;

  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  return `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * Remove emoji from a string. Since v0.2 the canned titles are emoji-free,
 * but this stays as a defensive tool for arbitrary upstream text (session
 * titles, user input) that may still carry emoji before it is embedded in a
 * desktop notification. Also collapses the double spaces left behind by
 * removals and trims the ends, so `"✅ 任务完成"` becomes `"任务完成"`
 * rather than `" 任务完成"`.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function stripEmoji(text) {
  if (text == null) return "";
  const raw = typeof text === "string" ? text : String(text);
  return raw
    .replace(EMOJI_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* v0.3 时间与组合排版（格式化时间 + 通知正文组装）                      */
/* ------------------------------------------------------------------ */

/** formatTime 支持的样式。 */
export const TIME_STYLES = Object.freeze(["hidden", "short", "full"]);

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * 把 epoch 毫秒渲染成本地时间串。
 *
 * @param {number|Date|null|undefined} ts epoch 毫秒（也接受 Date）；非法值返回空串
 * @param {string} [style="short"] "hidden" 不显示；"short" 为 HH:mm；
 *   "full" 为 YYYY-MM-DD HH:mm:ss；未知样式按 short 处理
 * @returns {string}
 */
export function formatTime(ts, style = "short") {
  if (style === "hidden") return "";
  const date = ts instanceof Date ? ts : new Date(ts);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const hhmm = pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  if (style === "full") {
    const y = date.getFullYear();
    const mo = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    return y + "-" + mo + "-" + d + " " + hhmm + ":" + pad2(date.getSeconds());
  }
  return hhmm;
}

/**
 * 把耗时毫秒渲染为紧凑中文时长；非正数/非有限值返回空串（调用方直接过滤）。
 *
 * @param {number|undefined} durationMs
 * @returns {string} 如 "42秒"、"3分05秒"、"1小时02分"
 */
export function formatDuration(durationMs) {
  const n = Number(durationMs);
  if (!Number.isFinite(n) || n <= 0) return "";
  const totalSec = Math.round(n / 1000);
  if (totalSec < 60) return totalSec + "秒";
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? totalMin + "分" + pad2(sec) + "秒" : totalMin + "分";
  const hour = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? hour + "小时" + pad2(min) + "分" : hour + "小时";
}

/**
 * 组装最终通知正文：内容摘要在前，时间与耗时作为后缀缀在末尾。
 *
 * 后缀永远不参与截断——formatBody 先对内容截到 maxLen，时间/耗时再以
 * " · " 分隔接上，保证任何配置下时间都完整可见。全部部分为空时返回空串。
 *
 * @param {string|null|undefined} text 原始正文（会先经 formatBody 规整）
 * @param {object} [options]
 * @param {number|Date} [options.ts] epoch 毫秒，配合 timeStyle 渲染
 * @param {number} [options.durationMs] 可选耗时，showDuration 时追加 "用时 X"
 * @param {string} [options.timeStyle="short"] 传给 formatTime
 * @param {boolean} [options.showDuration=true]
 * @param {number} [options.maxLen] 内容截断上限（仅作用于内容部分）
 * @returns {string}
 */
export function composeBody(text, options = {}) {
  const {
    ts,
    durationMs,
    timeStyle = "short",
    showDuration = true,
    maxLen = DEFAULT_MAX_BODY_LENGTH,
  } = options ?? {};

  const parts = [];
  const content = formatBody(text, maxLen);
  if (content) parts.push(content);

  const time = formatTime(ts, timeStyle);
  if (time) parts.push(time);

  if (showDuration) {
    const duration = formatDuration(durationMs);
    if (duration) parts.push("用时 " + duration);
  }
  return parts.join(" · ");
}
