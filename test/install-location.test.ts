import { describe, expect, it } from "vitest";
import { inspectInstallLocation } from "../src/main/install-location";

describe("install location", () => {
  const standard = "/Applications/Mona.app";

  it("accepts the installed copy at the standard path", () => {
    const location = inspectInstallLocation({
      bundlePath: standard,
      packaged: true,
      exists: () => true,
    });
    expect(location.atStandardLocation).toBe(true);
    expect(location.duplicate).toBe(false);
  });

  it("flags a packaged copy elsewhere while the installed copy exists", () => {
    const location = inspectInstallLocation({
      bundlePath: "/Users/example/Applications/MonaDev.app",
      packaged: true,
      exists: () => true,
    });
    expect(location.duplicate).toBe(true);
    expect(location.installedCopyPresent).toBe(true);
  });

  it("does not flag a development run or a missing installed copy", () => {
    expect(
      inspectInstallLocation({
        bundlePath: "/Users/example/Applications/MonaDev.app",
        packaged: false,
        exists: () => true,
      }).duplicate,
    ).toBe(false);
    expect(
      inspectInstallLocation({
        bundlePath: "/Users/example/Applications/MonaDev.app",
        packaged: true,
        exists: () => false,
      }).duplicate,
    ).toBe(false);
  });
});
