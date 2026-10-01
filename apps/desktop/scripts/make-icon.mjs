#!/usr/bin/env node
/**
 * Draws the app icon, `build/icon.png` (1024×1024), from shapes — no design tool, no image
 * dependency. electron-builder turns it into the macOS .icns and the Windows .ico at package
 * time. The mark is a schedule card (a calendar with the unit's teal header band) carrying a
 * medical cross. Re-run after changing a colour or a proportion: `node scripts/make-icon.mjs`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const SAMPLES = 4; // per axis: 16 samples a pixel, for smooth edges

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

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colourAt(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const o = (py * SIZE + px) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
      }
      rgba[o + 3] = Math.round((255 * a) / SAMPLES ** 2);
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

function png(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png(render()));
console.log(`wrote ${out}`);
