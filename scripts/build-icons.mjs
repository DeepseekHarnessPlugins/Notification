#!/usr/bin/env node
// build-icons.mjs — dsh-task-notify v0.2 图标光栅化器（SPEC §7.2）。
//
// 零依赖纯 Node ESM：把 assets/icons/<event>.svg 中手写的几何常量以同一套数学描述
// 程序化重绘为 64x64 RGBA PNG（不解析 SVG）。几何常量见下方 ICONS，与各 SVG 注释
// 一一对应；任何一侧改动几何都必须同步另一侧。
//
// 光栅化：逐像素对每个形状做 SDF（有向距离场），coverage = clamp(0.5 - dist, 0, 1)
// 得到亚像素抗锯齿覆盖度，再按 over 算子把「白色符号」合成到「彩色底圆」上。
// PNG 编码手写：color type 6（RGBA）、bit depth 8、逐行 filter byte 0、
// IDAT 用 node:zlib deflateSync 默认参数（固定级别/窗口 ⇒ 输出字节确定）、
// CRC32 表驱动实现，chunk 结构 IHDR/IDAT/IEND 严格按 PNG 规范。
// 所有浮点运算只用 + - * 与 Math.sqrt（IEEE 正确舍入），不用 Math.hypot，
// 保证同 Node 版本下两次运行输出字节一致。

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 画布边长（px）。 */
export const SIZE = 64;
/** 底圆几何：圆心固定在画布中心。 */
export const CENTER_X = 32;
export const CENTER_Y = 32;
/** 底圆半径：留边 64/2 - 25 = 7px ≥ SPEC 要求的 6px。 */
export const BASE_RADIUS = 25;

const WHITE = [255, 255, 255];

function hexToRgb(hex) {
  const m = /^#[0-9a-fA-F]{6}$/.exec(hex);
  if (!m) throw new Error(`invalid hex color: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// ---------------------------------------------------------------------------
// SDF 基元（负值在形状内部）
// ---------------------------------------------------------------------------

/** 实心圆 SDF。 */
function sdCircle(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/** 点到线段距离（线段 SDF 的骨架距离，外扩 hw 即得圆头描边 SDF）。 */
function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let h = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = px - (ax + abx * h);
  const dy = py - (ay + aby * h);
  return Math.sqrt(dx * dx + dy * dy);
}

/** 圆角矩形 SDF（rx=半宽时退化为胶囊/全圆端条形）。 */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 计算一个图标「符号层」的联合 SDF：对各基元求距离再取 min（并集）。
 * 圆头 stroke-linecap/stroke-linejoin 由「骨架距离 - 半线宽」自然形成。
 */
function symbolDistance(parts, px, py) {
  let d = Infinity;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    let pd;
    switch (p.type) {
      case "seg": // 对应 SVG <line>/<path> + stroke-linecap="round"
        pd = sdSegment(px, py, p.ax, p.ay, p.bx, p.by) - p.hw;
        break;
      case "circle": // 对应 SVG <circle fill="#FFFFFF">
        pd = sdCircle(px, py, p.cx, p.cy, p.r);
        break;
      case "ring": // 对应 SVG <circle fill="none" stroke="#FFFFFF" stroke-width="2*hw">
        pd = Math.abs(sdCircle(px, py, p.cx, p.cy, p.r)) - p.hw;
        break;
      case "capsule": // 对应 SVG <rect rx="3">（rx=半宽 ⇒ 全圆端竖条）
        pd = sdRoundRect(px, py, p.cx, p.cy, p.hw, p.hh, p.r);
        break;
      default:
        throw new Error(`unknown symbol part type: ${p.type}`);
    }
    if (pd < d) d = pd;
  }
  return d;
}

// ---------------------------------------------------------------------------
// 图标清单 —— 几何常量与 assets/icons/<event>.svg 逐字对应
// ---------------------------------------------------------------------------

export const ICONS = {
  idle: {
    event: "idle",
    color: "#34C759",
    svgHint: 'circle(32,32,r25) + path M20 33 L28.5 41.5 L44 26, stroke 6 round',
    parts: [
      { type: "seg", ax: 20, ay: 33, bx: 28.5, by: 41.5, hw: 3 },
      { type: "seg", ax: 28.5, ay: 41.5, bx: 44, by: 26, hw: 3 },
    ],
  },
  error: {
    event: "error",
    color: "#FF3B30",
    svgHint: 'circle(32,32,r25) + line(22.5,22.5<->41.5,41.5) x2, stroke 6 round',
    parts: [
      { type: "seg", ax: 22.5, ay: 22.5, bx: 41.5, by: 41.5, hw: 3 },
      { type: "seg", ax: 41.5, ay: 22.5, bx: 22.5, by: 41.5, hw: 3 },
    ],
  },
  blocked: {
    event: "blocked",
    color: "#FF9500",
    svgHint: 'circle(32,32,r25) + rect(24,21,6,22,rx3) + rect(34,21,6,22,rx3)',
    parts: [
      { type: "capsule", cx: 27, cy: 32, hw: 3, hh: 11, r: 3 },
      { type: "capsule", cx: 37, cy: 32, hw: 3, hh: 11, r: 3 },
    ],
  },
  "goal-completed": {
    event: "goal-completed",
    color: "#007AFF",
    svgHint: 'circle(32,32,r25) + circle(r13,stroke5.5,none-fill) + circle(r5.25,fill)',
    parts: [
      { type: "ring", cx: 32, cy: 32, r: 13, hw: 2.75 },
      { type: "circle", cx: 32, cy: 32, r: 5.25 },
    ],
  },
  notify: {
    event: "notify",
    color: "#8E8E93",
    svgHint: "circle(32,32,r25) + circle(r8,fill)",
    parts: [{ type: "circle", cx: 32, cy: 32, r: 8 }],
  },
};

for (const icon of Object.values(ICONS)) {
  icon.rgb = hexToRgb(icon.color);
  Object.freeze(icon);
  Object.freeze(icon.rgb);
}

export const ICON_EVENTS = Object.freeze(Object.keys(ICONS));

// ---------------------------------------------------------------------------
// 光栅化：SDF 覆盖度 + straight-alpha over 合成
// ---------------------------------------------------------------------------

function coverage(dist) {
  return Math.min(1, Math.max(0, 0.5 - dist));
}

/** 渲染单个图标的裸 RGBA 像素（无 filter 字节），长度 SIZE*SIZE*4。 */
function renderRGBA(icon) {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    const sy = y + 0.5; // 像素中心采样
    for (let x = 0; x < SIZE; x++) {
      const sx = x + 0.5;
      // 底圆
      let aF = 0, rF = 0, gF = 0, bF = 0;
      const cBase = coverage(sdCircle(sx, sy, CENTER_X, CENTER_Y, BASE_RADIUS));
      if (cBase > 0) {
        rF = icon.rgb[0] * cBase;
        gF = icon.rgb[1] * cBase;
        bF = icon.rgb[2] * cBase;
        aF = cBase;
      }
      // 白色符号 over 底圆（straight alpha 的 over 算子）
      const dSym = symbolDistance(icon.parts, sx, sy);
      if (dSym < 0.5) {
        const cs = coverage(dSym);
        const inv = 1 - cs;
        const aOut = cs + aF * inv;
        if (aOut > 0) {
          rF = (WHITE[0] * cs + rF * inv) / aOut;
          gF = (WHITE[1] * cs + gF * inv) / aOut;
          bF = (WHITE[2] * cs + bF * inv) / aOut;
          aF = aOut;
        }
      }
      px[o++] = Math.round(rF);
      px[o++] = Math.round(gF);
      px[o++] = Math.round(bF);
      px[o++] = Math.round(aF * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// 手写 PNG 编码（color type 6 / bit depth 8 / filter 0 / IHDR+IDAT+IEND）
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装单个 PNG chunk：length(BE) + type(ASCII) + data + crc32(type+data)(BE)。 */
function pngChunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 把裸 RGBA 像素打包成完整 PNG Buffer（每行前置 filter byte 0）。 */
function encodePNG(rgba) {
  const stride = 1 + SIZE * 4;
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0; // filter type: None
    rgba.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); // width
  ihdr.writeUInt32BE(SIZE, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)), // zlib 默认参数固定 ⇒ 输出确定
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 公共 API + CLI 入口
// ---------------------------------------------------------------------------

/**
 * 生成某个事件的 64x64 PNG。
 * @param {string} event idle|error|blocked|goal-completed|notify（未知事件回退 notify）
 * @returns {Buffer}
 */
export function buildIcon(event) {
  const icon = Object.prototype.hasOwnProperty.call(ICONS, event) ? ICONS[event] : ICONS.notify;
  return encodePNG(renderRGBA(icon));
}

const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icons");
  mkdirSync(outDir, { recursive: true });
  for (const event of ICON_EVENTS) {
    const file = join(outDir, `${event}.png`);
    const buf = buildIcon(event);
    writeFileSync(file, buf);
    console.log(`wrote ${file} (${buf.length} bytes)`);
  }
  console.log(`done: ${ICON_EVENTS.length} icons -> ${outDir}`);
}
