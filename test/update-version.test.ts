import { describe, expect, it } from "vitest";
import {
  buildNumber,
  compareOsVersions,
  compareVersions,
  isNewerVersion,
  isSameVersion,
  parseVersion,
  userVisibleVersion,
} from "../src/main/update/version";

/**
 * Version order is the only basis for a downgrade or replay decision, so it is
 * pinned directly: no date, no file name, and no source claim participates.
 */
describe("version ordering", () => {
  it("parses dotted versions with an optional pre-release", () => {
    expect(parseVersion("0.2.0")).toMatchObject({ major: 0, minor: 2, patch: 0, pre: [] });
    expect(parseVersion("1.2.3-rc.1")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      pre: ["rc", 1],
    });
    expect(parseVersion("1")).toMatchObject({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion("v1.2.3")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("1.2.3.4")).toBeNull();
  });

  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isSameVersion("0.1.0", "0.1.0")).toBe(true);
  });

  it("sorts a pre-release below its final release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  it("compares macOS versions and reads build counters", () => {
    expect(compareOsVersions("14.0", "14.1")).toBeLessThan(0);
    expect(compareOsVersions("15", "14.9.9")).toBeGreaterThan(0);
    expect(buildNumber("81")).toBe(81);
    expect(buildNumber(81)).toBe(81);
    expect(buildNumber("nope")).toBeNull();
    expect(buildNumber(null)).toBeNull();
  });

  it("strips the development package suffix from a user-visible version", () => {
    expect(userVisibleVersion("0.1.0-p02")).toBe("0.1.0");
    expect(userVisibleVersion("0.2.0")).toBe("0.2.0");
  });
});
