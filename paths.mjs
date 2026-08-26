/**
 * paths.mjs — 包目录推导与图标资产路径解析（SPEC §7.2/§7.4）。
 *
 * 为什么单独成模块：channels/*.mjs 需要按 event 解析 assets/icons/<event>.png，
 * 若该能力放在 index.mjs 会形成 channels → index 循环依赖；format.mjs 则必须
 * 保持纯函数（无 I/O）。本模块只做路径与存在性检查，被 index、channels 与
 * self-test 共同导入。
 *
 * 所有路径都从 `import.meta.url` 推导包目录，绝不依赖 cwd —— 打包安装后
 * （npm 包 / dsh bundle）同样有效。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_META, FALLBACK_ICON } from "./format.mjs";

/** 包根目录（本文件所在目录），绝对路径。 */
export const PACKAGE_DIR = fileURLToPath(new URL("./", import.meta.url));

/** 默认图标资产目录：<package>/assets/icons。 */
export const ICONS_DIR = join(PACKAGE_DIR, "assets", "icons");

/**
 * Map a lifecycle event to its icon asset base name.
 *
 * @param {string|undefined} event Known events map to themselves; anything
 *   else (unknown status, empty string) falls back to `"notify"` (SPEC §7.2).
 * @returns {string}
 */
export function iconBaseName(event) {
  return EVENT_META[event]?.icon ?? FALLBACK_ICON;
}

/**
 * Resolve an icon asset to an absolute path, with existence check and the
 * SPEC §7.4 fallback chain: `<event>.<ext>` missing → `notify.<ext>` missing
 * → `null`.
 *
 * @param {string|undefined} event Lifecycle event name.
 * @param {string} [rootDir] Icon directory override — test seam only
 *   (production callers omit it; lets tests point at a temp dir without
 *   writing into the real package).
 * @param {string} ext Asset extension including the dot (".png" / ".svg").
 * @returns {string|null} Absolute path of an existing file, or null.
 */
function resolveIconFile(event, rootDir, ext) {
  const base = iconBaseName(event);
  const dir = typeof rootDir === "string" && rootDir !== "" ? rootDir : ICONS_DIR;
  const primary = join(dir, `${base}${ext}`);
  if (existsSync(primary)) return primary;
  if (base !== FALLBACK_ICON) {
    const fallback = join(dir, `${FALLBACK_ICON}${ext}`);
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

/**
 * Resolve the PNG icon for an event (Windows toast appLogoOverride).
 * Returns null when neither `<event>.png` nor `notify.png` exists — callers
 * must treat null as "send without image", never as an error.
 *
 * @param {string|undefined} event
 * @param {string} [rootDir] Test seam, see {@link resolveIconFile}.
 * @returns {string|null}
 */
export function resolveIconPath(event, rootDir) {
  return resolveIconFile(event, rootDir, ".png");
}

/**
 * Resolve the SVG icon for an event (generic webhook `iconSvg` inlining).
 * Same fallback chain and null semantics as {@link resolveIconPath}.
 *
 * @param {string|undefined} event
 * @param {string} [rootDir] Test seam, see {@link resolveIconFile}.
 * @returns {string|null}
 */
export function resolveIconSvgPath(event, rootDir) {
  return resolveIconFile(event, rootDir, ".svg");
}
