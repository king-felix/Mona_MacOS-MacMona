import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { readMachO } from "../packaging/macos/lib/macho.mjs";
import {
  packageFileName,
  renderComponentPlist,
  renderDistribution,
  renderOwnedPaths,
} from "../packaging/macos/lib/distribution.mjs";
import { buildHostPatterns, scanNames, scanText } from "../packaging/macos/lib/secrets.mjs";

function thinArm64(minOs = 0x000e0000): Buffer {
  const buffer = Buffer.alloc(32 + 24);
  buffer.writeUInt32BE(0xcffaedfe, 0); // MH_MAGIC_64, little-endian on disk
  buffer.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  buffer.writeUInt32LE(0, 8); // cpusubtype
  buffer.writeUInt32LE(2, 12); // filetype MH_EXECUTE
  buffer.writeUInt32LE(1, 16); // ncmds
  buffer.writeUInt32LE(24, 20); // sizeofcmds
  buffer.writeUInt32LE(0, 24); // flags
  buffer.writeUInt32LE(0, 28); // reserved
  buffer.writeUInt32LE(0x32, 32); // LC_BUILD_VERSION
  buffer.writeUInt32LE(24, 36); // cmdsize
  buffer.writeUInt32LE(1, 40); // PLATFORM_MACOS
  buffer.writeUInt32LE(minOs, 44);
  buffer.writeUInt32LE(0x000e0000, 48); // sdk
  buffer.writeUInt32LE(0, 52); // ntools
  return buffer;
}

describe("Mach-O architecture and minimum OS reading", () => {
  it("decodes a thin arm64 slice and its macOS floor", () => {
    const info = readMachO(thinArm64());
    expect(info).toMatchObject({
      kind: "mach-o",
      fat: false,
      architectures: ["arm64"],
      minOs: "14.0",
    });
  });

  it("decodes the arm64 slice of a fat binary", () => {
    const buffer = Buffer.alloc(4096 + 56);
    buffer.writeUInt32BE(0xcafebabe, 0);
    buffer.writeUInt32BE(1, 4); // nfat_arch
    buffer.writeUInt32BE(0x0100000c, 8); // cputype arm64
    buffer.writeUInt32BE(0, 12);
    buffer.writeUInt32BE(4096, 16); // offset
    buffer.writeUInt32BE(56, 20); // size
    buffer.writeUInt32BE(12, 24); // align
    thinArm64().copy(buffer, 4096);
    const info = readMachO(buffer);
    expect(info?.architectures).toEqual(["arm64"]);
    expect(info?.fat).toBe(true);
    expect(info?.minOs).toBe("14.0");
  });

  it("returns null for a non-Mach-O file", () => {
    expect(readMachO(Buffer.from("#!/bin/sh\necho hi\n", "utf8"))).toBeNull();
  });
});

describe("payload hygiene", () => {
  it("finds credential-shaped values and the actual build host", () => {
    const patterns = [...buildHostPatterns("/Users/tester", "/Users/tester/Mona")];
    const credentialHits = scanText([
      { path: "a.js", text: "const key = 'sk-" + "abcdefghijklmnop';" },
    ]);
    expect(credentialHits.map((hit) => hit.label)).toEqual(["provider-key"]);
    const hostHits = scanText(
      [{ path: "a.js", text: "const home = '/Users/tester/secrets';" }],
      patterns,
    );
    expect(hostHits.map((hit) => hit.label)).toContain("build-host-home");
    const fixtureHits = scanText(
      [{ path: "a.js", text: "const sample = '/Users/example/Projects/Atlas';" }],
      patterns,
    );
    expect(fixtureHits).toHaveLength(0);
  });

  it("flags developer state but not the bundled engine name", () => {
    const flagged = scanNames([
      "Applications/Mona.app/Contents/Resources/engine/codewhale",
      "Applications/Mona.app/Contents/Resources/app/.env",
      "Applications/Mona.app/Contents/Resources/app/.mona/state.json",
    ]);
    expect(flagged.map((entry) => entry.label)).toEqual(["dotenv", "build-ledger-directory"]);
  });
});

describe("installer metadata", () => {
  it("names local and release packages distinctly", () => {
    expect(packageFileName({ version: "1.2.3", channel: "local" })).toBe(
      "Mona-1.2.3-macOS-arm64-local.pkg",
    );
    expect(packageFileName({ version: "1.2.3", channel: "release" })).toBe(
      "Mona-1.2.3-macOS-arm64.pkg",
    );
  });

  it("enforces Apple Silicon and the macOS floor in the distribution", () => {
    const xml = renderDistribution({
      version: "1.2.3",
      channel: "local",
      componentFile: "component.pkg",
    });
    expect(xml).toContain('hostArchitectures="arm64"');
    expect(xml).toContain('<os-version min="14.0"/>');
    expect(xml).toContain("component.pkg");
    expect(xml).toContain("Local development build");
  });

  it("refuses Installer relocation of the app and service", () => {
    const plist = renderComponentPlist();
    expect(plist.match(/BundleIsRelocatable<\/key><false\/>/g)).toHaveLength(2);
    expect(plist).toContain("Applications/Mona.app");
    expect(plist).toContain("Library/Services/Mona.service");
  });

  it("records owned paths and the state it preserves", () => {
    const owned = JSON.parse(
      renderOwnedPaths({
        version: "1.2.3",
        channel: "local",
        packageFile: "Mona-1.2.3-macOS-arm64-local.pkg",
        components: [{ path: "engine/codewhale", sha256: "a".repeat(64) }],
      }),
    );
    expect(owned.owned.map((entry: { path: string }) => entry.path)).toEqual([
      "/Applications/Mona.app",
      "/Library/Services/Mona.service",
      "/Library/Application Support/Mona/install-receipt.json",
      "/Library/Application Support/Mona/owned-paths.json",
    ]);
    expect(owned.preserves.join(" ")).toContain("Application Support/Mona");
  });
});
