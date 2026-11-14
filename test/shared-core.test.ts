import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P25 — the shared core stays portable, checked rather than promised.
 *
 * A shared contract that imports a Node builtin or branches on the platform is
 * the exact thing that turns a two-platform product into two products. This
 * runs the same audit an integrator would run.
 */
describe("P25 shared-core audit", () => {
  it("reports a platform-free shared core and a recorded baseline", () => {
    const result = spawnSync(process.execPath, [resolve("tools/p25-audit.mjs")], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.shared.violations).toEqual([]);
    expect(report.shared.platform_free).toBe(true);
    expect(report.shared.files).toBeGreaterThan(20);
    expect(report.baseline.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(report.baseline.schema.latest.version).toBeGreaterThanOrEqual(13);
    // The Mac tree is the only tree; the report must say so rather than imply a
    // comparison that never happened.
    expect(report.counterpart.windows_checkout).toBeNull();
    expect(report.counterpart.note).toContain("interface handoff");
  });

  it("classifies the Mac-bound modules instead of hiding them", () => {
    const result = spawnSync(process.execPath, [resolve("tools/p25-audit.mjs")], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const report = JSON.parse(result.stdout);
    const bound = report.main.bound_modules.map((entry: { path: string }) => entry.path);
    expect(bound).toContain("src/main/open/service-status.ts");
    expect(bound).toContain("src/main/update/trust.ts");
    // Logic that has no platform dependency must stay in the portable set, so a
    // Windows core can consume it unchanged.
    expect(bound).not.toContain("src/main/work/board.ts");
    expect(bound).not.toContain("src/main/work/cost-math.ts");
    expect(bound).not.toContain("src/main/work/control.ts");
  });
});
