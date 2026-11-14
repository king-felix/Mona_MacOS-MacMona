import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ICO_SIZES,
  LOGO_PATH,
  buildIconSet,
  decodePng,
  encodeIco,
  encodePng,
  readLogo,
  renderIcon,
  renderInstallerBackground,
  resampleLogo,
} from "../packaging/macos/icon.mjs";

/**
 * The app icon is one committed asset resampled everywhere. These tests pin the
 * properties that make that safe: the master is what it claims to be, the
 * decoders refuse what they do not understand, the resample is alpha-weighted,
 * and both bundle formats come out of the same bytes.
 */
const scratch = mkdtempSync(join(tmpdir(), "mona-icon-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A tiny RGBA PNG built by our own encoder, for the codec tests. */
function pngOf(pixels: number[][]): Buffer {
  const rgba = Buffer.alloc(pixels.length * 4);
  pixels.forEach((pixel, index) => {
    for (let i = 0; i < 4; i += 1) rgba[index * 4 + i] = pixel[i] ?? 0;
  });
  return encodePng(1, pixels.length, rgba);
}

describe("the committed icon master", () => {
  it("is the owner's artwork, square, 8-bit RGBA and large enough for 1024", () => {
    const logo = readLogo();
    expect(logo.width).toBe(1254);
    expect(logo.height).toBe(1254);
    expect(logo.rgba.length).toBe(1254 * 1254 * 4);
    // A rounded-square mark on a transparent margin: transparent corners, and a
    // painted body. Asserting both is what distinguishes the logo from a blank
    // or a solid frame.
    expect(logo.rgba[3]).toBe(0);
    const painted = logo.rgba[(627 * logo.width + 627) * 4 + 3];
    expect(painted).toBeGreaterThan(240);
    expect(LOGO_PATH.endsWith("resources/MidnightMona.png")).toBe(true);
  });

  it("refuses a master that is not square or too small to be the source", () => {
    const small = join(scratch, "small.png");
    writeFileSync(small, encodePng(512, 512, Buffer.alloc(512 * 512 * 4, 255)));
    expect(() => readLogo(small)).toThrow(/at least 1024px/);
    const wide = join(scratch, "wide.png");
    writeFileSync(wide, encodePng(1254, 1024, Buffer.alloc(1254 * 1024 * 4, 255)));
    expect(() => readLogo(wide)).toThrow(/square/);
  });
});

describe("the PNG codec", () => {
  it("round-trips bytes through encode and decode", () => {
    const pixels = [
      [1, 2, 3, 255],
      [4, 5, 6, 128],
      [7, 8, 9, 0],
    ];
    const decoded = decodePng(pngOf(pixels));
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(3);
    expect([...decoded.rgba]).toEqual(pixels.flat());
  });

  it("refuses a file that is not a PNG at all", () => {
    expect(() => decodePng(Buffer.from("GIF89a not a png"))).toThrow(/bad signature/);
  });

  it("refuses a PNG in a format this build does not decode", () => {
    // Same signature and IHDR shape, but 16-bit and then interlaced: both must
    // fail rather than silently produce a wrong icon.
    const header = (bitDepth: number, interlace: number): Buffer => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(1, 0);
      ihdr.writeUInt32BE(1, 4);
      ihdr[8] = bitDepth;
      ihdr[9] = 6;
      ihdr[10] = 0;
      ihdr[11] = 0;
      ihdr[12] = interlace;
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(ihdr.length, 0);
      return Buffer.concat([signature, length, Buffer.from("IHDR"), ihdr, Buffer.alloc(4)]);
    };
    expect(() => decodePng(header(16, 0))).toThrow(/bit depth 16/);
    expect(() => decodePng(header(8, 1))).toThrow(/interlaced/);
  });
});

describe("resampling", () => {
  it("weights colour by alpha, so a transparent margin cannot darken an edge", () => {
    // Two source pixels averaging into one output pixel: opaque white and fully
    // transparent black. A plain average gives 50% grey; the premultiplied one
    // must give white at half alpha.
    const logo = {
      width: 2,
      height: 1,
      rgba: Buffer.from([255, 255, 255, 255, 0, 0, 0, 0]),
    };
    const out = resampleLogo(logo, 1);
    expect([...out]).toEqual([255, 255, 255, 128]);
  });

  it("produces one buffer of the requested size for every icon size", () => {
    const logo = readLogo();
    for (const size of [16, 32, 256]) {
      expect(resampleLogo(logo, size).length).toBe(size * size * 4);
    }
    expect(() => resampleLogo(logo, 0)).toThrow(/bad icon size/);
  });
});

describe("the ICO container", () => {
  it("writes a Vista-era directory of PNG entries with the requested sizes", () => {
    const images = [16, 256].map((size) => ({ size, png: renderIcon(size) }));
    const ico = encodeIco(images);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // icon, not cursor
    expect(ico.readUInt16LE(4)).toBe(2); // count

    const first = 6;
    const second = first + 16;
    // 256 is encoded as 0 in the directory, per the format.
    expect(ico[first]).toBe(16);
    expect(ico[second]).toBe(0);
    expect(ico.readUInt16LE(first + 6)).toBe(32); // 32 bits per pixel
    for (const [index, image] of images.entries()) {
      const entry = first + index * 16;
      const offset = ico.readUInt32LE(entry + 12);
      const length = ico.readUInt32LE(entry + 8);
      expect(length).toBe(image.png.length);
      expect([...ico.subarray(offset, offset + 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
    }
  });

  it("refuses an empty set and an out-of-range size", () => {
    expect(() => encodeIco([])).toThrow(/at least one image/);
    expect(() => encodeIco([{ size: 512, png: renderIcon(16) }])).toThrow(/out of range/);
  });
});

describe("the icon set the bundle ships", () => {
  it("writes an .icns and an .ico from the same master", () => {
    const dir = mkdtempSync(join(scratch, "set-"));
    const icnsPath = buildIconSet(dir);
    const icns = readFileSync(icnsPath);
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    // The container's length field covers the whole file.
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    // A 1024 (512@2x) element must exist, since the master is big enough.
    expect(icns.includes(Buffer.from("ic10"))).toBe(true);

    const ico = readFileSync(join(dir, "Mona.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(ICO_SIZES.length);

    const base = decodePng(readFileSync(join(dir, "icon-1024.png")));
    expect(base.width).toBe(1024);
    expect(base.height).toBe(1024);
  }, 60_000);
});

describe("the installer art", () => {
  it("uses the logo's own dark surface and carries the mark bottom-right", () => {
    const png = renderInstallerBackground(620, 420);
    const { width, height, rgba } = decodePng(png);
    expect([width, height]).toEqual([620, 420]);

    const pixel = (x: number, y: number): number[] => {
      const index = (y * width + x) * 4;
      return [...rgba.subarray(index, index + 4)];
    };
    // Dark enough for the installer's own text, as the previous art was.
    const top = pixel(8, 4);
    expect(top[3]).toBe(255);
    expect(0.2126 * top[0] + 0.7152 * top[1] + 0.0722 * top[2]).toBeLessThan(40);
    // The mark is painted into the lower-right quadrant: something there is
    // strongly chromatic (violet), which a plain gradient is not.
    const mark = pixel(width - 36 - 66, height - 26 - 66);
    expect(Math.max(...mark.slice(0, 3)) - Math.min(...mark.slice(0, 3))).toBeGreaterThan(80);
    // The left text column stays a gradient, not a mark.
    const textColumn = pixel(20, Math.round(height / 2));
    expect(Math.max(...textColumn.slice(0, 3)) - Math.min(...textColumn.slice(0, 3))).toBeLessThan(
      80,
    );
  }, 60_000);
});
