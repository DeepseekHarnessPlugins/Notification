import { formatTitle } from "../format.mjs";

/** Sound played when the channel is configured with `sound: true`. */
const MACOS_SOUND_NAME = "Glass";

/**
 * Escape an arbitrary string for embedding inside an AppleScript double
 * quoted literal. Backslashes must be escaped first, otherwise we would
 * double the backslashes we are about to add for the quotes.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the `osascript -e` script for one notification. Exported for tests;
 * production code only consumes {@link createChannel}.
 *
 * @param {string} title Notification headline (emoji-free since v0.2).
 * @param {string} body Single-line notification body.
 * @param {{ sound?: boolean }} [options] Append a sound clause.
 *   (No icon option exists here — see the module-level note on §7.4.)
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
 * macOS Notification Center channel, backed by `/usr/bin/osascript`.
 *
 * Note: intentionally no icon support (SPEC §7.4) — macOS Notification
 * Center offers no way to override the per-notification app icon via
 * `display notification` (the API has no image parameter), so this channel
 * deliberately ignores `config.icons` and `payload.iconUrl`. Custom icons
 * apply to Windows toasts and webhook payloads only.
 *
 * @param {{ enabled?: boolean, sound?: boolean }} config Resolved desktop
 *   section of the plugin config.
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

  /**
   * Deliver one payload via Notification Center. Success is silent; any
   * failure (osascript missing, non-zero exit, user denied permission) is
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

    const script = buildNotificationScript(title, body, {
      sound: config.sound === true,
    });
    try {
      await run("osascript", ["-e", script]);
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
