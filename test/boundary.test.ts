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

describe("engine ownership boundary", () => {
  it("keeps the provider transport confined to the adapter transport module", async () => {
    const files = await sourceFiles(join(ROOT, "src/main"));
    const callers: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (/\bfetch\s*\(/.test(text)) callers.push(file.replace(ROOT + "/", ""));
    }
    expect(callers.sort()).toEqual([
      "src/main/engine/runtime-process.ts",
      "src/main/engine/transport.ts",
      "src/main/supervisor/driver.ts",
    ]);
  });

  it("never passes the runtime token, base URL, or executable across IPC", async () => {
    const studio = await readFile(join(ROOT, "src/shared/contracts/studio.ts"), "utf8");
    for (const forbidden of [
      /\btoken\s*[:?]/,
      /\bbaseUrl\s*[:?]/,
      /\bexecutable\s*[:?]/,
      /https?:\/\//,
    ]) {
      expect(studio, `studio contract must not carry ${forbidden}`).not.toMatch(forbidden);
    }
    const ipc = await readFile(join(ROOT, "src/main/ipc.ts"), "utf8");
    expect(ipc).not.toContain("endpoint()");
    expect(ipc).not.toMatch(/Bearer/);
  });

  it("does not let the studio submit without an explicit user call", async () => {
    const studio = await readFile(join(ROOT, "src/main/work/studio.ts"), "utf8");
    // Submission happens only inside submit(); nothing else calls it.
    const calls = studio.match(/\.submitTurn\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // Reconciliation is read-only: the only retry path is the lookup route.
    const retries = studio.match(/reconcileSubmission\(/g) ?? [];
    expect(retries.length).toBeLessThanOrEqual(2);
  });
});

describe("cost ledger boundary", () => {
  it("keeps pricing arithmetic free of any inference or network path", async () => {
    for (const relative of ["src/main/work/costs.ts", "src/main/work/cost-math.ts"]) {
      const text = await readFile(join(ROOT, relative), "utf8");
      for (const forbidden of [
        "fetch(",
        "HttpRuntimeTransport",
        "CodewhaleAdapter",
        "EngineAdapter",
        "readUsage",
        "submitTurn",
      ]) {
        expect(text, `${relative} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("never lets the cost screen start work", async () => {
    const text = await readFile(join(ROOT, "src/renderer/shell/Cost.tsx"), "utf8");
    for (const forbidden of ["submitTask", "startStudio", "interruptNow", "dispatchNextTask"]) {
      expect(text, `Cost.tsx must not call ${forbidden}`).not.toContain(forbidden);
    }
    expect(text).toContain("window.mona.costLedger");
  });

  it("carries no provider balance or price constant in the cost contracts", async () => {
    const contract = await readFile(join(ROOT, "src/shared/contracts/cost.ts"), "utf8");
    expect(contract).toContain("available: false");
    const math = await readFile(join(ROOT, "src/main/work/cost-math.ts"), "utf8");
    // No shipped price table: only the unit conversion constant is numeric.
    expect(math).not.toMatch(/deepseek|claude|gpt-/i);
  });
});
