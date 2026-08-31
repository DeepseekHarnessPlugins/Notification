import { existsSync } from "node:fs";
import { resolveIconPath } from "../paths.mjs";
import { formatTitle } from "../format.mjs";

/** Sound played when the channel is configured with `sound: true`. */
const MACOS_SOUND_NAME = "Glass";

/**
 * Well-known terminal-notifier install locations, probed in order.
 * Apple-Silicon Homebrew first, then Intel Homebrew, then system paths.
 * A non-standard install can be pinned via `desktop.notifierPath`.
 */
export const TERMINAL_NOTIFIER_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
  "/usr/bin/terminal-notifier",
]);

/**
 * Escape an arbitrary string for embedding inside an AppleScript double
 * quoted literal. Backslashes must be escaped first, otherwise we would
 * double the backslashes we are about to add for the quotes.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Escape a string for terminal-notifier's `-title` / `-message` flags.
 *
 * terminal-notifier passes both flags through `NSString stringWithFormat:`,
 * so a lone `%` in the notification text would be read as a format specifier
 * and mangle or truncate the message. Documented in terminal-notifier's
 * README; here we escape `%` → `%%`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeNotifierText(value) {
  return String(value).replace(/%/g, "%%");
}

/**
 * Build the `osascript -e` script for one notification. Exported for tests;
 * production code only consumes {@link createChannel}.
 *
 * @param {string} title Notification headline (emoji-free since v0.2).
 * @param {string} body Single-line notification body.
 * @param {{ sound?: boolean }} [options] Append a sound clause.
 *   Neither an icon nor a click-through option exists here — see the module-
 *   level note on §7.4: `display notification` has no image parameter and no
 *   URL parameter, which is exactly why the terminal-notifier backend exists.
 * @returns {string} e.g. `display notification "b" with title "t" sound name "Glass"`
 */
export function buildNotificationScript(title, body, { sound = false } = {}) {
  let script =
    `display notification "${escapeAppleScriptString(body)}"` +
    ` with title "${escapeAppleScriptString(title)}"`;
  if (sound) script += ` sound name "${MACOS_SOUND_NAME}"`;
  return script;
}

/**
 * Build the argument array for one terminal-notifier invocation. Exported for
 * tests.
 *
 * terminal-notifier 3.x removed `-icon` and `-appIcon` (macOS has no API to
 * override a per-notification icon — the icon always comes from the app
 * bundle). We emit `-contentImage` for a full-size image attachment when
 * `imagePath` is provided; otherwise only title/message/sound/open.
 *
 * `-open` is the click-through mechanism: when the user clicks the
 * notification, the given URL is opened. This is the flag that fixes the
 * "clicking opens Script Editor" problem.
 *
 * @param {{ title?: string, body?: string, sound?: boolean,
 *   imagePath?: string|null, clickUrl?: string }} [options]
 * @returns {string[]} positional args after the executable name
 */
export function buildNotifierArgs({
  title,
  body,
  sound = false,
  imagePath = null,
  clickUrl = "",
} = {}) {
  const args = ["-title", escapeNotifierText(title), "-message", escapeNotifierText(body)];
  if (sound) args.push("-sound", MACOS_SOUND_NAME);
  if (typeof imagePath === "string" && imagePath.trim() !== "") args.push("-contentImage", imagePath.trim());
  if (typeof clickUrl === "string" && clickUrl.trim() !== "") args.push("-open", clickUrl.trim());
  return args;
}

/**
 * Locate a terminal-notifier binary. An explicit `config.notifierPath` wins
 * when it exists on disk; otherwise the well-known install locations are
 * probed in order.
 *
 * Pure existence check — no process spawn, so channel construction stays
 * synchronous and cheap.
 *
 * @param {{ notifierPath?: unknown }} [config]
 * @param {(path: string) => boolean} [exists] Test seam.
 * @returns {string|null} Absolute path, or null when nothing is found.
 */
export function findTerminalNotifier(config = {}, exists = existsSync) {
  const explicit = typeof config?.notifierPath === "string" ? config.notifierPath.trim() : "";
  if (explicit !== "" && exists(explicit)) return explicit;
  for (const candidate of TERMINAL_NOTIFIER_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Choose the poster for this channel. Resolved once at construction time so
 * every send is a single predictable execFile.
 *
 * @param {{ backend?: unknown, notifierPath?: unknown }} [config]
 * @param {(path: string) => boolean} [exists] Test seam.
 * @returns {{ kind: "osascript" } | { kind: "notifier", path: string }}
 */
export function resolveBackend(config = {}, exists = existsSync) {
  const want =
    typeof config?.backend === "string" && config.backend !== "" ? config.backend : "auto";
  if (want === "osascript") return { kind: "osascript" };
  const path = findTerminalNotifier(config, exists);
  return path ? { kind: "notifier", path } : { kind: "osascript" };
}

/**
 * macOS Notification Center channel, backed by either `/usr/bin/osascript` or
 * `terminal-notifier`.
 *
 * Why two backends (SPEC §7.4 revision):
 *
 * The `display notification` API has NO image parameter and NO URL parameter.
 * So under the osascript backend this channel deliberately ignores
 * `config.icons` and `config.clickUrl` — and clicking the notification
 * reactivates the *posting* application. Because `osascript` is not a GUI app,
 * macOS resolves that to **Script Editor**, which is why a click opens
 * Script Editor instead of a browser.
 *
 * `terminal-notifier` (3.x) supplies the click-through piece: `-open <url>`
 * makes a click open the URL. Per-notification custom icons are NOT
 * supported in 3.x — macOS has no API to override them, and the icon always
 * comes from the app bundle. `-contentImage <path>` attaches a preview
 * image; `-sound <name>` plays a sound. The backend is auto-selected: when
 * a terminal-notifier binary is on disk it is used; otherwise we fall back
 * to osascript so the channel stays zero-dependency and never fails hard.
 *
 * @param {{ enabled?: boolean, sound?: boolean, backend?: string,
 *   clickUrl?: string, notifierPath?: string,
 *   icons?: { enabled?: boolean } }} config Resolved desktop section of the
 *   plugin config.
 * @param {import("./index.mjs").Deps} deps Injected runtime dependencies.
 * @returns {{ name: string, send(payload: object): Promise<void> }}
 * @throws {TypeError} When required deps are missing — the registry catches
 *   this and skips the channel instead of taking the plugin down.
 */
export function createChannel(config = {}, deps) {
  const run = deps?.run;
  const logger = deps?.logger;
  if (typeof run !== "function") {
    throw new TypeError("macos channel requires deps.run(file, args, opts?)");
  }
  if (!logger || typeof logger.warn !== "function") {
    throw new TypeError("macos channel requires deps.logger.warn(msg)");
  }

  const backend = resolveBackend(config);
  if (config?.backend === "terminal-notifier" && backend.kind === "osascript") {
    logger.warn(
      "[task-notify] desktop.backend='terminal-notifier' but no binary found " +
        "(tried desktop.notifierPath and the Homebrew/system paths), " +
        "falling back to osascript — icon and click-through are unavailable",
    );
  }

  /**
   * Resolve the full-size PNG for the `-contentImage` attachment. Respects
   * the shared `icons` section; returns null so the notification simply goes
   * out without an image. terminal-notifier 3.x attaches this as a preview
   * image, NOT as the per-notification icon (that is fixed to the app
   * bundle's icon).
   *
   * @param {object} [payload]
   * @returns {string|null}
   */
  function imageFor(payload) {
    if (!config.icons || config.icons.enabled === false) return null;
    try {
      return resolveIconPath(payload?.event);
    } catch {
      return null;
    }
  }

  /**
   * Deliver one payload via Notification Center. Success is silent; any
   * failure (binary missing, non-zero exit, user denied permission) is
   * logged at warn level and swallowed — notifications must never break the
   * host session.
   *
   * @param {{ title?: string, body?: string, event?: string }} [payload]
   * @returns {Promise<void>}
   */
  async function send(payload = {}) {
    if (config.enabled === false) return;

    // index.mjs normally pre-formats title/body; fall back to the event
    // mapping so channels stay usable standalone (self-test.mjs).
    const title =
      typeof payload.title === "string" && payload.title.length > 0
        ? payload.title
        : formatTitle(payload.event);
    const body = typeof payload.body === "string" ? payload.body : "";

    let file;
    let args;
    if (backend.kind === "notifier") {
      file = backend.path;
      args = buildNotifierArgs({
        title,
        body,
        sound: config.sound === true,
        imagePath: imageFor(payload),
        clickUrl: config.clickUrl ?? "",
      });
    } else {
      file = "osascript";
      args = ["-e", buildNotificationScript(title, body, { sound: config.sound === true })];
    }

    try {
      await run(file, args);
    } catch (error) {
      logger.warn(`[task-notify] macOS notification failed: ${describeError(error)}`);
    }
  }

  return { name: "desktop", send };
}

/** @param {unknown} error @returns {string} Best-effort human-readable cause. */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
