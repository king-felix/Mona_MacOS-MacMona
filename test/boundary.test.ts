import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../src/main/security";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("renderer boundary", () => {
  it("never imports upstream wire types or Node/Electron internals", async () => {
    const files = await sourceFiles(join(ROOT, "src/renderer"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const forbidden of [
        "engine-wire",
        "ipcRenderer",
        "child_process",
        "node:fs",
        "node:path",
        "node:child_process",
        "process.env",
      ]) {
        expect(text, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("exposes no raw ipcRenderer from the preload", async () => {
    const text = await readFile(join(ROOT, "src/preload/index.ts"), "utf8");
    expect(text).toContain("contextBridge.exposeInMainWorld");
    expect(text).not.toContain("node:");
    expect(text).not.toContain("child_process");
    expect(text).not.toContain('exposeInMainWorld("ipcRenderer"');
  });
});

describe("content security policy", () => {
  it("denies network connections from the renderer", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
  });

  it("does not allow inline or eval script execution", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });
});
