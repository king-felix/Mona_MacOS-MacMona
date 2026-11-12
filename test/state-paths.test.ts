import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLocalDataLocation,
  resolveProductPaths,
  verifyPrivatePermissions,
} from "../src/main/state/paths";
import { tempDir } from "./helpers/state";

describe("per-user storage paths", () => {
  it("derives private Application Support paths for each user", () => {
    const homeA = tempDir("mona-home-a-");
    const homeB = tempDir("mona-home-b-");
    const a = resolveProductPaths({ home: homeA });
    const b = resolveProductPaths({ home: homeB });

    expect(a.support).toBe(join(homeA, "Library", "Application Support", "Mona"));
    expect(a.database.startsWith(a.support)).toBe(true);
    expect(a.backups.startsWith(a.support)).toBe(true);
    expect(a.cache).toBe(join(homeA, "Library", "Caches", "Mona"));
    expect(a.logs).toBe(join(homeA, "Library", "Logs", "Mona"));
    expect(a.database).not.toBe(b.database);
    expect(b.database.startsWith(homeB)).toBe(true);
    expect(a.database.includes("Mobile Documents")).toBe(false);

    expect(verifyPrivatePermissions(a)).toEqual([]);
    expect(verifyPrivatePermissions(b)).toEqual([]);
  });

  it("reports a widened directory or database mode instead of assuming privacy", () => {
    const home = tempDir("mona-home-mode-");
    const paths = resolveProductPaths({ home });
    chmodSync(paths.support, 0o755);
    writeFileSync(paths.database, "db");
    chmodSync(paths.database, 0o644);
    const problems = verifyPrivatePermissions(paths);
    expect(problems.map((problem) => problem.path)).toContain(paths.support);
    expect(problems.map((problem) => problem.path)).toContain(paths.database);
  });

  it("refuses cloud-synced folders and app-bundle paths", () => {
    expect(() =>
      assertLocalDataLocation("/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Mona"),
    ).toThrow(/cloud-synced/);
    expect(() => assertLocalDataLocation("/Users/example/Dropbox/Mona")).toThrow(/cloud-synced/);
    expect(() =>
      assertLocalDataLocation("/Applications/Mona.app/Contents/Resources/state"),
    ).toThrow(/app bundle/);
    const home = tempDir("mona-home-network-");
    expect(() => resolveProductPaths({ home, filesystemType: () => "smbfs" })).toThrow(
      /network filesystem/,
    );
    expect(() => resolveProductPaths({ home, filesystemType: () => "apfs" })).not.toThrow();
  });

  it("uses Electron's userData directory when supplied", () => {
    const home = tempDir("mona-home-electron-");
    const support = join(home, "custom-support");
    mkdirSync(support, { recursive: true });
    const paths = resolveProductPaths({ home, supportDir: support });
    expect(paths.support).toBe(support);
    expect(paths.database).toBe(join(support, "state", "mona.sqlite"));
  });
});
