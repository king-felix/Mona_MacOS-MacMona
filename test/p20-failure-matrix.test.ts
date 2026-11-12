import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactFileStore } from "../src/main/state/artifact-files";
import { StateError } from "../src/main/state/errors";
import { redactHomePath } from "../src/main/work/settings";
import { senderIsTrusted } from "../src/main/ipc-sender";
import { resolveFolderRequest } from "../src/main/open/folder-request";
import { identifyPath } from "../src/main/state/identity";
import { readArchive, writeArchive } from "../src/main/state/safe-archive";
import { openTestStore, tempDir } from "./helpers/state";

/**
 * P20 failure matrix. Each case names the boundary, injects a real fault (not a
 * mocked return), and asserts the product's observable answer: an explicit
 * code, no duplicated row, no leaked secret, no escape from a root.
 */

describe("P20 · IPC sender trust", () => {
  const root = "/Applications/Mona.app/Contents/Resources/renderer";

  it("accepts only the top-level local renderer document", () => {
    expect(
      senderIsTrusted({ senderFrame: { url: `file://${root}/index.html`, parent: null } }, root),
    ).toBe(true);
    expect(
      senderIsTrusted({ senderFrame: { url: `file://${root}/assets/app.js`, parent: null } }, root),
    ).toBe(true);
  });

  it("refuses remote, escaping, child, non-file, and destroyed senders", () => {
    const refused = [
      { senderFrame: { url: "https://example.com/", parent: null } },
      { senderFrame: { url: "file:///etc/passwd", parent: null } },
      { senderFrame: { url: `file://${root}/../../secrets.html`, parent: null } },
      { senderFrame: { url: "javascript:alert(1)", parent: null } },
      { senderFrame: { url: `file://${root}/index.html`, parent: { url: "x" } } },
      { senderFrame: null, sender: { getURL: () => "https://evil.test/" } },
      {
        senderFrame: { url: `file://${root}/index.html`, parent: null },
        sender: { isDestroyed: () => true, getURL: () => `file://${root}/index.html` },
      },
      { senderFrame: null, sender: { getURL: () => "" } },
    ];
    for (const event of refused) {
      expect(senderIsTrusted(event, root)).toBe(false);
    }
  });

  it("fails closed when the frame URL cannot be read", () => {
    const hostile = {
      get senderFrame(): { url: string } {
        throw new Error("frame is gone");
      },
    };
    expect(senderIsTrusted(hostile, root)).toBe(false);
  });
});

describe("P20 · missing artifacts stay named", () => {
  it("reports ARTIFACT_MISSING instead of a raw ENOENT and never invents bytes", async () => {
    const handle = await openTestStore();
    const opened = await handle.store.openProject(
      (() => {
        const dir = join(tempDir("mona-p20-artifact-"), "project");
        mkdirSync(dir, { recursive: true });
        return dir;
      })(),
    );
    const files = new ArtifactFileStore({ root: join(handle.dir, "artifacts") });
    const written = files.write({
      projectId: opened.project.id,
      data: Buffer.from("evidence"),
      mediaType: "text/plain",
    });
    expect(files.read(written.relPath).toString()).toBe("evidence");

    // A crash, a retention bug, or a user cleaning the folder removes the bytes.
    rmSync(files.absolute(written.relPath));
    expect(() => files.read(written.relPath)).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_MISSING" }),
    );
    try {
      files.read(written.relPath);
    } catch (error) {
      expect(error).toBeInstanceOf(StateError);
      expect((error as StateError).details).toMatchObject({ relPath: written.relPath });
    }
  });

  it("still detects silently altered bytes by digest", () => {
    const root = join(tempDir("mona-p20-tamper-"), "artifacts");
    const files = new ArtifactFileStore({ root });
    const written = files.write({
      projectId: "prj_0000000000000001",
      data: Buffer.from("original"),
      mediaType: "text/plain",
    });
    writeFileSync(files.absolute(written.relPath), "tampered");
    expect(() => files.read(written.relPath, { verifyDigest: true })).toThrowError(
      expect.objectContaining({ code: "CORRUPT_DATABASE" }),
    );
  });
});

describe("P20 · home redaction boundary", () => {
  it("redacts the home directory and nothing that merely shares its prefix", () => {
    expect(redactHomePath("/Users/victor/Projects/Mona", "/Users/victor")).toBe("~/Projects/Mona");
    expect(redactHomePath("/Users/victor", "/Users/victor")).toBe("~");
    // A different account whose name starts with the same characters.
    expect(redactHomePath("/Users/victor2/Projects", "/Users/victor")).toBe(
      "/Users/victor2/Projects",
    );
    expect(redactHomePath("/Volumes/Data/x", "/Users/victor")).toBe("/Volumes/Data/x");
    // A degenerate home must not turn every path into `~`.
    expect(redactHomePath("/tmp/x", "/")).toBe("/tmp/x");
  });
});

describe("P20 · hostile folder names and filesystem identity", () => {
  function folder(name: string): string {
    const base = tempDir("mona-p20-names-");
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("accepts unusual but legal names without reinterpreting them", () => {
    const names = [
      "-rf",
      "--help",
      "has space",
      "trailing ",
      "line\nbreak",
      "rtl\u202Egnp.exe",
      "caf\u00e9",
      "cafe\u0301",
      "quote'\"$HOME",
      "\u4f5c\u696d",
    ];
    for (const name of names) {
      const dir = folder(name);
      const resolved = resolveFolderRequest(dir, "drop");
      expect(resolved.ok, `expected ${JSON.stringify(name)} to resolve`).toBe(true);
      if (!resolved.ok) continue;
      // The path is passed to APIs as an argument, never through a shell; the
      // canonical path is the real directory, not a rewritten one.
      expect(resolved.request.path).toBe(identifyPath(dir).canonical);
      expect(resolved.request.input).toBe(dir);
    }
  });

  it("deduplicates a decomposed name, a symlink, and a trailing slash to one identity", () => {
    const base = tempDir("mona-p20-identity-");
    const real = join(base, "caf\u00e9");
    mkdirSync(real, { recursive: true });
    const link = join(base, "alias-link");
    // A symlink stands in for any alias path macOS resolves before delivery.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").symlinkSync(real, link);
    }).not.toThrow();

    const direct = identifyPath(real);
    const viaLink = identifyPath(link);
    const viaSlash = identifyPath(`${real}/`);
    const viaDots = identifyPath(`${base}/./caf\u00e9/../caf\u00e9`);
    for (const identity of [viaLink, viaSlash, viaDots]) {
      expect(identity.canonical).toBe(direct.canonical);
      expect(identity.dev).toBe(direct.dev);
      expect(identity.ino).toBe(direct.ino);
    }

    // APFS may be normalization-insensitive; when it is, the same inode answers.
    const decomposed = join(base, "cafe\u0301");
    const nfdIdentity = (() => {
      try {
        return identifyPath(decomposed);
      } catch {
        return null;
      }
    })();
    if (nfdIdentity) {
      expect(nfdIdentity.ino).toBe(direct.ino);
      expect(nfdIdentity.canonical).toBe(direct.canonical);
    }
  });

  it("refuses a file that only looks like a folder, with an actionable message", () => {
    const base = tempDir("mona-p20-alias-");
    const aliasLike = join(base, "Project alias");
    writeFileSync(aliasLike, "book\u0000\u0000\u0000\u0000alias record bytes");
    const resolved = resolveFolderRequest(aliasLike, "service");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("NOT_A_DIRECTORY");
    expect(resolved.message).toContain("folder");
  });
});

describe("P20 · event identity under duplication and reordering", () => {
  it("stores an out-of-order duplicate once and never moves the cursor backwards", async () => {
    const handle = await openTestStore();
    await handle.store.openProject(
      (() => {
        const dir = join(tempDir("mona-p20-events-"), "project");
        mkdirSync(dir, { recursive: true });
        return dir;
      })(),
    );
    const threadId = "thr_p20_events";
    const record = (seq: number) =>
      handle.store.recordEvent({
        threadId,
        seq,
        kind: "item.completed",
        payload: { seq },
        timestamp: `2026-11-12T00:00:0${seq}.000Z`,
      });

    expect((await record(3)).cursor).toBe(3);
    expect((await record(2)).recorded).toBe(true);
    expect((await record(5)).cursor).toBe(5);
    // Replay of everything already accepted changes nothing.
    expect((await record(3)).recorded).toBe(false);
    expect((await record(5)).recorded).toBe(false);
    expect(await handle.store.getCursor(threadId)).toBe(5);

    const events = await handle.store.readEvents(threadId, 0, 100);
    expect(events.map((event) => event.seq)).toEqual([2, 3, 5]);
  });
});

describe("P20 · archive limits", () => {
  it("refuses an archive that exceeds the total byte budget", () => {
    const archive = writeArchive([
      { path: "a.txt", data: Buffer.alloc(40, 0x61) },
      { path: "b.txt", data: Buffer.alloc(40, 0x62) },
    ]);
    const parsed = readArchive(archive, { maxTotalBytes: 60 });
    expect(parsed.safe).toBe(false);
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems.map((problem) => problem.code)).toContain("ARCHIVE_TOO_LARGE");
  });

  it("refuses an archive with too many entries", () => {
    const archive = writeArchive(
      Array.from({ length: 6 }, (_value, index) => ({
        path: `f${index}.txt`,
        data: Buffer.from("x"),
      })),
    );
    const parsed = readArchive(archive, { maxEntries: 4 });
    expect(parsed.safe).toBe(false);
    expect(parsed.problems.map((problem) => problem.code)).toContain("TOO_MANY_ENTRIES");
  });
});
