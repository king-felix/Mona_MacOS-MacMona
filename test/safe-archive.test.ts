import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeEntryPath,
  extractArchive,
  readArchive,
  safeJoin,
  writeArchive,
} from "../src/main/state/safe-archive";
import { tempDir } from "./helpers/state";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = (CRC_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Build a zip with an arbitrary entry name, bypassing the writer's validation.
 * This is how a hostile bundle is modelled: the reader must defend itself, not
 * rely on having produced the file.
 */
function hostileZip(
  name: string,
  data: Buffer,
  options: { mode?: number; method?: number; badCrc?: boolean; encrypted?: boolean } = {},
): Buffer {
  const method = options.method ?? 0;
  const checksum = options.badCrc ? 0x12345678 : crc(data);
  const nameBuffer = Buffer.from(name, "utf8");
  const flags = options.encrypted ? 0x0001 : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(((options.mode ?? 0o100644) << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const localBlock = Buffer.concat([local, nameBuffer, data]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuffer.length, 12);
  end.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, central, nameBuffer, end]);
}

describe("safe archive", () => {
  it("writes byte-identical archives regardless of input order", () => {
    const left = writeArchive([
      { path: "b.txt", data: Buffer.from("two") },
      { path: "a/one.txt", data: Buffer.from("one") },
    ]);
    const right = writeArchive([
      { path: "a/one.txt", data: Buffer.from("one") },
      { path: "b.txt", data: Buffer.from("two") },
    ]);
    expect(left.equals(right)).toBe(true);
    expect(createHash("sha256").update(left).digest("hex")).toBe(
      createHash("sha256").update(right).digest("hex"),
    );
  });

  it("roundtrips entries with digests and no executable mode", () => {
    const archive = writeArchive([
      { path: "manifest.json", data: Buffer.from('{"a":1}') },
      { path: "evidence/run.txt", data: Buffer.from("green") },
    ]);
    const parsed = readArchive(archive);
    expect(parsed.safe).toBe(true);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((entry) => entry.path)).toEqual([
      "evidence/run.txt",
      "manifest.json",
    ]);
    for (const entry of parsed.entries) {
      expect(entry.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.mode & 0o111).toBe(0);
    }
  });

  it("refuses unsafe names when writing", () => {
    for (const path of ["../escape.txt", "/etc/passwd", "a\\b.txt", "a//b.txt", "./x", "a/../b"]) {
      expect(() => writeArchive([{ path, data: Buffer.from("x") }])).toThrow();
    }
    expect(() => writeArchive([{ path: "ü-ok.txt", data: Buffer.from("x") }])).not.toThrow();
  });

  it("refuses a duplicate entry name when writing", () => {
    expect(() =>
      writeArchive([
        { path: "a.txt", data: Buffer.from("1") },
        { path: "a.txt", data: Buffer.from("2") },
      ]),
    ).toThrow(/duplicate/);
  });

  it("drops traversal, absolute, backslash, symlink, encrypted, and corrupt entries", () => {
    const cases: Array<[Buffer, string]> = [
      [hostileZip("../../evil.txt", Buffer.from("pwn")), "PATH_ESCAPE"],
      [hostileZip("/etc/passwd", Buffer.from("pwn")), "ABSOLUTE_PATH"],
      [hostileZip("a\\b.txt", Buffer.from("pwn")), "BACKSLASH"],
      [hostileZip("link", Buffer.from("/etc/passwd"), { mode: 0o120777 }), "SYMLINK"],
      [hostileZip("secret.txt", Buffer.from("x"), { encrypted: true }), "ENCRYPTED"],
      [hostileZip("bad.txt", Buffer.from("x"), { badCrc: true }), "CHECKSUM_MISMATCH"],
    ];
    for (const [archive, code] of cases) {
      const parsed = readArchive(archive);
      expect(parsed.safe).toBe(false);
      expect(parsed.entries).toEqual([]);
      expect(parsed.problems.map((problem) => problem.code)).toContain(code);
    }
  });

  it("refuses a truncated archive and an oversized entry", () => {
    const good = writeArchive([{ path: "a.txt", data: Buffer.from("hello") }]);
    const truncated = good.subarray(0, good.length - 10);
    expect(readArchive(truncated).safe).toBe(false);
    expect(readArchive(good, { maxEntryBytes: 2 }).problems[0]?.code).toBe("ENTRY_TOO_LARGE");
  });

  it("never extracts outside the root and never overwrites", () => {
    const root = join(tempDir("mona-extract-"), "root");
    const outside = join(root, "..", "outside.txt");
    const archive = Buffer.concat([writeArchive([{ path: "safe.txt", data: Buffer.from("ok") }])]);
    // A hostile archive is modelled directly: the reader must drop the entry, and
    // extraction must still not write it anywhere.
    const hostile = hostileZip("../outside.txt", Buffer.from("pwn"));
    const result = extractArchive(hostile, root);
    expect(result.written).toEqual([]);
    expect(existsSync(outside)).toBe(false);

    writeFileSync(join(root, "..", "keep.txt"), "existing");
    const ok = extractArchive(archive, root);
    expect(ok.written).toEqual(["safe.txt"]);
    expect(readFileSync(join(root, "safe.txt"), "utf8")).toBe("ok");

    const again = extractArchive(archive, root);
    expect(again.written).toEqual([]);
    expect(again.skipped[0]?.reason).toMatch(/never overwrites/);
  });

  it("keeps safeJoin inside the root and rejects escapes", () => {
    const root = "/tmp/mona-archive-root";
    expect(safeJoin(root, "a/b.txt")).toBe(`${root}/a/b.txt`);
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "a/./b"]) {
      expect(() => safeJoin(root, bad)).toThrow();
    }
    expect(() => assertSafeEntryPath("a/\u0000b")).toThrow();
  });

  it("reports no problems for a nested archive and a stable content digest", () => {
    const entries = [
      { path: "a/one.txt", data: Buffer.from("one") },
      { path: "z.txt", data: Buffer.from("z") },
    ];
    const first = readArchive(writeArchive(entries));
    const second = readArchive(writeArchive([...entries].reverse()));
    expect(first.digest).toBe(second.digest);
    expect(first.safe).toBe(true);
  });
});
