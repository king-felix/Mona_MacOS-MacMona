import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseLaunchArguments,
  resolveFolderRequest,
  type FolderProbe,
} from "../src/main/open/folder-request";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "mona-open-"));
}

function folder(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  // The canonical path: macOS resolves /var to /private/var, and the validator
  // deliberately reports the symlink-free path.
  return realpathSync.native(path);
}

function failingProbe(code: string): FolderProbe {
  return {
    stat: () => {
      throw Object.assign(new Error(`simulated ${code}`), { code });
    },
    realpath: (path) => path,
    access: () => undefined,
  };
}

describe("folder request validation", () => {
  it("accepts an absolute folder path", () => {
    const root = tempRoot();
    const target = folder(root, "plain folder");
    const result = resolveFolderRequest(target, "service");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.path).toBe(target);
    expect(result.request.input).toBe(target);
    expect(result.request.source).toBe("service");
  });

  it("parses a percent-encoded file URL once and keeps awkward characters intact", () => {
    const root = tempRoot();
    const name = `space 'quote' $dollar; semicolon\nnewline`;
    const target = folder(root, name);
    const url = pathToFileURL(target).href;
    const result = resolveFolderRequest(url, "service");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.path).toBe(target);
    expect(result.request.path).toContain("\n");
    expect(result.request.notes.some((note) => note.startsWith("url:"))).toBe(true);
  });

  it("resolves Unicode-normalization differences to the filesystem path", () => {
    const root = tempRoot();
    const decomposed = "cafe\u0301";
    const target = folder(root, decomposed.normalize("NFD"));
    const composedInput = join(root, decomposed.normalize("NFC"));
    const result = resolveFolderRequest(composedInput, "drop");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.path.normalize("NFC")).toBe(target.normalize("NFC"));
  });

  it("resolves a symlink to the real folder and records the fact", () => {
    const root = tempRoot();
    const real = folder(root, "real");
    const link = join(root, "alias");
    symlinkSync(real, link);
    const result = resolveFolderRequest(link, "drop");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.path).toBe(real);
    expect(result.request.notes.some((note) => note.includes("symlink"))).toBe(true);
  });

  it("refuses a file, a missing path, and the startup disk with concrete codes", () => {
    const root = tempRoot();
    const file = join(root, "note.txt");
    writeFileSync(file, "hello");

    const notDirectory = resolveFolderRequest(file, "service");
    expect(notDirectory.ok).toBe(false);
    if (!notDirectory.ok) expect(notDirectory.code).toBe("NOT_A_DIRECTORY");

    const missing = resolveFolderRequest(join(root, "gone"), "service");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("MISSING");
      expect(missing.message).toMatch(/no longer exists/i);
    }

    const rootVolume = resolveFolderRequest("/", "service");
    expect(rootVolume.ok).toBe(false);
    if (!rootVolume.ok) expect(rootVolume.code).toBe("ROOT_VOLUME");
  });

  it("refuses remote file URLs, other schemes, relative paths, empties, and nulls", () => {
    const remote = resolveFolderRequest("file://fileserver/share/project", "service");
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.code).toBe("REMOTE_FILE_URL");

    const https = resolveFolderRequest("https://example.com/project", "service");
    expect(https.ok).toBe(false);
    if (!https.ok) expect(https.code).toBe("UNSUPPORTED_SCHEME");

    const relative = resolveFolderRequest("./project", "drop");
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.code).toBe("RELATIVE_PATH");

    const empty = resolveFolderRequest("   ", "service");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("EMPTY_INPUT");

    const nulled = resolveFolderRequest("/tmp/a\u0000b", "service");
    expect(nulled.ok).toBe(false);
    if (!nulled.ok) expect(nulled.code).toBe("EMBEDDED_NULL");
  });

  it("accepts file://localhost but never another host", () => {
    const root = tempRoot();
    const target = folder(root, "hosted");
    const url = pathToFileURL(target).href.replace("file://", "file://localhost");
    expect(resolveFolderRequest(url, "service").ok).toBe(true);
  });

  it("maps cloud-placeholder and permission failures to honest codes", () => {
    const unavailable = resolveFolderRequest("/Users/example/iCloud/project", "service", {
      probe: failingProbe("EIO"),
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.code).toBe("UNAVAILABLE");
      expect(unavailable.message).toMatch(/online-only|offline volume/i);
    }

    const denied = resolveFolderRequest("/Users/example/Desktop/project", "service", {
      probe: failingProbe("EPERM"),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("NOT_READABLE");
      expect(denied.message).toMatch(/Privacy & Security/);
    }
  });
});

describe("launch argument parsing", () => {
  const appPath = "/Applications/Mona.app";

  it("ignores the app path and finds the folder argument", () => {
    const root = tempRoot();
    const target = folder(root, "from-argv");
    const result = parseLaunchArguments([appPath, target], { appPath });
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.request.path).toBe(target);
  });

  it("honours an explicit --open-folder flag", () => {
    const root = tempRoot();
    const target = folder(root, "flagged");
    const result = parseLaunchArguments([appPath, "--open-folder", pathToFileURL(target).href], {
      appPath,
    });
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.request.path).toBe(target);
  });

  it("returns null when no folder is supplied", () => {
    expect(parseLaunchArguments([appPath], { appPath })).toBeNull();
    expect(parseLaunchArguments([appPath, "--smoke"], { appPath })).toBeNull();
    expect(
      parseLaunchArguments(["/usr/local/bin/electron", "."], {
        appPath: process.cwd(),
        workingDirectory: process.cwd(),
        executablePath: "/usr/local/bin/electron",
      }),
    ).toBeNull();
  });

  it("reports a supplied but invalid folder instead of silently ignoring it", () => {
    const root = tempRoot();
    const result = parseLaunchArguments([appPath, join(root, "missing")], { appPath });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.code).toBe("MISSING");
  });
});
