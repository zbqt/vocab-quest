// 生成 PWA 图标（零依赖：手写 PNG 编码 + 简单 SDF 光栅化）
// 用法: node tools/gen-icon.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "icons");

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------- 形状 ---------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

function roundedRectSDF(x, y, w, h, r) {
  const cx = Math.abs(x - w / 2) - (w / 2 - r);
  const cy = Math.abs(y - h / 2) - (h / 2 - r);
  const dx = Math.max(cx, 0), dy = Math.max(cy, 0);
  return Math.hypot(dx, dy) + Math.min(Math.max(cx, cy), 0) - r;
}
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 512; // 以 512 为设计网格
  const radius = 118 * s;
  const strokeW = 26 * s; // 半宽
  // V 的两笔
  const segs = [
    [132 * s, 176 * s, 256 * s, 356 * s],
    [380 * s, 176 * s, 256 * s, 356 * s]
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dRect = roundedRectSDF(px, py, size, size, radius);
      const inside = clamp01(0.5 - dRect); // 1px 抗锯齿
      if (inside <= 0) continue;

      // 渐变背景 #6c7bff -> #5b6cff
      const t = py / size;
      let r = mix(0x6c, 0x5b, t), g = mix(0x7b, 0x6c, t), b = mix(0xff, 0xff, t);

      // 白色 V
      let d = Infinity;
      for (const [ax, ay, bx, by] of segs) d = Math.min(d, segDist(px, py, ax, ay, bx, by));
      const alpha = clamp01(strokeW + 0.5 - d);
      if (alpha > 0) { r = mix(r, 255, alpha); g = mix(g, 255, alpha); b = mix(b, 255, alpha); }

      const i = (y * size + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(inside * 255);
    }
  }
  return encodePNG(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [512, 192, 180, 64, 32]) {
  const name = size === 180 ? "apple-touch-icon-180.png" : `icon-${size}.png`;
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log(`${name}  ${size}x${size}`);
}
