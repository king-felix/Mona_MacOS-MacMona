/**
 * Deterministic app icon. The mark is drawn from math (rounded square, gold M),
 * so the build does not depend on an opaque binary asset or a design tool.
 */
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZE = 1024;

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function insideRoundedSquare(x, y, radius) {
  const min = 0.0;
  const max = 1.0;
  if (x < min || x > max || y < min || y > max) return false;
  const cx = Math.min(Math.max(x, radius), max - radius);
  const cy = Math.min(Math.max(y, radius), max - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

const GLYPH = [
  [0.3, 0.7, 0.3, 0.32],
  [0.3, 0.32, 0.5, 0.55],
  [0.5, 0.55, 0.7, 0.32],
  [0.7, 0.32, 0.7, 0.7],
];

function sample(x, y) {
  const inside = insideRoundedSquare(x, y, 0.225);
  if (!inside) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, x * 0.35 + y * 0.65));
  const background = [
    Math.round(11 + (27 - 11) * t),
    Math.round(20 + (74 - 20) * t),
    Math.round(36 + (92 - 36) * t),
  ];
  let distance = Infinity;
  for (const [ax, ay, bx, by] of GLYPH) {
    distance = Math.min(distance, distanceToSegment(x, y, ax, ay, bx, by));
  }
  const glyph = distance <= 0.068;
  if (!glyph) return [...background, 255];
  // A soft vertical light on the gold keeps the mark from looking flat.
  const light = 1 - Math.min(1, Math.abs(x - 0.5) * 1.2) * 0.12;
  return [Math.round(232 * light), Math.round(179 * light), Math.round(75 * light), 255];
}

export function renderIcon(size = SIZE) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const sy of [0.25, 0.75]) {
        for (const sx of [0.25, 0.75]) {
          const [pr, pg, pb, pa] = sample((x + sx) / size, (y + sy) / size);
          r += pr;
          g += pg;
          b += pb;
          a += pa;
        }
      }
      const index = (y * size + x) * 4;
      rgba[index] = Math.round(r / 4);
      rgba[index + 1] = Math.round(g / 4);
      rgba[index + 2] = Math.round(b / 4);
      rgba[index + 3] = Math.round(a / 4);
    }
  }
  return encodePng(size, size, rgba);
}

export function renderInstallerBackground(width = 620, height = 420) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = y / height;
      const index = (y * width + x) * 4;
      rgba[index] = Math.round(11 + (20 - 11) * t);
      rgba[index + 1] = Math.round(20 + (56 - 20) * t);
      rgba[index + 2] = Math.round(36 + (72 - 36) * t);
      rgba[index + 3] = 255;
    }
  }
  // A small gold M in the lower right, clear of the installer's text column.
  const size = 96;
  const originX = width - size - 40;
  const originY = height - size - 32;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let distance = Infinity;
      for (const [ax, ay, bx, by] of GLYPH) {
        distance = Math.min(distance, distanceToSegment(u, v, ax, ay, bx, by));
      }
      if (distance > 0.075) continue;
      const index = ((originY + y) * width + (originX + x)) * 4;
      rgba[index] = 232;
      rgba[index + 1] = 179;
      rgba[index + 2] = 75;
    }
  }
  return encodePng(width, height, rgba);
}

export function buildIconSet(outputDir) {
  const iconset = join(outputDir, "Mona.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const base = join(outputDir, "icon-1024.png");
  writeFileSync(base, renderIcon(SIZE));
  const variants = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of variants) {
    const result = spawnSync(
      "/usr/bin/sips",
      ["-z", String(size), String(size), base, "--out", join(iconset, name)],
      {
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(`sips failed for ${name}: ${result.stderr}`);
  }
  const icns = join(outputDir, "Mona.icns");
  const result = spawnSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icns], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`iconutil failed: ${result.stderr}`);
  return icns;
}
