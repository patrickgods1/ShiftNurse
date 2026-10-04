#!/usr/bin/env node
/**
 * Draws the app icon from shapes — no design tool, no image dependency — and writes the three
 * files packaging uses: `build/icon.png` (1024×1024, Linux and the window), `build/icon.icns`
 * (macOS) and `build/icon.ico` (Windows). Each size is drawn at that size rather than scaled
 * down, so the 16-pixel taskbar icon is as sharp as the 1024 one. They are committed, so every
 * build machine packages the same icon instead of converting the PNG its own way. The mark is a
 * schedule card (a calendar with the unit's teal header band) carrying a medical cross. Re-run
 * after changing a colour or a proportion: `node scripts/make-icon.mjs`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/** The shapes below are laid out on a 1024-unit square; every size is drawn from them. */
const DESIGN = 1024;

const TEAL = [31, 111, 139]; // --color-accent, light theme
const TEAL_DARK = [21, 82, 104];
const WHITE = [255, 255, 255];
const CARD_BAND = [31, 111, 139];
// Teal, not red: a red cross on white is the protected Red Cross emblem.
const CROSS = [38, 140, 170];

function inRoundRect(x, y, left, top, right, bottom, r) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Paint order, bottom first: the colour of the topmost shape under (x, y), or undefined. */
function colourAt(x, y) {
  let colour;
  // macOS-style rounded square with a soft vertical gradient.
  if (inRoundRect(x, y, 64, 64, 960, 960, 200)) {
    const t = (y - 64) / 896;
    colour = TEAL.map((c, i) => Math.round(c + (TEAL_DARK[i] - c) * t));
  }
  // The schedule card.
  if (inRoundRect(x, y, 232, 262, 792, 822, 64)) colour = WHITE;
  if (inRoundRect(x, y, 232, 262, 792, 422, 64) && y <= 400) colour = CARD_BAND;
  // Binder rings.
  for (const rx of [372, 652]) {
    if (inRoundRect(x, y, rx - 26, 202, rx + 26, 322, 26)) colour = WHITE;
  }
  // The cross.
  const inBar = (l, t, r, b) => inRoundRect(x, y, l, t, r, b, 22);
  if (inBar(452, 470, 572, 750) || inBar(372, 550, 652, 670)) colour = CROSS;
  return colour;
}

function render(size) {
  // Samples per pixel axis: 4 (16 a pixel) at full size, more as pixels cover more of the design,
  // so a 16-pixel icon's edges are averaged as finely as a 1024 one's.
  const samples = Math.min(16, Math.max(4, Math.round((4 * DESIGN) / size / 16)));
  const unit = DESIGN / size;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const c = colourAt(
            (px + (sx + 0.5) / samples) * unit,
            (py + (sy + 0.5) / samples) * unit,
          );
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
      }
      rgba[o + 3] = Math.round((255 * a) / samples ** 2);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const rgba = render(size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Windows .ico: a directory of PNG images (Vista and later read PNG entries). A width or height
 * of 256 is written as 0, as the format requires.
 */
function ico(sizes) {
  const images = sizes.map((size) => png(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

/**
 * macOS .icns, laid out as Apple's `iconutil` lays it out. The 16- and 32-pixel images are ARGB
 * (`ic04`, `ic05`: "ARGB" then each channel run-length encoded) — macOS misreads PNG in the older
 * small types, and a PNG there showed as noise. Every other size is PNG; the @2x types (ic11–ic14)
 * hold the retina image for the size below them.
 */
const ICNS_PNG_TYPES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];

/** The icns run-length code: runs of 3–130 equal bytes, literals of 1–128 bytes. */
function icnsRle(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let run = 1;
    while (i + run < bytes.length && run < 130 && bytes[i + run] === bytes[i]) run++;
    if (run >= 3) {
      out.push(run + 125, bytes[i]);
      i += run;
      continue;
    }
    const start = i;
    while (i < bytes.length && i - start < 128) {
      if (i + 2 < bytes.length && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2]) break;
      i++;
    }
    out.push(i - start - 1, ...bytes.subarray(start, i));
  }
  return Buffer.from(out);
}

function argb(size) {
  const rgba = render(size);
  const channel = (offset) => {
    const c = Buffer.alloc(size * size);
    for (let p = 0; p < size * size; p++) c[p] = rgba[p * 4 + offset];
    return icnsRle(c);
  };
  // Alpha first, then red, green, blue, each its own run of codes.
  return Buffer.concat([
    Buffer.from('ARGB', 'ascii'),
    channel(3),
    channel(0),
    channel(1),
    channel(2),
  ]);
}

function icnsElement(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(8 + data.length, 4);
  return Buffer.concat([head, data]);
}

function icns() {
  const cache = new Map();
  const pngOf = (size) => {
    if (!cache.has(size)) cache.set(size, png(size));
    return cache.get(size);
  };
  const body = Buffer.concat([
    icnsElement('ic04', argb(16)),
    icnsElement('ic05', argb(32)),
    ...ICNS_PNG_TYPES.map(([type, size]) => icnsElement(type, pngOf(size))),
  ]);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(dir, { recursive: true });
const files = {
  'icon.png': png(DESIGN),
  'icon.icns': icns(),
  'icon.ico': ico([16, 24, 32, 48, 64, 128, 256]),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(dir, name), data);
  console.log(`wrote ${join(dir, name)} (${data.length} bytes)`);
}
