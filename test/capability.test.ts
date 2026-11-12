import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StateStore } from "../src/main/state/store";
import { entryTargetIsKnown } from "../src/shared/contracts/capability";
import {
  CapabilityError,
  CapabilityExplorer,
  computeCoverage,
  loadInventory,
  parseCommandList,
  parseFeatureList,
  parseVersion,
  probeDrift,
  toRowView,
} from "../src/main/work/capability";

const INVENTORY = resolve(__dirname, "..", "docs/codewhale-capabilities-macos.json");

function stubStore(): StateStore {
  return {
    getSettings: async () => null,
    putSettings: async (scope: string, value: unknown) => ({
      scope,
      version: 1,
      value,
      updatedAt: new Date().toISOString(),
    }),
  } as unknown as StateStore;
}

function fakeEngine(help: string, version: string, features = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "mona-capability-probe-"));
  const path = join(dir, "codewhale");
  writeFileSync(
    path,
    `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' "${version}" ;;
  --help) cat <<'HELP'
${help}
HELP
;;
  features) cat <<'FEATURES'
${features}
FEATURES
;;
esac
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

const HELP = `Usage: codewhale [OPTIONS] [PROMPT]
       codewhale [OPTIONS] <COMMAND> [ARGS]

Commands:
  run                  Run an interactive or non-interactive task
  doctor               Run Codewhale diagnostics
  brand-new            A command this inventory has never seen
  help                 Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]...  Initial prompt
`;

describe("capability inventory", () => {
  it("loads the checked-in inventory and validates every row", () => {
    const inventory = loadInventory(INVENTORY);
    expect(inventory.capabilities.length).toBeGreaterThan(50);
    for (const row of inventory.capabilities) {
      expect(row.entry_point.kind).toMatch(/^(screen|settings_tab|palette|terminal|none)$/);
      expect(row.description.length).toBeGreaterThan(0);
      expect(row.invocation.length).toBeGreaterThan(0);
      expect(row.help_source.length).toBeGreaterThan(0);
      expect(row.tests.length).toBeGreaterThan(0);
      if (row.status === "verified") expect(row.entry_point.kind).not.toBe("none");
    }
  });

  it("names only entry targets this build renders", () => {
    const inventory = loadInventory(INVENTORY);
    const dead = inventory.capabilities
      .filter((row) => !entryTargetIsKnown(row.entry_point))
      .map((row) => `${row.mona_id}: ${row.entry_point.kind}/${row.entry_point.target}`);
    expect(dead).toEqual([]);
  });

  it("never claims completeness while a row is open or blocked", () => {
    const inventory = loadInventory(INVENTORY);
    const coverage = computeCoverage(inventory.capabilities.map(toRowView));
    expect(coverage.rowsTotal).toBe(inventory.capabilities.length);
    expect(
      coverage.verified + coverage.unqualified + coverage.unavailable + coverage.blockedGaps,
    ).toBe(coverage.rowsTotal);
    expect(coverage.complete).toBe(false);
    expect(coverage.gaps.length).toBe(
      coverage.unqualified + coverage.unavailable + coverage.blockedGaps,
    );
    expect(coverage.summary).toContain("Full parity is not claimed");
  });

  it("names the workflow and lane gaps instead of hiding them", () => {
    const inventory = loadInventory(INVENTORY);
    const ids = inventory.capabilities
      .filter((row) => row.status === "blocked_gap")
      .map((row) => row.mona_id);
    expect(ids).toContain("MONA-CAP-018");
    expect(ids).toContain("MONA-CAP-019");
  });

  it("rejects a missing or malformed inventory instead of rendering an empty matrix", () => {
    expect(() => loadInventory(join(tmpdir(), "definitely-not-here.json"))).toThrow(
      CapabilityError,
    );
    const dir = mkdtempSync(join(tmpdir(), "mona-bad-inventory-"));
    const bad = join(dir, "capabilities.json");
    writeFileSync(bad, JSON.stringify({ schema_version: 1, capabilities: [] }), "utf8");
    expect(() => loadInventory(bad)).toThrow(/does not match the contract/);
  });
});

describe("drift probe", () => {
  it("parses version, commands, and feature flags from real output shapes", () => {
    expect(parseVersion("codewhale 0.10.2 (ff466b2ed0bf)\n")).toEqual({
      version: "0.10.2",
      commit: "ff466b2ed0bf",
    });
    expect(parseVersion("nothing here")).toEqual({ version: null, commit: null });
    const commands = parseCommandList(HELP);
    expect(commands.map((entry) => entry.name)).toEqual(["run", "doctor", "brand-new", "help"]);
    expect(commands[0]?.summary).toBe("Run an interactive or non-interactive task");
    const features = parseFeatureList(
      "feature\tstage\tenabled\nshell_tool\tstable\ttrue\nvision\tbeta\tfalse\n",
    );
    expect(features).toEqual([
      { name: "shell_tool", stage: "stable", enabled: true },
      { name: "vision", stage: "beta", enabled: false },
    ]);
  });

  it("reports additions and removals instead of assuming a match", async () => {
    const inventory = loadInventory(INVENTORY);
    const rows = inventory.capabilities.map(toRowView);
    const binary = fakeEngine(HELP, "codewhale 0.10.2 (ff466b2ed0bf)");
    const { drift } = await probeDrift(rows, inventory, { binary });
    expect(drift.checked).toBe(true);
    expect(drift.versionMatch).toBe(true);
    expect(drift.commitMatch).toBe(true);
    expect(drift.additions.map((entry) => entry.name)).toEqual(["brand-new"]);
    // Every CLI row except the three the fake help lists is a removal.
    expect(drift.removals.length).toBeGreaterThan(0);
    expect(drift.note).toContain("differs");
  });

  it("reports an unreachable engine as unchecked, not as a clean match", async () => {
    const inventory = loadInventory(INVENTORY);
    const rows = inventory.capabilities.map(toRowView);
    const { drift } = await probeDrift(rows, inventory, {
      binary: join(tmpdir(), "mona-no-such-engine"),
    });
    expect(drift.checked).toBe(false);
    expect(drift.error).toBeTruthy();
    expect(drift.note).toContain("unchecked");
  });
});

describe("CapabilityExplorer", () => {
  it("builds a snapshot with computed coverage, drift, and feature flags", async () => {
    const explorer = new CapabilityExplorer({
      store: stubStore(),
      inventoryPath: INVENTORY,
      probeBinary: fakeEngine(
        HELP,
        "codewhale 0.10.2 (ff466b2ed0bf)",
        "feature\tstage\tenabled\nshell_tool\tstable\ttrue\n",
      ),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
    });
    const snapshot = await explorer.snapshot();
    expect(snapshot.source).toBe("live");
    expect(snapshot.rows.length).toBeGreaterThan(0);
    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.unavailableReason).toContain("parity is not claimed");
    expect(snapshot.drift.checked).toBe(true);
    expect(snapshot.features).toEqual([{ name: "shell_tool", stage: "stable", enabled: true }]);
    expect(snapshot.notes.some((note) => note.includes("installed command"))).toBe(true);
  });

  it("reuses a recent probe and forces a fresh one on refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-probe-count-"));
    const counter = join(dir, "calls.txt");
    const binary = join(dir, "codewhale");
    writeFileSync(
      binary,
      `#!/bin/sh
echo x >> "${counter}"
case "$1" in
  --version) echo "codewhale 0.10.2 (ff466b2ed0bf)" ;;
  --help) printf 'Commands:\n  doctor   Run diagnostics\n\nArguments:\n  x\n' ;;
  *) echo "" ;;
esac
`,
      "utf8",
    );
    chmodSync(binary, 0o755);
    const explorer = new CapabilityExplorer({
      store: stubStore(),
      inventoryPath: INVENTORY,
      probeBinary: binary,
    });
    await explorer.snapshot();
    const firstCount = readFileSync(counter, "utf8").trim().split("\n").length;
    await explorer.snapshot();
    const secondCount = readFileSync(counter, "utf8").trim().split("\n").length;
    expect(secondCount).toBe(firstCount);
    await explorer.refresh();
    const thirdCount = readFileSync(counter, "utf8").trim().split("\n").length;
    expect(thirdCount).toBeGreaterThan(secondCount);
  });

  it("refuses a corrupted cached projection instead of rendering it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-corrupt-cache-"));
    const bad = join(dir, "capabilities.json");
    writeFileSync(bad, "{ not json", "utf8");
    const store = {
      getSettings: async () => ({
        scope: "capabilities:snapshot",
        version: 1,
        value: { rows: [{ id: 1 }], coverage: null },
        updatedAt: new Date().toISOString(),
      }),
      putSettings: async (scope: string, value: unknown) => ({
        scope,
        version: 1,
        value,
        updatedAt: new Date().toISOString(),
      }),
    } as unknown as StateStore;
    const explorer = new CapabilityExplorer({ store, inventoryPath: bad });
    await expect(explorer.snapshot()).rejects.toThrow(CapabilityError);
  });

  it("writes a coverage report that names the gaps", async () => {
    const explorer = new CapabilityExplorer({
      store: stubStore(),
      inventoryPath: INVENTORY,
      probeBinary: fakeEngine(HELP, "codewhale 0.10.2 (ff466b2ed0bf)"),
    });
    const report = await explorer.report();
    expect(report.markdown).toContain("# Mona capability coverage");
    expect(report.markdown).toContain("Full parity is not claimed");
    expect(report.markdown).toContain("MONA-CAP-018");
    const parsed = JSON.parse(report.json) as { coverage: { rowsTotal: number } };
    expect(parsed.coverage.rowsTotal).toBeGreaterThan(0);
  });
});
