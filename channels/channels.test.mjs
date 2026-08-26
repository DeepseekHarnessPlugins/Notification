import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildNotificationScript, createChannel as createMacosChannel } from "./macos.mjs";
import { buildToastScript, createChannel as createWindowsChannel } from "./windows.mjs";
import {
  attachIconSvg,
  buildBarkRequest,
  buildGenericRequest,
  buildNtfyRequest,
  buildServerChanRequest,
  createChannel as createWebhookChannel,
} from "./webhook.mjs";
import { createChannels, resolveDesktopKind } from "./index.mjs";
import { resolveIconPath } from "../paths.mjs";

/**
 * Fully fake Deps: every outbound interaction is recorded on `deps.calls`
 * instead of reaching the network, the OS, or a clock.
 */
function makeDeps(overrides = {}) {
  const calls = { run: [], httpPost: [], info: [], warn: [] };
  const deps = {
    run: async (...args) => {
      calls.run.push(args);
      return { stdout: "", stderr: "" };
    },
    httpPost: async (url, init) => {
      calls.httpPost.push({ url, init });
      return { status: 200, text: "{}" };
    },
    logger: {
      info: (msg) => calls.info.push(msg),
      warn: (msg) => calls.warn.push(msg),
    },
    now: () => 1_750_000_000_000,
    calls,
  };
  return Object.assign(deps, overrides);
}

// SPEC §7.1：v0.2 起标题无 emoji，字符串逐字锁定。
const PAYLOAD = Object.freeze({
  event: "idle",
  title: "任务完成",
  body: "修复登录跳转",
  sessionId: "s-1",
  ts: 1_750_000_000_000,
});

describe("macos channel", () => {
  test("runs osascript with title and body embedded in the -e script", async () => {
    const deps = makeDeps();
    const channel = createMacosChannel({ enabled: true, sound: false }, deps);
    assert.equal(channel.name, "desktop");

    await channel.send(PAYLOAD);

    assert.equal(deps.calls.run.length, 1);
    const [file, args] = deps.calls.run[0];
    assert.equal(file, "osascript");
    assert.deepEqual(args.slice(0, 1), ["-e"]);
    assert.equal(args[1], 'display notification "修复登录跳转" with title "任务完成"');
    // macOS 不接图标（SPEC §7.4）：脚本中不出现任何图标相关内容。
    assert.doesNotMatch(args[1], /image|icon/i);
    assert.equal(deps.calls.warn.length, 0);
  });

  test("sound config appends the Glass sound clause", async () => {
    const deps = makeDeps();
    const channel = createMacosChannel({ enabled: true, sound: true }, deps);

    await channel.send(PAYLOAD);

    assert.equal(
      deps.calls.run[0][1][1],
      'display notification "修复登录跳转" with title "任务完成" sound name "Glass"',
    );
  });

  test("escapes backslashes before double quotes in AppleScript strings", () => {
    assert.equal(
      buildNotificationScript('He said "hi"', "back\\slash"),
      'display notification "back\\\\slash" with title "He said \\"hi\\""',
    );
    // A trailing backslash must not escape the closing quote.
    assert.equal(
      buildNotificationScript("t\\", "b\\"),
      'display notification "b\\\\" with title "t\\\\"',
    );
  });

  test("falls back to formatTitle when payload has no title", async () => {
    const deps = makeDeps();
    const channel = createMacosChannel({ enabled: true }, deps);

    await channel.send({ event: "error" });

    assert.match(deps.calls.run[0][1][1], /with title "任务出错"/);
  });

  test("warns and resolves when osascript fails — never throws", async () => {
    const deps = makeDeps({
      run: async () => {
        throw new Error("spawn osascript ENOENT");
      },
    });
    const channel = createMacosChannel({ enabled: true }, deps);

    await assert.doesNotReject(channel.send(PAYLOAD));
    assert.equal(deps.calls.warn.length, 1);
    assert.match(deps.calls.warn[0], /macOS notification failed.*ENOENT/s);
  });

  test("disabled channels never invoke run", async () => {
    const deps = makeDeps();
    const channel = createMacosChannel({ enabled: false }, deps);

    await channel.send(PAYLOAD);

    assert.equal(deps.calls.run.length, 0);
  });

  test("missing deps throw at construction so the registry can skip", () => {
    assert.throws(() => createMacosChannel({}, {}), TypeError);
  });
});

describe("windows channel", () => {
  test("buildToastScript embeds title/body with WinRT toast plumbing", () => {
    const script = buildToastScript("标题", "正文");
    assert.match(script, /\[Windows\.UI\.Notifications\.ToastNotificationManager,/);
    assert.match(script, /ToastTemplateType\]::ToastText02/);
    assert.match(script, /CreateToastNotifier\(\$appId\)\.Show\(\$toast\)/);
    assert.match(script, /'Microsoft\.Windows\.PowerShell'/);
    assert.match(script, /CreateTextNode\('标题'\)/);
    assert.match(script, /CreateTextNode\('正文'\)/);
    // Placeholder markers must all have been substituted.
    assert.doesNotMatch(script, /<(TITLE|BODY|AUMID|AUDIO)>/);
    // Keeps PowerShell alive briefly so the toast is picked up.
    assert.match(script, /Start-Sleep -Milliseconds 2500/);
  });

  test("buildToastScript doubles single quotes inside literals", () => {
    const script = buildToastScript("it's", "a'b\"c");
    assert.match(script, /CreateTextNode\('it''s'\)/);
    assert.match(script, /CreateTextNode\('a''b"c'\)/);
  });

  test("sound=false marks the audio element silent, default plays a sound", () => {
    assert.match(buildToastScript("t", "b"), /ms-winsoundevent:Notification\.Default/);
    const silent = buildToastScript("t", "b", { sound: false });
    assert.match(silent, /SetAttribute\('silent', 'true'\)/);
    assert.doesNotMatch(silent, /ms-winsoundevent/);
  });

  test("iconPath adds an appLogoOverride image element with a file:/// src (SPEC §7.4)", () => {
    const script = buildToastScript("t", "b", { sound: false, iconPath: "C:\\icons\\idle.png" });
    // Toast XML ends up containing <image placement="appLogoOverride" src="…"/>：
    // 以编程式 CreateElement/SetAttribute 构建等价元素。
    assert.match(script, /CreateElement\('image'\)/);
    assert.match(script, /SetAttribute\('placement', 'appLogoOverride'\)/);
    assert.match(script, /SetAttribute\('src', 'file:\/\/\/C:\/icons\/idle\.png'\)/);
    assert.match(script, /AppendChild\(\$image\)/);
  });

  test("no iconPath → no image element at all", () => {
    for (const script of [
      buildToastScript("t", "b"),
      buildToastScript("t", "b", { iconPath: null }),
      buildToastScript("t", "b", { iconPath: "" }),
    ]) {
      assert.doesNotMatch(script, /appLogoOverride/);
      assert.doesNotMatch(script, /CreateElement\('image'\)/);
    }
  });

  test("iconPath is PowerShell-quote-doubled and XML-attribute escaped", () => {
    // 单引号 doubling（PS 字面量层）
    const quoted = buildToastScript("t", "b", { iconPath: "C:\\o'brien\\idle.png" });
    assert.match(quoted, /SetAttribute\('src', 'file:\/\/\/C:\/o''brien\/idle\.png'\)/);

    // & < > " 在 XML 属性值层转义为实体引用；转义发生在 doubling 之前
    const entities = buildToastScript("t", "b", { iconPath: "C:\\a&b<c>\"d\\i.png" });
    assert.match(entities, /a&amp;b&lt;c&gt;&quot;d/);
    assert.doesNotMatch(entities, /src', '[^']*a&b|<c>/);
  });

  test("POSIX-style absolute paths keep the canonical file:/// prefix", () => {
    const script = buildToastScript("t", "b", { iconPath: "/tmp/icons/idle.png" });
    assert.match(script, /SetAttribute\('src', 'file:\/\/\/tmp\/icons\/idle\.png'\)/);
  });

  test("runs powershell.exe -NoProfile -NonInteractive -Command <script>", async () => {
    const deps = makeDeps();
    const channel = createWindowsChannel(
      { enabled: true, sound: false, icons: { enabled: false } },
      deps,
    );
    assert.equal(channel.name, "desktop");

    await channel.send(PAYLOAD);

    assert.equal(deps.calls.run.length, 1);
    const [file, args] = deps.calls.run[0];
    assert.equal(file, "powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.match(args[3], /CreateTextNode\('任务完成'\)/);
    assert.match(args[3], /CreateTextNode\('修复登录跳转'\)/);
    assert.equal(deps.calls.warn.length, 0);
  });

  test("send with icons.enabled !== false embeds the resolved PNG when assets exist", async () => {
    const deps = makeDeps();
    const channel = createWindowsChannel(
      { enabled: true, sound: false, icons: { enabled: true } },
      deps,
    );

    await channel.send(PAYLOAD);

    const script = deps.calls.run[0][1][3];
    const resolved = resolveIconPath("idle"); // 与生产同一解析器（含 notify.png 回退）
    if (resolved === null) {
      // 资产缺失场景（Worker-A2 产出前）：不嵌图且绝不抛错。
      assert.doesNotMatch(script, /appLogoOverride/);
      assert.equal(deps.calls.warn.length, 0); // 缺图不是错误，静默降级
    } else {
      assert.match(script, /SetAttribute\('placement', 'appLogoOverride'\)/);
      assert.ok(script.includes(resolved.replace(/\\/g, "/")), `应包含解析路径 ${resolved}`);
      assert.match(script, /SetAttribute\('src', 'file:\/\/\//);
    }
  });

  test("registry forwards the shared icons section — disabled wins even when assets exist", async () => {
    const deps = makeDeps();
    const channels = createChannels(
      { desktop: { enabled: "auto" }, icons: { enabled: false } },
      deps,
      { platform: "win32" },
    );
    assert.equal(channels.length, 1);

    await channels[0].send(PAYLOAD);

    assert.doesNotMatch(deps.calls.run[0][1][3], /appLogoOverride/);
  });

  test("warns and resolves when powershell fails — never throws", async () => {
    const deps = makeDeps({
      run: async () => {
        throw new Error("powershell.exe not found");
      },
    });
    const channel = createWindowsChannel({ enabled: true }, deps);

    await assert.doesNotReject(channel.send(PAYLOAD));
    assert.equal(deps.calls.warn.length, 1);
    assert.match(deps.calls.warn[0], /Windows toast failed/);
  });

  test("disabled channels never invoke run", async () => {
    const deps = makeDeps();
    const channel = createWindowsChannel({ enabled: false }, deps);

    await channel.send(PAYLOAD);

    assert.equal(deps.calls.run.length, 0);
  });
});

describe("webhook presets", () => {
  describe("bark", () => {
    const cfg = { kind: "bark", enabled: true, deviceKey: "devkey123" };

    test("posts JSON to the default Bark server without a sound field", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel(cfg, deps);
      assert.equal(channel.name, "bark");

      await channel.send(PAYLOAD);

      assert.equal(deps.calls.httpPost.length, 1);
      const { url, init } = deps.calls.httpPost[0];
      assert.equal(url, "https://api.day.app/devkey123");
      assert.equal(init.headers["content-type"], "application/json");
      const parsed = JSON.parse(init.body);
      assert.deepEqual(parsed, { title: "任务完成", body: "修复登录跳转" });
      assert.equal(deps.calls.warn.length, 0);
    });

    test("honors custom servers (trailing slash stripped) and optional sound", () => {
      const request = buildBarkRequest(
        { deviceKey: "k9", server: "https://bark.example.com/", sound: "bell" },
        PAYLOAD,
      );
      assert.equal(request.url, "https://bark.example.com/k9");
      assert.equal(JSON.parse(request.body).sound, "bell");
    });

    test("non-empty payload.iconUrl is appended as an encoded icon query parameter (SPEC §7.4)", () => {
      const request = buildBarkRequest(
        { deviceKey: "k9" },
        { ...PAYLOAD, iconUrl: "https://host/icons/idle.svg?ver=2" },
      );
      // 查询参数拼接在 JSON body 通道的 URL 上，& = 等保留字符必须编码。
      assert.equal(
        request.url,
        `https://api.day.app/k9?icon=${encodeURIComponent("https://host/icons/idle.svg?ver=2")}`,
      );
      const parsed = JSON.parse(request.body);
      assert.equal(parsed.icon, undefined); // icon 只走 URL，不进 JSON body
      assert.deepEqual(new URL(request.url).searchParams.get("icon"), "https://host/icons/idle.svg?ver=2");
    });

    test("empty payload.iconUrl leaves the bark URL untouched", () => {
      assert.equal(buildBarkRequest({ deviceKey: "k9" }, PAYLOAD).url, "https://api.day.app/k9");
      assert.equal(buildBarkRequest({ deviceKey: "k9" }, { ...PAYLOAD, iconUrl: "" }).url, "https://api.day.app/k9");
    });

    test("missing deviceKey fails fast at creation", () => {
      assert.throws(() => createWebhookChannel({ kind: "bark", enabled: true }, makeDeps()), TypeError);
    });
  });

  describe("ntfy", () => {
    test("posts plain body with X-Title header to server/topic", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel({ kind: "ntfy", enabled: true, topic: "dsh-alerts" }, deps);
      assert.equal(channel.name, "ntfy");

      await channel.send(PAYLOAD);

      const { url, init } = deps.calls.httpPost[0];
      assert.equal(url, "https://ntfy.sh/dsh-alerts");
      assert.equal(init.headers["X-Title"], "任务完成");
      assert.equal(init.body, "修复登录跳转");
      assert.equal(init.headers.Authorization, undefined);
    });

    test("adds Bearer auth and honors custom servers when configured", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel(
        { kind: "ntfy", enabled: true, topic: "t1", server: "https://ntfy.example.com", token: "tk" },
        deps,
      );

      await channel.send(PAYLOAD);

      const { url, init } = deps.calls.httpPost[0];
      assert.equal(url, "https://ntfy.example.com/t1");
      assert.equal(init.headers.Authorization, "Bearer tk");
    });

    test("missing topic fails fast at creation", () => {
      assert.throws(() => createWebhookChannel({ kind: "ntfy", enabled: true }, makeDeps()), TypeError);
    });

    test("non-empty payload.iconUrl sets the X-Icon header (SPEC §7.4)", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel(
        { kind: "ntfy", enabled: true, topic: "dsh-alerts", token: "tk" },
        deps,
      );

      await channel.send({ ...PAYLOAD, iconUrl: "https://host/icons/error.svg" });

      const { init } = deps.calls.httpPost[0];
      assert.equal(init.headers["X-Icon"], "https://host/icons/error.svg");
      assert.equal(init.headers["X-Title"], "任务完成"); // 既有头不受影响
      assert.equal(init.headers.Authorization, "Bearer tk");

      // 纯构建器路径同样生效
      const request = buildNtfyRequest(
        { topic: "t" },
        { ...PAYLOAD, iconUrl: "https://h/i.png" },
      );
      assert.equal(request.headers["X-Icon"], "https://h/i.png");
    });

    test("empty payload.iconUrl omits the X-Icon header", () => {
      const request = buildNtfyRequest({ topic: "t" }, PAYLOAD);
      assert.equal(request.headers["X-Icon"], undefined);
    });
  });

  describe("serverchan", () => {
    test("form-posts title/desp to the fixed SCT endpoint", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel({ sendKey: "SCT123", enabled: true }, deps);
      assert.equal(channel.name, "serverchan");

      await channel.send(PAYLOAD);

      const { url, init } = deps.calls.httpPost[0];
      assert.equal(url, "https://sctapi.ftqq.com/SCT123.send");
      assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(init.body, `title=${encodeURIComponent("任务完成")}&desp=${encodeURIComponent("修复登录跳转")}`);
    });

    test("serverchan is not an icon channel: iconUrl never leaks into the form (SPEC §7.4)", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel({ sendKey: "SCT123", enabled: true }, deps);

      await channel.send({ ...PAYLOAD, iconUrl: "https://host/icons/idle.svg" });

      const form = new URLSearchParams(deps.calls.httpPost[0].init.body);
      assert.equal(form.get("icon"), null);
      assert.equal([...form.keys()].sort().join(","), "desp,title");
    });

    test("encodeURIComponent keeps reserved characters round-trippable", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel({ sendKey: "K", enabled: true }, deps);

      await channel.send({ ...PAYLOAD, title: "a&b=c d", body: "x+y=z&e" });

      const form = new URLSearchParams(deps.calls.httpPost[0].init.body);
      assert.equal(form.get("title"), "a&b=c d");
      assert.equal(form.get("desp"), "x+y=z&e");
    });

    test("missing sendKey fails fast at creation", () => {
      assert.throws(
        () => createWebhookChannel({ kind: "serverchan", enabled: true }, makeDeps()),
        TypeError,
      );
    });

    test("preset is inferred from the credential field when kind is absent", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel({ sendKey: "INFER" }, deps);
      assert.equal(channel.name, "serverchan");

      await channel.send(PAYLOAD);

      assert.equal(deps.calls.httpPost[0].url, "https://sctapi.ftqq.com/INFER.send");
    });
  });

  describe("generic", () => {
    test("posts the full payload as JSON with user headers merged", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel(
        { url: "https://hooks.example.com/dsh", headers: { Authorization: "Bearer z" } },
        deps,
      );
      assert.equal(channel.name, "webhook");

      await channel.send(PAYLOAD);

      const { url, init } = deps.calls.httpPost[0];
      assert.equal(url, "https://hooks.example.com/dsh");
      assert.equal(init.headers["content-type"], "application/json");
      assert.equal(init.headers.Authorization, "Bearer z");
      const parsed = JSON.parse(init.body);
      // iconSvg 按磁盘状态条件出现（SPEC §7.4）：资产存在时内联 SVG 文本，
      // 缺失时整个字段省略 —— 两种世界下本断言都成立。
      const { resolveIconSvgPath } = await import("../paths.mjs");
      const svgPath = resolveIconSvgPath("idle");
      assert.deepEqual(parsed, {
        event: "idle",
        title: "任务完成",
        body: "修复登录跳转",
        sessionId: "s-1",
        ts: PAYLOAD.ts,
        ...(svgPath !== null ? { iconSvg: readFileSync(svgPath, "utf8") } : {}),
      });
    });

    test("undefined optional fields are dropped from the JSON body", () => {
      const request = buildGenericRequest({ url: "https://h/x/" }, { event: "error", title: "t", body: "b", ts: 5 });
      const parsed = JSON.parse(request.body);
      assert.equal("sessionId" in parsed, false);
      assert.equal("icon" in parsed, false); // 空 iconUrl → 字段整个省略
      // User URLs are used verbatim — no trailing-slash rewriting.
      assert.equal(request.url, "https://h/x/");
    });

    test("non-empty payload.iconUrl lands in the JSON body as icon (SPEC §7.4)", () => {
      const request = buildGenericRequest(
        { url: "https://h/x" },
        { ...PAYLOAD, iconUrl: "https://host/icons/idle.svg" },
      );
      const parsed = JSON.parse(request.body);
      assert.equal(parsed.icon, "https://host/icons/idle.svg");
      // iconSvg 不在构建器里：它需要异步读文件，由 send() 经 attachIconSvg 附加。
      assert.equal("iconSvg" in parsed, false);
    });

    test("send inlines assets/icons/<event>.svg as iconSvg when the asset resolves", async () => {
      const deps = makeDeps();
      const channel = createWebhookChannel({ url: "https://hooks.example.com/dsh" }, deps);

      await channel.send({ ...PAYLOAD, iconUrl: "https://host/icons/idle.svg" });

      const parsed = JSON.parse(deps.calls.httpPost[0].init.body);
      assert.equal(parsed.icon, "https://host/icons/idle.svg");
      const { resolveIconSvgPath } = await import("../paths.mjs");
      if (resolveIconSvgPath("idle") === null) {
        // 资产缺失场景（Worker-A2 产出前）：字段省略且不抛错。
        assert.equal("iconSvg" in parsed, false);
        assert.equal(deps.calls.warn.length, 0);
      } else {
        assert.equal(typeof parsed.iconSvg, "string");
        assert.ok(parsed.iconSvg.length > 0);
        assert.match(parsed.iconSvg, /<svg/i); // 是 SVG 标记文本
      }
    });

    test("attachIconSvg degrades silently on missing assets / broken JSON body", async () => {
      const base = buildGenericRequest(
        { url: "https://h/x" },
        { event: "idle", title: "t", body: "b", ts: 1, iconUrl: "https://h/i.svg" },
      );

      // 1) 资产根目录不存在（用不存在的临时目录模拟 assets 缺失）：请求原样返回。
      const untouched = await attachIconSvg(base, "idle", join(tmpdir(), `dsh-nonexistent-${Date.now()}`));
      assert.equal(untouched, base);
      assert.equal(JSON.parse(untouched.body).iconSvg, undefined);

      // 2) body 不是合法 JSON（防御性边界）：同样原样返回、不抛错。
      const weird = { ...base, body: "not-json{" };
      assert.equal(await attachIconSvg(weird, "idle"), weird);
    });

    test("non-2xx responses warn with status code and response snippet, never throw", async () => {
      const deps = makeDeps({
        httpPost: async () => ({ status: 500, text: `${"x".repeat(300)}-tail` }),
      });
      const channel = createWebhookChannel({ url: "https://hooks.example.com/dsh" }, deps);

      await assert.doesNotReject(channel.send(PAYLOAD));

      assert.equal(deps.calls.warn.length, 1);
      assert.match(deps.calls.warn[0], /responded 500/);
      const snippet = deps.calls.warn[0].split(": ").pop();
      // Exactly the first 200 chars of the response body are logged.
      assert.equal(snippet.length, 200);
    });

    test("boundary statuses: 299 succeeds silently, 300 warns", async () => {
      const ok = makeDeps({ httpPost: async () => ({ status: 299, text: "" }) });
      await createWebhookChannel({ url: "https://h/x" }, ok).send(PAYLOAD);
      assert.equal(ok.calls.warn.length, 0);

      const redirect = makeDeps({ httpPost: async () => ({ status: 300, text: "moved" }) });
      await createWebhookChannel({ url: "https://h/x" }, redirect).send(PAYLOAD);
      assert.match(redirect.calls.warn[0], /responded 300: moved/);
    });

    test("transport errors are warned and swallowed", async () => {
      const deps = makeDeps({
        httpPost: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      });
      const channel = createWebhookChannel({ url: "https://hooks.example.com/dsh" }, deps);

      await assert.doesNotReject(channel.send(PAYLOAD));
      assert.match(deps.calls.warn[0], /request failed.*ENOTFOUND/s);
    });

    test("unknown kind and missing url fail fast at creation", () => {
      assert.throws(
        () => createWebhookChannel({ kind: "carrier-pigeon" }, makeDeps()),
        /unknown webhook kind/,
      );
      assert.throws(() => createWebhookChannel({ kind: "generic" }, makeDeps()), TypeError);
    });
  });
});

describe("channel registry", () => {
  test("resolveDesktopKind maps platforms", () => {
    assert.equal(resolveDesktopKind("darwin"), "macos");
    assert.equal(resolveDesktopKind("win32"), "windows");
    assert.equal(resolveDesktopKind("linux"), "");
    assert.equal(resolveDesktopKind("freebsd"), "");
  });

  test("auto desktop mode instantiates per platform, nothing on unsupported ones", () => {
    for (const [platform, expected] of [
      ["darwin", 1],
      ["win32", 1],
      ["linux", 0],
    ]) {
      const deps = makeDeps();
      const channels = createChannels({ desktop: { enabled: "auto" } }, deps, { platform });
      assert.equal(channels.length, expected, platform);
      if (expected > 0) assert.equal(channels[0].name, "desktop");
    }
  });

  test("desktop off skips even on darwin; forced-on on linux warns once", () => {
    const off = makeDeps();
    assert.equal(createChannels({ desktop: { enabled: false } }, off, { platform: "darwin" }).length, 0);

    const forced = makeDeps();
    const channels = createChannels({ desktop: { enabled: true } }, forced, { platform: "linux" });
    assert.equal(channels.length, 0);
    assert.equal(forced.calls.warn.length, 1);
    assert.match(forced.calls.warn[0], /no native support/);
  });

  test("instantiates each enabled webhook preset in order", () => {
    const deps = makeDeps();
    const channels = createChannels(
      {
        desktop: { enabled: "off" },
        bark: { enabled: true, deviceKey: "k" },
        ntfy: { enabled: false },
        serverchan: { enabled: true, sendKey: "s" },
        webhook: { enabled: true, url: "https://h/x" },
      },
      deps,
      { platform: "darwin" },
    );
    assert.deepEqual(channels.map((c) => c.name), ["bark", "serverchan", "webhook"]);
  });

  test("one broken channel only warns and is skipped, others survive", () => {
    const deps = makeDeps();
    const channels = createChannels(
      {
        bark: { enabled: true }, // missing deviceKey → constructor throws
        webhook: { enabled: true, url: "https://h/x" },
      },
      deps,
      { platform: "linux" },
    );
    assert.deepEqual(channels.map((c) => c.name), ["webhook"]);
    assert.equal(deps.calls.warn.length, 1);
    assert.match(deps.calls.warn[0], /channel 'bark'.*skipped/);
  });

  test("all returned channels share the deps and can actually send", async () => {
    const deps = makeDeps();
    const channels = createChannels(
      {
        desktop: { enabled: true },
        bark: { enabled: true, deviceKey: "k" },
      },
      deps,
      { platform: "darwin" },
    );
    assert.equal(channels.length, 2);

    await Promise.all(channels.map((c) => c.send(PAYLOAD)));

    // One osascript call + one HTTP POST.
    assert.equal(deps.calls.run.length, 1);
    assert.equal(deps.calls.httpPost.length, 1);
    assert.equal(deps.calls.warn.length, 0);
  });

  test("missing logger is rejected loudly at the boundary", () => {
    assert.throws(() => createChannels({}, { run: async () => ({}) }), TypeError);
  });
});
