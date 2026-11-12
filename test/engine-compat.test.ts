import { describe, expect, it } from "vitest";
import { evaluateCompatibility, hasCapability, PINNED_ENGINE } from "../src/main/engine/compat";
import type { WireRuntimeInfo } from "../src/main/engine/wire";
import { clone, fixture } from "./helpers/fixture-transport";

async function runtimeInfo(): Promise<WireRuntimeInfo> {
  return fixture<WireRuntimeInfo>("runtime-info.json");
}

describe("engine compatibility policy", () => {
  it("accepts the pinned version and commit with required capabilities", async () => {
    const report = evaluateCompatibility(await runtimeInfo());
    expect(report.compatible).toBe(true);
    expect(report.version).toBe(PINNED_ENGINE.version);
    expect(report.commit).toBe(PINNED_ENGINE.commit);
    expect(report.missingCapabilities).toEqual([]);
  });

  it("rejects a different engine version", async () => {
    const info = clone(await runtimeInfo());
    info.codewhale_version = "0.11.0";
    const report = evaluateCompatibility(info);
    expect(report.compatible).toBe(false);
    expect(report.versionMatch).toBe(false);
    expect(report.reasons.join(" ")).toContain("not pinned");
  });

  it("rejects a different commit even with the same version", async () => {
    const info = clone(await runtimeInfo());
    info.codewhale_commit = "0".repeat(40);
    const report = evaluateCompatibility(info);
    expect(report.compatible).toBe(false);
    expect(report.commitMatch).toBe(false);
  });

  it("names each missing required capability", async () => {
    const info = clone(await runtimeInfo());
    delete info.capabilities.event_replay;
    const report = evaluateCompatibility(info);
    expect(report.compatible).toBe(false);
    expect(report.missingCapabilities).toEqual(["event_replay"]);
    expect(hasCapability(info, "turns")).toBe(true);
    expect(hasCapability(info, "event_replay")).toBe(false);
  });
});
