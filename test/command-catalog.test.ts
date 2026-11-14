import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommandCatalog } from "../src/shared/commands/catalog";
import { CommandCatalogSnapshotSchema } from "../src/shared/contracts/commands";

const root = process.cwd();

describe("R03 command catalog provenance", () => {
  it("is the pinned 0.10.2 registry captured from the engine's own endpoint", () => {
    const catalog = buildCommandCatalog();
    expect(catalog.provenance.version).toBe("0.10.2");
    expect(catalog.provenance.commit).toBe("ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e");
    expect(catalog.provenance.binarySha256).toBe(
      "da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d",
    );
    expect(catalog.provenance.endpoint).toBe("GET /v1/commands");
    expect(catalog.provenance.captureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.provenance.note).toContain("TUI slash registry");
  });

  it("enumerates every command with a nonempty description and a unique spelling", () => {
    const catalog = buildCommandCatalog();
    expect(catalog.stats.total).toBe(109);
    const names = new Set<string>();
    const spellings = new Map<string, string>();
    for (const command of catalog.commands) {
      expect(command.summary.trim().length, `/${command.name} summary`).toBeGreaterThan(0);
      expect(command.usage.startsWith(`/${command.name}`)).toBe(true);
      names.add(command.name);
      for (const spelling of [command.name, ...command.aliases]) {
        const prior = spellings.get(spelling.toLowerCase());
        expect(prior === undefined || prior === command.name).toBe(true);
        spellings.set(spelling.toLowerCase(), command.name);
      }
    }
    expect(names.size).toBe(catalog.commands.length);
  });

  it("reconciles every row with an explicit support route", () => {
    const catalog = buildCommandCatalog();
    expect(catalog.stats).toEqual({
      total: 109,
      runtimeApi: 35,
      terminalOnly: 69,
      unavailable: 5,
      hidden: 1,
    });
    expect(catalog.commands.filter((row) => row.hidden).map((row) => row.name)).toEqual(["lane"]);
    for (const command of catalog.commands) {
      const { support, route, sideEffects, cost } = command.annotation;
      expect(sideEffects.length).toBeGreaterThan(0);
      if (cost === "may-spend") expect(sideEffects).toContain("spend");
      if (support === "runtime-api") {
        expect(route.kind).toBe("runtime-api");
        if (route.kind === "runtime-api") {
          for (const endpoint of route.endpoints) expect(endpoint.startsWith("/v1/")).toBe(true);
        }
      } else {
        expect(route.kind).not.toBe("runtime-api");
      }
      if (support === "unavailable") expect(route.kind).toBe("unavailable");
    }
  });

  it("carries /new only with its verified TUI semantics", () => {
    const catalog = buildCommandCatalog();
    const entry = catalog.commands.find((command) => command.name === "new");
    expect(entry).toBeDefined();
    expect(entry!.usage).toBe("/new [--force]");
    expect(entry!.annotation.notes).toContain("refuses while runtime work is active");
    expect(entry!.annotation.notes).toContain("--force discards draft or queued input only");
    expect(entry!.annotation.support).toBe("runtime-api");
  });

  it("passes the offline coverage check (annotations, pin, capture digest)", () => {
    const output = execFileSync("node", [join(root, "scripts/command-catalog.mjs"), "--check"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      counts: { commands: number; terminalOnly: number; unavailable: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.counts.commands).toBe(109);
    expect(parsed.counts.terminalOnly).toBe(69);
    expect(parsed.counts.unavailable).toBe(5);
  });

  it("builds and serves without a process, a network call, or an adapter", () => {
    for (const path of ["src/shared/commands/catalog.ts", "src/main/work/commands.ts"]) {
      const source = readFileSync(join(root, path), "utf8");
      for (const forbidden of [
        "child_process",
        "spawn(",
        "fetch(",
        "engine/adapter",
        "RuntimeProcess",
      ]) {
        expect(source.includes(forbidden), `${path} must not contain ${forbidden}`).toBe(false);
      }
    }
  });

  it("the snapshot shape stays strict for IPC", () => {
    const catalog = buildCommandCatalog();
    expect(CommandCatalogSnapshotSchema.safeParse(catalog).success).toBe(true);
    expect(CommandCatalogSnapshotSchema.safeParse({ ...catalog, extra: true }).success).toBe(false);
  });
});
