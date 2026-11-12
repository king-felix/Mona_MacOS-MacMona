import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverTool } from "../src/main/tool-discovery";

const tempDirs: string[] = [];

async function binDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mona-tools-${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("GUI-launch tool discovery", () => {
  it("finds a tool on the inherited PATH first", async () => {
    const dir = await binDir("path");
    await writeFile(join(dir, "codewhale"), "#!/bin/sh\n", "utf8");
    await chmod(join(dir, "codewhale"), 0o755);
    const result = discoverTool("codewhale", { envPath: dir, wellKnownDirs: [] });
    expect(result).toEqual({
      name: "codewhale",
      path: join(dir, "codewhale"),
      source: "environment_path",
    });
  });

  it("falls back to the well-known Homebrew location", async () => {
    const dir = await binDir("wellknown");
    await writeFile(join(dir, "git"), "#!/bin/sh\n", "utf8");
    await chmod(join(dir, "git"), 0o755);
    const result = discoverTool("git", { envPath: "", wellKnownDirs: [dir] });
    expect(result.path).toBe(join(dir, "git"));
    expect(result.source).toBe("well_known");
  });

  it("reports a missing tool honestly", () => {
    const result = discoverTool("definitely-not-installed", {
      envPath: "/usr/bin:/bin",
      wellKnownDirs: [],
    });
    expect(result).toEqual({ name: "definitely-not-installed", path: null, source: "missing" });
  });

  it("refuses path-like tool names", () => {
    expect(
      discoverTool("../../bin/sh", { envPath: "/usr/bin", wellKnownDirs: [] }).path,
    ).toBeNull();
  });

  it("does not treat a non-executable file as a tool", async () => {
    const dir = await binDir("nonexec");
    await writeFile(join(dir, "node"), "not a program", "utf8");
    const result = discoverTool("node", { envPath: dir, wellKnownDirs: [] });
    expect(result.path).toBeNull();
  });
});
