import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_MAX_BODY_LENGTH,
  EVENT_META,
  FALLBACK_ICON,
  composeBody,
  formatBody,
  formatDuration,
  formatTime,
  formatTitle,
  stripEmoji,
} from "./format.mjs";

describe("formatTitle", () => {
  test("maps every known lifecycle event to its emoji-free headline (SPEC §7.1, verbatim)", () => {
    assert.equal(formatTitle("idle"), "任务完成");
    assert.equal(formatTitle("error"), "任务出错");
    assert.equal(formatTitle("blocked"), "需要确认");
    assert.equal(formatTitle("goal-completed"), "目标达成");
  });

  test("falls back to the generic headline for unknown events", () => {
    assert.equal(formatTitle("status-we-have-never-seen"), "任务通知");
    assert.equal(formatTitle(undefined), "任务通知");
    assert.equal(formatTitle(""), "任务通知");
  });

  test("no canned title contains any emoji", () => {
    for (const event of ["idle", "error", "blocked", "goal-completed", "unknown"]) {
      const title = formatTitle(event);
      assert.equal(stripEmoji(title), title, `"${title}" 不应包含 emoji`);
    }
  });
});

describe("EVENT_META (SPEC §7.2/§7.4)", () => {
  test("carries title/color/icon per known event", () => {
    assert.deepEqual(EVENT_META.idle, { title: "任务完成", color: "#34C759", icon: "idle" });
    assert.deepEqual(EVENT_META.error, { title: "任务出错", color: "#FF3B30", icon: "error" });
    assert.deepEqual(EVENT_META.blocked, { title: "需要确认", color: "#FF9500", icon: "blocked" });
    assert.deepEqual(EVENT_META["goal-completed"], {
      title: "目标达成",
      color: "#007AFF",
      icon: "goal-completed",
    });
  });

  test("titles stay in sync with formatTitle and icons cover every asset base name", () => {
    for (const [event, meta] of Object.entries(EVENT_META)) {
      assert.equal(meta.title, formatTitle(event));
      // 资产基名集合：四个事件名 + notify 回退（Worker-A2 的 assets/icons 命名空间）。
      assert.ok(
        ["idle", "error", "blocked", "goal-completed"].includes(meta.icon),
        `unexpected icon base name: ${meta.icon}`,
      );
    }
    assert.equal(FALLBACK_ICON, "notify");
  });

  test("is deeply frozen", () => {
    assert.equal(Object.isFrozen(EVENT_META), true);
    assert.equal(Object.isFrozen(EVENT_META.idle), true);
  });
});

describe("formatBody", () => {
  test("collapses all whitespace runs into single spaces", () => {
    assert.equal(formatBody("修复  登录\n\n跳转\t\t失败"), "修复 登录 跳转 失败");
    assert.equal(formatBody("  leading and trailing  "), "leading and trailing");
    assert.equal(formatBody("a\r\nb"), "a b");
  });

  test("returns short bodies untouched apart from whitespace handling", () => {
    assert.equal(formatBody("short body", 120), "short body");
  });

  test("truncates to maxLen characters including the ellipsis", () => {
    assert.equal(formatBody("abcdef", 4), "abc…");
    assert.equal(formatBody("abcdef", 6), "abcdef");
    assert.equal(formatBody("abcdef", 5), "abcd…");
    // The ellipsis itself counts toward the cap.
    assert.equal(formatBody("abcdef", 4).length, 4);
  });

  test("never splits a surrogate pair when truncating emoji", () => {
    // 😀 is one code point / two UTF-16 code units.
    assert.equal(formatBody("😀😀😀", 2), "😀…");
  });

  test("degenerate limits fall back to the default cap", () => {
    const long = "a".repeat(DEFAULT_MAX_BODY_LENGTH + 80);
    assert.equal(formatBody("abcdef", 1), "…");
    assert.equal(formatBody(long, 0), `${"a".repeat(DEFAULT_MAX_BODY_LENGTH - 1)}…`);
    assert.equal(formatBody(long, Number.NaN), `${"a".repeat(DEFAULT_MAX_BODY_LENGTH - 1)}…`);
    // Short bodies stay intact when the invalid limit resolves to 120.
    assert.equal(formatBody("abcdef", 0), "abcdef");
  });

  test("is null/undefined safe and coerces non-strings defensively", () => {
    assert.equal(formatBody(null), "");
    assert.equal(formatBody(undefined), "");
    assert.equal(formatBody(12345), "12345");
  });
});

describe("stripEmoji", () => {
  test("strips emoji prefixes used in notification titles", () => {
    assert.equal(stripEmoji("✅ 任务完成"), "任务完成");
    assert.equal(stripEmoji("⏸ 需要确认"), "需要确认");
    assert.equal(stripEmoji("🎯 目标达成 🎉"), "目标达成");
  });

  test("handles flags, ZWJ sequences and variation selectors", () => {
    assert.equal(stripEmoji("🇨🇳 CN"), "CN");
    assert.equal(stripEmoji("family 👨‍👩‍👧 done"), "family done");
    assert.equal(stripEmoji("ℹ️ note"), "note");
  });

  test("keeps plain text symbols that are not emoji", () => {
    assert.equal(stripEmoji("a←b© 中文 ⌘C"), "a←b© 中文 ⌘C");
  });

  test("is null/undefined safe", () => {
    assert.equal(stripEmoji(null), "");
    assert.equal(stripEmoji(undefined), "");
    assert.equal(stripEmoji(""), "");
  });
});

describe("formatTime", () => {
  // 用本地 Date 分量构造期望值，任何时区下都确定。
  const d = new Date(2026, 7, 26, 14, 32, 5);
  const ts = d.getTime();

  test("short 样式渲染 HH:mm", () => {
    const expected = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    assert.equal(formatTime(ts, "short"), expected);
    assert.equal(formatTime(ts), expected); // 默认即 short
  });

  test("full 样式渲染 YYYY-MM-DD HH:mm:ss", () => {
    const p = (n) => String(n).padStart(2, "0");
    const expected = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    assert.equal(formatTime(ts, "full"), expected);
  });

  test("hidden 返回空串，非法输入返回空串", () => {
    assert.equal(formatTime(ts, "hidden"), "");
    assert.equal(formatTime(undefined), "");
    assert.equal(formatTime(Number.NaN), "");
    assert.equal(formatTime("not-a-number"), "");
    assert.equal(formatTime(new Date("invalid")), "");
  });

  test("接受 Date 对象与未知样式按 short 处理", () => {
    assert.equal(formatTime(d, "short"), formatTime(ts, "short"));
    assert.equal(formatTime(ts, "bogus-style"), formatTime(ts, "short"));
  });
});

describe("formatDuration", () => {
  test("秒/分/小时三段渲染", () => {
    assert.equal(formatDuration(42_000), "42秒");
    assert.equal(formatDuration(65_000), "1分05秒");
    assert.equal(formatDuration(120_000), "2分");
    assert.equal(formatDuration(3_720_000), "1小时02分");
    assert.equal(formatDuration(3_600_000), "1小时");
  });

  test("非法与非正值返回空串", () => {
    assert.equal(formatDuration(0), "");
    assert.equal(formatDuration(-5), "");
    assert.equal(formatDuration(undefined), "");
    assert.equal(formatDuration(Number.NaN), "");
  });
});

describe("composeBody", () => {
  const ts = new Date(2026, 7, 26, 14, 32).getTime();

  test("内容 + 短时间后缀", () => {
    assert.equal(composeBody("部署完成", { ts, timeStyle: "short" }), "部署完成 · 14:32");
  });

  test("hidden 关闭时间；空内容只剩时间", () => {
    assert.equal(composeBody("部署完成", { ts, timeStyle: "hidden" }), "部署完成");
    assert.equal(composeBody("", { ts }), "14:32");
    assert.equal(composeBody(null, { ts, timeStyle: "hidden" }), "");
  });

  test("showDuration 时追加用时后缀", () => {
    assert.equal(
      composeBody("完成", { ts, durationMs: 65_000 }),
      "完成 · 14:32 · 用时 1分05秒",
    );
    assert.equal(
      composeBody("完成", { ts, durationMs: 65_000, showDuration: false }),
      "完成 · 14:32",
    );
  });

  test("maxLen 只截断内容部分，时间后缀永远完整", () => {
    const out = composeBody("这是一段会被截断的很长正文内容", { ts, maxLen: 5 });
    assert.ok(out.startsWith("这是一段… · "));
    assert.ok(out.endsWith("14:32"));
  });
});
