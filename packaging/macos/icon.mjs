/**
 * The app icon, derived from one committed asset.
 *
 * `resources/MidnightMona.png` is the source of truth: a 1254×1254 RGBA master
 * supplied by the owner. Every icon this build ships is a resample of those
 * exact bytes, so About, Finder, the Dock, the installer art, and the in-app
 * mark cannot drift from one another:
 *
 *   - `Mona.icns`  the macOS bundle icon (all ten iconset sizes, via iconutil)
 *   - `Mona.ico`   the same mark as a Windows icon container, shipped so the
 *                  asset exists in both formats even though macOS never reads it
 *   - `background.png`  the installer art: a gradient taken from the logo's own
 *                  darkest painted pixel, with the logo composited bottom-right
 *
 * Nothing is drawn from a private glyph table any more. The previous version
 * synthesised a rounded square and a gold M mathematically; that mark is gone,
 * replaced by the owner's artwork.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The committed master. One asset, every rendered size. */
export const LOGO_PATH = join(HERE, "resources", "MidnightMona.png");

/** Smallest master this build accepts: the largest iconset entry is 1024. */
const MIN_MASTER = 1024;

/** ICO entries, smallest first. 256 is the largest size the container allows. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// ------------------------------------------------------------------ PNG codec

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode an 8-bit, non-interlaced RGBA PNG. Deliberately narrow: the only file
 * this build decodes is the committed master, and a surprise format must fail
 * the build rather than produce a silently wrong icon.
 */
export function decodePng(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 8 ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new Error("not a PNG: bad signature");
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error(`PNG chunk ${type} is truncated`);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");
  if (header.bitDepth !== 8) throw new Error(`PNG bit depth ${header.bitDepth} is unsupported`);
  if (header.colorType !== 6) throw new Error(`PNG colour type ${header.colorType} is unsupported`);
  if (header.interlace !== 0) throw new Error("interlaced PNG is unsupported");
  if (header.compression !== 0 || header.filter !== 0) throw new Error("PNG uses an unknown codec");
  if (idat.length === 0) throw new Error("PNG has no image data");

  const { width, height } = header;
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is short");
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = y * stride;
    const up = out - stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 4 ? rgba[out + i - 4] : 0;
      const above = y > 0 ? rgba[up + i] : 0;
      const upperLeft = y > 0 && i >= 4 ? rgba[up + i - 4] : 0;
      let value = line[i];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += above;
          break;
        case 3:
          value += (left + above) >> 1;
          break;
        case 4:
          value += paeth(left, above, upperLeft);
          break;
        default:
          throw new Error(`PNG scanline ${y} uses unknown filter ${filter}`);
      }
      rgba[out + i] = value & 0xff;
    }
  }
  return { width, height, rgba };
}

/** Read and validate the committed master. Throws rather than improvising one. */
export function readLogo(source = LOGO_PATH) {
  const logo = decodePng(readFileSync(source));
  if (logo.width !== logo.height) {
    throw new Error(`icon master must be square (${logo.width}×${logo.height})`);
  }
  if (logo.width < MIN_MASTER) {
    throw new Error(`icon master must be at least ${MIN_MASTER}px, not ${logo.width}px`);
  }
  return logo;
}

/**
 * Area-average downscale, weighted by alpha.
 *
 * Colour is averaged in premultiplied form and divided back by the averaged
 * alpha, so the transparent margin around the rounded square cannot darken the
 * edge pixels — the fringe a straight average produces.
 */
export function resampleLogo(logo, size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`bad icon size ${size}`);
  const { width, height, rgba } = logo;
  const out = Buffer.alloc(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((y + 1) * scaleY)));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((x + 1) * scaleX)));
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * width + sx) * 4;
          const a = rgba[index + 3] / 255;
          sumA += a;
          sumR += rgba[index] * a;
          sumG += rgba[index + 1] * a;
          sumB += rgba[index + 2] * a;
          count += 1;
        }
      }
      const index = (y * size + x) * 4;
      const alpha = count > 0 ? sumA / count : 0;
      if (alpha > 0) {
        out[index] = Math.min(255, Math.round(sumR / sumA));
        out[index + 1] = Math.min(255, Math.round(sumG / sumA));
        out[index + 2] = Math.min(255, Math.round(sumB / sumA));
      }
      out[index + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/** One size of the icon as PNG bytes. Every consumer of "the logo" uses this. */
export function renderIcon(size, logo = readLogo()) {
  return encodePng(size, size, resampleLogo(logo, size));
}

// ------------------------------------------------------------------- ICO codec

/**
 * Vista-era ICO: a directory of PNG payloads. Windows 7+ reads PNG entries
 * directly, and it keeps this writer free of a second bitmap encoder.
 */
export function encodeIco(images) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("ICO needs at least one image");
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    if (size < 1 || size > 256) throw new Error(`ICO size ${size} is out of range`);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("ICO payload is not a PNG");
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // 0 means 256
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

// --------------------------------------------------------------- installer art

/**
 * Installer background: 620×420, no scaling, anchored bottom-left by the
 * distribution. The gradient starts at the logo's darkest painted colour and is
 * lifted toward the bottom, so the art reads as one surface rather than a flat
 * fill; the mark sits bottom-right, clear of the readme text column.
 */
function darkestOpaque(logo) {
  // The artwork's margin is fully transparent, so the corner pixel is not a
  // colour. Walk a coarse grid and keep the darkest pixel that is actually
  // painted; that is the surface the icon sits on.
  let best = null;
  let bestLuma = Infinity;
  const step = Math.max(1, Math.round(logo.width / 40));
  for (let y = 0; y < logo.height; y += step) {
    for (let x = 0; x < logo.width; x += step) {
      const index = (y * logo.width + x) * 4;
      if (logo.rgba[index + 3] < 250) continue;
      const r = logo.rgba[index];
      const g = logo.rgba[index + 1];
      const b = logo.rgba[index + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma < bestLuma) {
        bestLuma = luma;
        best = [r, g, b];
      }
    }
  }
  if (!best) throw new Error("the icon master has no opaque pixel to take a colour from");
  return best;
}

export function renderInstallerBackground(width = 620, height = 420, logo = readLogo()) {
  const base = darkestOpaque(logo);
  const top = base.map((value) => Math.round(value * 0.92));
  const bottom = [
    Math.min(255, Math.round(base[0] * 1.45 + 6)),
    Math.min(255, Math.round(base[1] * 1.25 + 4)),
    Math.min(255, Math.round(base[2] * 1.7 + 10)),
  ];
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const t = y / Math.max(1, height - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = 255;
    }
  }

  const size = 132;
  const originX = width - size - 36;
  const originY = height - size - 26;
  const mark = resampleLogo(logo, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const source = (y * size + x) * 4;
      const alpha = mark[source + 3] / 255;
      if (alpha === 0) continue;
      const target = ((originY + y) * width + (originX + x)) * 4;
      if (target < 0 || target >= rgba.length) continue;
      rgba[target] = Math.round(mark[source] * alpha + rgba[target] * (1 - alpha));
      rgba[target + 1] = Math.round(mark[source + 1] * alpha + rgba[target + 1] * (1 - alpha));
      rgba[target + 2] = Math.round(mark[source + 2] * alpha + rgba[target + 2] * (1 - alpha));
    }
  }
  return encodePng(width, height, rgba);
}

// --------------------------------------------------------------------- bundles

const ICONSET_VARIANTS = [
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

/**
 * Build the platform icon set from the committed master.
 *
 * Returns the `.icns` path, which is what the packager and the bundle need. The
 * `.ico` is written beside it and, by the caller, shipped in Resources: macOS
 * never reads it, but the mark exists in the format the owner asked for.
 */
export function buildIconSet(outputDir, options = {}) {
  const logo = options.logo ?? readLogo(options.source);
  const iconset = join(outputDir, "Mona.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const base = join(outputDir, "icon-1024.png");
  writeFileSync(base, renderIcon(1024, logo));
  for (const [size, name] of ICONSET_VARIANTS) {
    const result = spawnSync(
      "/usr/bin/sips",
      ["-z", String(size), String(size), base, "--out", join(iconset, name)],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`sips failed for ${name}: ${result.stderr}`);
  }
  const icns = join(outputDir, "Mona.icns");
  const result = spawnSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icns], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`iconutil failed: ${result.stderr}`);
  writeFileSync(
    join(outputDir, "Mona.ico"),
    encodeIco(ICO_SIZES.map((size) => ({ size, png: renderIcon(size, logo) }))),
  );
  return icns;
}

// ------------------------------------------------------------------------ CLI

/**
 * `node packaging/macos/icon.mjs --mark <path>` writes the renderer's brand mark
 * from the same master, so the in-app logo cannot drift from the bundle icon.
 * It is the only command; everything else is driven by the packaging build.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--mark");
  if (at === -1 || !process.argv[at + 1]) {
    process.stderr.write("usage: node packaging/macos/icon.mjs --mark <output.png>\n");
    process.exitCode = 2;
  } else {
    const target = resolve(process.argv[at + 1]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderIcon(128));
    process.stdout.write(`wrote ${target} from ${LOGO_PATH}\n`);
  }
}
