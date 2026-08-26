import { createChannel as createMacosChannel } from "./macos.mjs";
import { createChannel as createWindowsChannel } from "./windows.mjs";
import { createChannel as createWebhookChannel } from "./webhook.mjs";

/**
 * Shared injected-dependency contract for every channel. Everything that
 * touches the outside world comes in through this object so tests run with
 * fakes and no real notification ever fires.
 *
 * @typedef {object} Deps
 * @property {(file: string, args: string[], opts?: object) => Promise<{stdout: string, stderr: string}>} run
 *   execFile-style process runner (rejects on non-zero exit).
 * @property {(url: string, init?: {headers?: object, body?: string}) => Promise<{status: number, text: string}>} httpPost
 *   HTTP POST with an 8s AbortController timeout applied by index.mjs.
 * @property {{ info(msg: string): void, warn(msg: string): void }} logger
 *   Cordis-scoped logger.
 * @property {() => number} now Monotonic-ish epoch ms clock for dedupe.
 */

const WEBHOOK_SECTION_KEYS = Object.freeze(["bark", "ntfy", "serverchan", "webhook"]);

// Config section key → webhook preset kind. Only the generic preset is named
// differently from its section (`webhook`).
const WEBHOOK_KIND_BY_SECTION = Object.freeze({
  bark: "bark",
  ntfy: "ntfy",
  serverchan: "serverchan",
  webhook: "generic",
});

const DESKTOP_FACTORY_BY_KIND = Object.freeze({
  macos: createMacosChannel,
  windows: createWindowsChannel,
});

/**
 * Map an OS platform to its desktop channel module id.
 *
 * @param {string} [platform=process.platform]
 * @returns {"macos"|"windows"|""} Empty when the platform has no native
 *   desktop support (Linux etc.).
 */
export function resolveDesktopKind(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "";
}

/**
 * Normalize the tri-state `desktop.enabled` setting. config.mjs already
 * resolves this to `"auto" | "on" | "off"`, but booleans are tolerated here
 * so the registry also works with raw user input.
 *
 * @param {boolean|string|undefined} value
 * @returns {"auto"|"on"|"off"}
 */
function desktopMode(value) {
  if (value === true || value === "on") return "on";
  if (value === false || value === "off") return "off";
  return "auto";
}

/**
 * Instantiate one channel, converting construction failures into a warn plus
 * skip so a single misconfigured channel (e.g. bark without a deviceKey)
 * cannot take down the others.
 *
 * @param {{ name: string, send(payload: object): Promise<void> }[]} channels
 * @param {string} key Config section / channel name, for log messages.
 * @param {() => { name: string, send(payload: object): Promise<void> }} create
 * @param {Deps["logger"]} logger
 */
function safelyAddChannel(channels, key, create, logger) {
  try {
    channels.push(create());
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    logger.warn(`[task-notify] channel '${key}' failed to initialize, skipped: ${cause}`);
  }
}

/**
 * Build the list of active channels from resolved plugin config. Expects the
 * normalized shape produced by config.mjs: top-level sections `desktop`,
 * `bark`, `ntfy`, `serverchan`, `webhook`, each carrying an `enabled` flag.
 *
 * @param {object} [config] Full resolved plugin config.
 * @param {Deps} deps Injected runtime dependencies.
 * @param {{ platform?: string }} [options] Platform override for tests;
 *   defaults to `process.platform`.
 * @returns {{ name: string, send(payload: object): Promise<void> }[]} Active
 *   channels; desktop first, then bark/ntfy/serverchan/webhook in that order.
 */
export function createChannels(config = {}, deps, options = {}) {
  const logger = deps?.logger;
  if (!logger || typeof logger.warn !== "function") {
    throw new TypeError("createChannels requires deps.logger.warn(msg)");
  }

  const platform = options.platform ?? process.platform;
  /** @type {{ name: string, send(payload: object): Promise<void> }[]} */
  const channels = [];

  // Desktop: auto probes the platform, off skips entirely, on forces an
  // attempt (which warns once when the platform has no native channel).
  // The shared icons section (SPEC §7.3) is merged into the factory config
  // so the Windows toast can resolve its per-event PNG; the macOS channel
  // ignores it (Notification Center has no custom notification image).
  const mode = desktopMode(config.desktop?.enabled);
  const desktopKind = resolveDesktopKind(platform);
  if (mode !== "off") {
    const factory = DESKTOP_FACTORY_BY_KIND[desktopKind];
    if (factory) {
      safelyAddChannel(
        channels,
        "desktop",
        () => factory({ ...(config.desktop ?? {}), icons: config.icons }, deps),
        logger,
      );
    } else if (mode === "on") {
      logger.warn(
        `[task-notify] desktop channel forced on but platform '${platform}' has no native support, skipped`,
      );
    }
  }

  // Mobile/webhook presets. Registry consumes resolved config where enabled
  // has been normalized to a strict boolean by config.mjs. The section key is
  // injected as the webhook preset kind so the channel never has to guess.
  for (const key of WEBHOOK_SECTION_KEYS) {
    const section = config[key];
    if (!section || section.enabled !== true) continue;
    safelyAddChannel(
      channels,
      key,
      () => createWebhookChannel({ ...section, kind: WEBHOOK_KIND_BY_SECTION[key] }, deps),
      logger,
    );
  }

  return channels;
}
