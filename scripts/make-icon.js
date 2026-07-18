'use strict';
/* Generates assets/icon.png (256x256) and a PNG-wrapped assets/icon.ico
   with no external dependencies — just zlib. A soft gradient rounded square
   with a simple cricket/leaf mark. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const buf = Buffer.alloc(S * S * 4);

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255;
  buf[i] = Math.round(buf[i] * (1 - na) + r * na);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - na) + g * na);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - na) + b * na);
  buf[i + 3] = Math.max(buf[i + 3], a);
}

// Rounded-square background with a vertical blue->purple gradient.
const radius = 52;
function inRounded(x, y) {
  const rx = Math.min(x, S - 1 - x);
  const ry = Math.min(y, S - 1 - y);
  if (rx >= radius || ry >= radius) return true;
  const dx = radius - rx, dy = radius - ry;
  return dx * dx + dy * dy <= radius * radius;
}
for (let y = 0; y < S; y++) {
  const t = y / S;
  const r = Math.round(78 + (124 - 78) * t);
  const g = Math.round(161 + (92 - 161) * t);
  const b = Math.round(255 + (255 - 255) * t);
  for (let x = 0; x < S; x++) {
    if (inRounded(x, y)) set(x, y, r, g, b, 255);
  }
}

// A simple leaf/wing mark (two overlapping ellipses) in translucent white.
function ellipse(cx, cy, rx, ry, rot, col, alpha) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - cx, dy = y - cy;
    const u = (dx * cos + dy * sin) / rx;
    const v = (-dx * sin + dy * cos) / ry;
    if (u * u + v * v <= 1) set(x, y, col[0], col[1], col[2], alpha);
  }
}
ellipse(112, 132, 70, 34, -0.6, [255, 255, 255], 220);
ellipse(150, 150, 58, 26, -0.35, [255, 255, 255], 150);
// little body dot
ellipse(96, 108, 12, 12, 0, [26, 32, 45], 235);

// ---- encode PNG ----
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'icon.png'), png);

// ICO wrapping the PNG (Windows accepts PNG-encoded icon entries).
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico.writeUInt8(0, 6); ico.writeUInt8(0, 7); // 0 => 256
ico.writeUInt8(0, 8); ico.writeUInt8(0, 9);
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(6 + 16, 18);
fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([ico, png]));

console.log('Wrote assets/icon.png and assets/icon.ico (' + png.length + ' bytes PNG)');
