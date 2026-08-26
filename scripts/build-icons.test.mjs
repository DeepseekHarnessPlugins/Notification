// build-icons.test.mjs — dsh-task-notify v0.2 图标资产测试（SPEC §7.2）。
// 零外部依赖：node:test + node:assert/strict + node:zlib。
// 校验手写 PNG 编码的结构合法性（魔数/IHDR/长度/CRC）、SDF 光栅化的几何正确性
// （四角透明/中心着色）与输出确定性。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inflateSync } from "node:zlib";

import { ICONS, ICON_EVENTS, SIZE, buildIcon } from "./build-icons.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const RAW_LENGTH = SIZE * (1 + SIZE * 4); // 每行 1 filter byte + 64*4 RGBA

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** 表驱动重算 CRC32（独立于实现，交叉验证 chunk 完整性）。 */
function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 解析 PNG 全部 chunk：{type, data}[]，逐个校验 CRC。 */
function parseChunks(png) {
  const chunks = [];
  let off = 8; // 跳过签名
  while (off < png.length) {
    const length = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + length);
    const expectedCrc = png.readUInt32BE(off + 8 + length);
    assert.equal(crc32(png.subarray(off + 4, off + 8 + length)), expectedCrc, `CRC mismatch in ${type}`);
    chunks.push({ type, data });
    off += 12 + length;
  }
  return chunks;
}

function decodeIdat(png) {
  const chunks = parseChunks(png);
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  return { chunks, raw: inflateSync(idat) };
}

/** 读裸扫描线数据中 (x,y) 的 RGBA。 */
function pixelAt(raw, x, y) {
  const stride = 1 + SIZE * 4;
  const o = y * stride + 1 + x * 4;
  return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
}

describe("PNG 结构", () => {
  test("每个事件都有图标定义且恰好五个", () => {
    assert.deepEqual([...ICON_EVENTS].sort(), ["blocked", "error", "goal-completed", "idle", "notify"]);
  });

  for (const event of ICON_EVENTS) {
    test(`${event}: 魔数 / IHDR / IDAT 解压长度 / 全部 chunk CRC`, () => {
      const png = buildIcon(event);
      assert.ok(png.subarray(0, 4).equals(PNG_SIGNATURE), "PNG magic 89 50 4E 47");

      const { chunks, raw } = decodeIdat(png);
      assert.equal(chunks[0].type, "IHDR");
      assert.equal(chunks[chunks.length - 1].type, "IEND");
      assert.deepEqual(
        chunks.map((c) => c.type),
        ["IHDR", "IDAT", "IEND"],
      );

      const ihdr = chunks[0].data;
      assert.equal(ihdr.length, 13);
      assert.equal(ihdr.readUInt32BE(0), 64, "width = 64");
      assert.equal(ihdr.readUInt32BE(4), 64, "height = 64");
      assert.equal(ihdr[8], 8, "bit depth = 8");
      assert.equal(ihdr[9], 6, "color type 6 (RGBA)");
      assert.equal(ihdr[10], 0, "compression method 0");
      assert.equal(ihdr[11], 0, "filter method 0");
      assert.equal(ihdr[12], 0, "interlace none");

      assert.equal(raw.length, RAW_LENGTH, "解压后原始数据长度 = 64*(1+64*4)");

      // 每行首字节必须是 filter type 0（None）
      const stride = 1 + SIZE * 4;
      for (let y = 0; y < SIZE; y++) assert.equal(raw[y * stride], 0, `row ${y} filter byte`);
    });
  }
});

describe("光栅化几何", () => {
  for (const event of ICON_EVENTS) {
    test(`${event}: 四角透明`, () => {
      const { raw } = decodeIdat(buildIcon(event));
      for (const [x, y] of [[0, 0], [63, 63], [0, 63], [63, 0]]) {
        assert.equal(pixelAt(raw, x, y)[3], 0, `corner (${x},${y}) alpha = 0`);
      }
    });

    test(`${event}: 像素颜色符合锁定几何`, () => {
      const { raw } = decodeIdat(buildIcon(event));
      const [br, bg, bb] = hexToRgb(ICONS[event].color);
      const nearBase = ([r, g, b]) =>
        Math.abs(r - br) < 40 && Math.abs(g - bg) < 40 && Math.abs(b - bb) < 40;
      const nearWhite = ([r, g, b]) => r > 215 && g > 215 && b > 215;

      // 主色通用探针 (9,32)：距圆心 ~22.5，在底圆(r25)内、全部白色符号之外。
      const probe = pixelAt(raw, 9, 32);
      assert.equal(probe[3], 255);
      assert.ok(nearBase(probe), `(9,32) ${probe} 接近主色 ${ICONS[event].color}`);

      // 中心像素：idle/blocked 符号不过圆心 ⇒ 严格等于主色；
      // error/goal-completed/notify 是 SPEC §7.2 锁定几何把白色符号压在正中心
      // （对称叉交点 / 靶心实心点 / 回退圆点）⇒ 断言接近白色，同样能抓住
      // 通道错序、坐标翻转类缺陷。
      const center = pixelAt(raw, 32, 32);
      assert.equal(center[3], 255, "中心像素不透明");
      if (event === "idle" || event === "blocked") {
        assert.ok(nearBase(center), `center ${center} 接近主色 ${ICONS[event].color}`);
      } else {
        assert.ok(nearWhite(center), `center ${center} 接近白色符号`);
      }
    });
  }

  test("底圆半径 25 ⇒ 留边 ≥6px：边缘带外无着色", () => {
    const { raw } = decodeIdat(buildIcon("notify")); // 符号最小、最能暴露底圆越界
    for (let i = 0; i < SIZE; i++) {
      for (const [x, y] of [[i, 0], [i, 63], [0, i], [63, i]]) {
        assert.equal(pixelAt(raw, x, y)[3], 0, `edge (${x},${y}) 应全透明`);
      }
    }
  });
});

describe("确定性", () => {
  test("同一事件两次生成字节一致", () => {
    for (const event of ICON_EVENTS) {
      assert.ok(buildIcon(event).equals(buildIcon(event)), `${event} 两次生成 Buffer 相等`);
    }
  });

  test("未知事件回退到 notify 图标", () => {
    assert.ok(buildIcon("no-such-event").equals(buildIcon("notify")));
    assert.ok(buildIcon("").equals(buildIcon("notify")));
  });
});
