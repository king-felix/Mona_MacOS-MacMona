import { describe, expect, it } from "vitest";
import {
  inspectServiceStatus,
  refreshServiceRegistration,
  serviceInstallCandidates,
  serviceReceiptPath,
  SERVICE_BUNDLE_IDENTIFIER,
  SERVICE_MENU_TITLE,
} from "../src/main/open/service-status";

const HOME = "/Users/example";
const SYSTEM_PATH = "/Library/Services/Mona.service";
const USER_PATH = "/Users/example/Library/Services/Mona.service";

interface Harness {
  existing?: string[];
  plist?: string | null;
  lsregister?: string | null;
  pbs?: string | null;
  receipt?: string | null;
  packaged?: boolean;
  platform?: string;
  arch?: string;
  override?: string | null;
}

function inspect(options: Harness = {}) {
  const existing = new Set(options.existing ?? []);
  return inspectServiceStatus({
    home: HOME,
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "arm64",
    packaged: options.packaged ?? true,
    servicePathOverride: options.override ?? null,
    exists: (path) => existing.has(path),
    exec: (file, args) => {
      if (args[0] === "-convert") {
        return options.plist === undefined ? null : options.plist;
      }
      if (args[0] === "-dump") return options.lsregister ?? null;
      if (args[0] === "read") return options.pbs ?? null;
      return null;
    },
    readFile: (path) => (path.endsWith("last-handoff.json") ? (options.receipt ?? null) : null),
    now: () => new Date("2026-11-12T00:00:00.000Z"),
  });
}

describe("Finder Service status", () => {
  it("reports not installed without inventing an enabled state", () => {
    const status = inspect();
    expect(status.installed).toBe(false);
    expect(status.installPath).toBeNull();
    expect(status.registration).toBe("unknown");
    expect(status.enabled).toBe("unknown");
    expect(status.recovery.length).toBeGreaterThan(0);
    expect(status.recovery.join(" ")).toMatch(/File → Open Project/);
    expect(status.menuTitle).toBe(SERVICE_MENU_TITLE);
    expect(status.appIdentity).toBe("com.mona.workbench");
  });

  it("treats the system install as authoritative over a user install", () => {
    const status = inspect({ existing: [SYSTEM_PATH, USER_PATH] });
    expect(status.installPath).toBe(SYSTEM_PATH);
    expect(status.scope).toBe("system");
  });

  it("reports registered when the vended-services list names the bundle", () => {
    const status = inspect({
      existing: [SYSTEM_PATH],
      plist: JSON.stringify({
        NSServices: {
          CFVendedServices: [
            { NSBundleIdentifier: SERVICE_BUNDLE_IDENTIFIER, NSBundlePath: SYSTEM_PATH },
          ],
        },
      }),
    });
    expect(status.registration).toBe("registered");
    expect(status.recovery).toEqual([]);
  });

  it("falls back to the LaunchServices database when the plist is unreadable", () => {
    const status = inspect({
      existing: [SYSTEM_PATH],
      plist: null,
      lsregister: `service id: ${SERVICE_MENU_TITLE}\nmessage: startProject\n`,
    });
    expect(status.registration).toBe("registered");
  });

  it("reports missing when neither source lists the Service", () => {
    const status = inspect({
      existing: [SYSTEM_PATH],
      plist: JSON.stringify({ NSServices: { CFVendedServices: [] } }),
      lsregister: "unrelated records",
    });
    expect(status.registration).toBe("missing");
    expect(status.recovery.join(" ")).toMatch(/Services/);
  });

  it("reports a macOS-recorded disabled state with the exact recovery steps", () => {
    const status = inspect({
      existing: [SYSTEM_PATH],
      plist: JSON.stringify({
        NSServices: {
          CFVendedServices: [
            { NSBundleIdentifier: SERVICE_BUNDLE_IDENTIFIER, NSBundlePath: SYSTEM_PATH },
          ],
        },
      }),
      pbs: `(
  "${SERVICE_MENU_TITLE} - startProject" = {
    enabled_context_menu = 0;
    enabled_services_menu = 0;
  };
)`,
    });
    expect(status.enabled).toBe("disabled");
    expect(status.recovery.join(" ")).toMatch(/Login Items & Extensions/);
  });

  it("keeps enabled unknown when macOS records no status entry", () => {
    const status = inspect({ existing: [SYSTEM_PATH], plist: "{}", pbs: null });
    expect(status.enabled).toBe("unknown");
  });

  it("says a development build cannot complete Finder handoff yet", () => {
    const status = inspect({
      existing: [SYSTEM_PATH],
      packaged: false,
      plist: JSON.stringify({
        NSServices: {
          CFVendedServices: [
            { NSBundleIdentifier: SERVICE_BUNDLE_IDENTIFIER, NSBundlePath: SYSTEM_PATH },
          ],
        },
      }),
    });
    expect(status.packaged).toBe(false);
    expect(status.recovery.join(" ")).toMatch(/development build/i);
  });

  it("reads the last handoff receipt without secrets", () => {
    const status = inspect({
      receipt: JSON.stringify({
        ok: true,
        code: null,
        resolved_path: "/Users/example/Projects/Mona",
        device: 16777232,
        inode: 33178010,
        forwarded: true,
        invocation: "service",
        timestamp: "2026-11-12T04:00:56.162Z",
      }),
    });
    expect(status.lastHandoff).toEqual({
      at: "2026-11-12T04:00:56.162Z",
      ok: true,
      code: null,
      resolvedPath: "/Users/example/Projects/Mona",
      device: 16777232,
      inode: 33178010,
      forwarded: true,
      invocation: "service",
    });
  });

  it("does not claim support on a non-arm64 or non-macOS host", () => {
    const status = inspect({ platform: "linux", arch: "x64" });
    expect(status.supported).toBe(false);
    expect(status.recovery.join(" ")).toMatch(/Apple Silicon/);
  });

  it("prefers an explicit development bundle and labels the scope", () => {
    const override = "/tmp/mona/native/macos-services/build/Mona.service";
    const status = inspect({ existing: [override], override });
    expect(status.scope).toBe("development");
    expect(status.installPath).toBe(override);
  });

  it("exposes deterministic install and receipt paths", () => {
    expect(serviceInstallCandidates(HOME)).toEqual([SYSTEM_PATH, USER_PATH]);
    expect(serviceReceiptPath(HOME)).toBe(
      "/Users/example/Library/Application Support/Mona/services/last-handoff.json",
    );
  });
});

describe("service registration refresh", () => {
  it("refuses to refresh an arbitrary path", () => {
    const calls: string[][] = [];
    const exec = (_file: string, args: string[]): string | null => {
      calls.push(args);
      return "";
    };
    expect(refreshServiceRegistration("/tmp/evil", exec)).toBe(false);
    expect(refreshServiceRegistration(null, exec)).toBe(false);
    expect(calls).toEqual([]);
  });
});
