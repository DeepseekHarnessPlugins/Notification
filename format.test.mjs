import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_MAX_BODY_LENGTH,
  EVENT_META,
  FALLBACK_ICON,
  formatBody,
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
