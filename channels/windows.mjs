import { formatTitle } from "../format.mjs";
import { resolveIconPath } from "../paths.mjs";

/**
 * AUMID of Windows PowerShell. Reusing an already-registered AppUserModelID
 * lets toasts show without the script installing its own shortcut/start
 * menu entry first.
 */
const POWERSHELL_AUMID = "Microsoft.Windows.PowerShell";

// ToastText02: line 1 bold (title), line 2 wrapped (body).
const SCRIPT_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$appId = '<AUMID>'",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$textNodes = @($xml.GetElementsByTagName('text'))",
  "$textNodes[0].AppendChild($xml.CreateTextNode('<TITLE>')) > $null",
  "$textNodes[1].AppendChild($xml.CreateTextNode('<BODY>')) > $null",
  "<AUDIO>",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
  // Keep the process alive briefly so the toast platform picks the toast up
  // before PowerShell exits. (Start-Sleep, not New-Object Thread.Sleep —
  // Thread.Sleep(2000) is a static method call, not a constructible type.)
  "Start-Sleep -Milliseconds 2500",
].join("\n");

/**
 * Build the <audio> element lines for the toast XML. The template may ship
 * its own audio node, so remove that first — two audio elements would make
 * the toast XML invalid.
 *
 * @param {boolean} sound True plays the default notification sound, false
 *   marks the toast silent.
 * @returns {string} PowerShell statements ending at `$toastRoot`.
 */
function buildAudioLines(sound) {
  return [
    "$toastRoot = $xml.SelectSingleNode('/toast')",
    "$staleAudio = $toastRoot.SelectSingleNode('audio')",
    "if ($null -ne $staleAudio) { $toastRoot.RemoveChild($staleAudio) > $null }",
    "$audio = $xml.CreateElement('audio')",
    sound
      ? "$audio.SetAttribute('src', 'ms-winsoundevent:Notification.Default')"
      : "$audio.SetAttribute('silent', 'true')",
    "$toastRoot.AppendChild($audio) > $null",
  ].join("\n");
}

/**
 * Escape an arbitrary string for embedding inside a PowerShell single quoted
 * literal: single quotes are doubled (`'` → `''`), nothing else needs care.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Escape an arbitrary string for embedding inside an XML attribute value
 * delimited by double quotes: `& < > "` must become entity references or the
 * toast XML parser rejects the document. (The value flows through
 * `SetAttribute`, which stores it verbatim — the escaping here is what makes
 * the final attribute well-formed.)
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeXmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the `<image placement="appLogoOverride" src="file:///…"/>` element
 * lines (SPEC §7.4). The element is created programmatically — same style as
 * {@link buildAudioLines} — so the emitted PowerShell carries the escaped
 * attribute value, and the resulting toast XML contains exactly
 * `<image placement="appLogoOverride" src="…"/>` under the toast root.
 *
 * Escaping order matters: XML-escape first (`&` → `&amp;`, …), then apply
 * PowerShell single-quote doubling to the already-escaped text, because the
 * PS literal content is what ends up inside SetAttribute.
 *
 * Relies on `$toastRoot` / `$xml` having been established by the audio lines,
 * which always run before this one.
 *
 * @param {string} iconPath Absolute filesystem path of a PNG icon.
 * @returns {string} PowerShell statements appending the image element.
 */
function buildImageLines(iconPath) {
  // file:/// URL form of an absolute path: backslashes become forward
  // slashes; POSIX-style absolute paths keep their leading slash so the
  // result is the canonical three-slash `file:///…`.
  const normalized = String(iconPath).trim().replace(/\\/g, "/");
  const src = normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
  return [
    "$image = $xml.CreateElement('image')",
    "$image.SetAttribute('placement', 'appLogoOverride')",
    `$image.SetAttribute('src', '${escapePowerShellString(escapeXmlAttribute(src))}')`,
    "$toastRoot.AppendChild($image) > $null",
  ].join("\n");
}

/**
 * Build the PowerShell script that raises one WinRT toast. Pure string
 * building, exported for unit tests.
 *
 * @param {string} title Bold first line of the toast.
 * @param {string} body Wrapped second line of the toast.
 * @param {{ sound?: boolean, iconPath?: string|null }} [options] When false
 *   the toast XML gets a silent `<audio>` element; when true it plays the
 *   default system notification sound. `iconPath` (absolute PNG path) adds
 *   an `appLogoOverride` image element to the toast; empty/null omits it.
 * @returns {string} Complete script, ready for
 *   `powershell.exe -NoProfile -NonInteractive -Command <script>`.
 * @since 0.2 supports iconPath (SPEC §7.4).
 */
export function buildToastScript(title, body, { sound = true, iconPath = null } = {}) {
  // Audio lines always run (they establish $toastRoot); image lines append
  // after them when an icon resolved.
  const runtimeLines = [buildAudioLines(sound)];
  if (iconPath) runtimeLines.push(buildImageLines(iconPath));
  return SCRIPT_TEMPLATE.replace("<AUMID>", escapePowerShellString(POWERSHELL_AUMID))
    .replace("<TITLE>", escapePowerShellString(title))
    .replace("<BODY>", escapePowerShellString(body))
    .replace("<AUDIO>", runtimeLines.join("\n"));
}

/**
 * Windows Toast channel, backed by `powershell.exe` + WinRT
 * ToastNotificationManager.
 *
 * Icon wiring (SPEC §7.4): when `config.icons.enabled !== false`, the
 * per-event PNG under `assets/icons/` is resolved (falling back to
 * `notify.png`, then to no image) and embedded as an `appLogoOverride`
 * image in the toast. The desktop factory receives the shared `icons`
 * section merged into its config by channels/index.mjs.
 *
 * @param {{ enabled?: boolean, sound?: boolean, icons?: { enabled?: boolean } }} config
 *   Resolved desktop section of the plugin config, plus the icons section.
 * @param {import("./index.mjs").Deps} deps Injected runtime dependencies.
 * @returns {{ name: string, send(payload: object): Promise<void> }}
 * @throws {TypeError} When required deps are missing — the registry catches
 *   this and skips the channel instead of taking the plugin down.
 */
export function createChannel(config = {}, deps) {
  const run = deps?.run;
  const logger = deps?.logger;
  if (typeof run !== "function") {
    throw new TypeError("windows channel requires deps.run(file, args, opts?)");
  }
  if (!logger || typeof logger.warn !== "function") {
    throw new TypeError("windows channel requires deps.logger.warn(msg)");
  }

  /**
   * Deliver one payload as a Windows toast. Success is silent; failures
   * (powershell.exe missing, script error, Focus Assist) are warned and
   * swallowed — notifications must never break the host session.
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

    // SPEC §7.4：icons.enabled !== false 时按 event 解析本地 PNG（缺失回退
    // notify.png，仍缺失则不嵌图）。resolveIconPath 已做存在性检查，绝不抛错。
    let iconPath = null;
    if (config.icons?.enabled !== false) {
      iconPath = resolveIconPath(typeof payload.event === "string" ? payload.event : "");
    }

    const script = buildToastScript(title, body, {
      sound: config.sound !== false,
      iconPath,
    });
    try {
      await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
    } catch (error) {
      logger.warn(`[task-notify] Windows toast failed: ${describeError(error)}`);
    }
  }

  return { name: "desktop", send };
}

/** @param {unknown} error @returns {string} Best-effort human-readable cause. */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
