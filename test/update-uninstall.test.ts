import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readInstalledFacts, uninstallView } from "../src/main/update/uninstall";
import { tempDir } from "./helpers/state";

/**
 * The uninstall view is a *read*. It enumerates what the package owns from its
 * own manifest, verifies each entry's identity, and names the user's state as a
 * separate decision. It never guesses a path and never removes one.
 */

function receipt(root: string, overrides: Record<string, unknown> = {}): void {
  const dir = join(root, "Library/Application Support/Mona");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "install-receipt.json"),
    JSON.stringify({
      schema_version: 1,
      product: "Mona",
      version: "0.1.0",
      channel: "local",
      package: "Mona-0.1.0-macOS-arm64-local.pkg",
      manifest_sha256: "a".repeat(64),
      installed_at: "2026-11-12T00:00:00Z",
      app_path: "/Applications/Mona.app",
      service_path: "/Library/Services/Mona.service",
      ...overrides,
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "owned-paths.json"),
    JSON.stringify({
      schema_version: 1,
      product: "Mona",
      version: "0.1.0",
      channel: "local",
      package: "Mona-0.1.0-macOS-arm64-local.pkg",
      owned: [
        { path: "/Applications/Mona.app", kind: "app-bundle" },
        { path: "/Library/Services/Mona.service", kind: "service-bundle" },
        { path: "/Library/Application Support/Mona/install-receipt.json", kind: "install-receipt" },
        { path: "/Library/Application Support/Mona/owned-paths.json", kind: "ownership-manifest" },
        { path: "/Library/Application Support/Mona/uninstall-mona.sh", kind: "uninstall-utility" },
      ],
      preserves: ["~/.codewhale and any external Codewhale installation", "user project folders"],
    }),
    "utf8",
  );
}

function bundle(root: string, path: string, id: string): void {
  mkdirSync(join(root, path, "Contents"), { recursive: true });
  writeFileSync(
    join(root, path, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`,
    "utf8",
  );
}

describe("uninstall guidance", () => {
  it("reports that this copy was not installed by the package", () => {
    const root = tempDir("mona-uninstall-");
    const home = tempDir("mona-home-");
    const view = uninstallView({ home, root });
    expect(view.applied).toBe(false);
    expect(view.installedReceipt).toBeNull();
    expect(view.ownershipManifestPresent).toBe(false);
    expect(view.entries).toEqual([]);
    expect(view.note).toContain("not installed by the package");
    expect(view.utility.path).toBeNull();
  });

  it("lists only manifest-owned paths and verifies each bundle identifier", () => {
    const root = tempDir("mona-uninstall-");
    const home = tempDir("mona-home-");
    receipt(root);
    bundle(root, "Applications/Mona.app", "com.mona.workbench");
    bundle(root, "Library/Services/Mona.service", "com.mona.workbench.service");

    const view = uninstallView({ home, root });
    expect(view.applied).toBe(true);
    expect(view.installedReceipt?.version).toBe("0.1.0");
    const app = view.entries.find((entry) => entry.path === "/Applications/Mona.app");
    expect(app).toMatchObject({ present: true, verified: true });
    const service = view.entries.find((entry) => entry.path === "/Library/Services/Mona.service");
    expect(service).toMatchObject({ present: true, verified: true });
    // The utility itself is listed but is absent in this fixture.
    const utility = view.entries.find(
      (entry) => entry.path === "/Library/Application Support/Mona/uninstall-mona.sh",
    );
    expect(utility?.present).toBe(false);
  });

  it("refuses an entry whose bundle identifier is not Mona's", () => {
    const root = tempDir("mona-uninstall-");
    const home = tempDir("mona-home-");
    receipt(root);
    bundle(root, "Applications/Mona.app", "com.example.other");
    const view = uninstallView({ home, root });
    const app = view.entries.find((entry) => entry.path === "/Applications/Mona.app");
    expect(app?.verified).toBe(false);
    expect(app?.detail).toContain("refused");
  });

  it("keeps user state out of the removal list and names it separately", () => {
    const root = tempDir("mona-uninstall-");
    const home = tempDir("mona-home-");
    receipt(root);
    bundle(root, "Applications/Mona.app", "com.mona.workbench");
    // A real user state directory must never appear in `entries`.
    mkdirSync(join(home, "Library/Application Support/Mona"), { recursive: true });
    writeFileSync(join(home, "Library/Application Support/Mona/mona.sqlite"), "state", "utf8");

    const view = uninstallView({ home, root });
    expect(
      view.entries.every(
        (entry) => entry.path.startsWith("/Applications") || entry.path.startsWith("/Library"),
      ),
    ).toBe(true);
    const state = view.userDataScopes.find((scope) => scope.label === "Product state");
    expect(state?.exists).toBe(true);
    expect(state?.path).toBe(join(home, "Library/Application Support/Mona"));
    expect(view.preserves).toContain("user project folders");
    // Removing the app and deleting state are separate commands.
    expect(view.utility.commands.removeService).toContain("--yes");
    expect(view.utility.commands.removeUserData).toContain("--remove-user-data");
    expect(view.utility.commands.removeUserData).toContain("--home");
  });

  it("reports a corrupt ownership manifest instead of inventing paths", () => {
    const root = tempDir("mona-uninstall-");
    const home = tempDir("mona-home-");
    const dir = join(root, "Library/Application Support/Mona");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "install-receipt.json"), "{ not json", "utf8");
    writeFileSync(join(dir, "owned-paths.json"), "{ not json", "utf8");

    const facts = readInstalledFacts(root);
    expect(facts.receipt).toBeNull();
    expect(facts.ownership).toBeNull();
    expect(facts.problems.length).toBeGreaterThan(0);

    const view = uninstallView({ home, root });
    expect(view.applied).toBe(false);
    expect(view.note).toContain("will not guess");
  });

  it("reports an unrelated product receipt as a problem", () => {
    const root = tempDir("mona-uninstall-");
    receipt(root, { product: "Something Else" });
    const facts = readInstalledFacts(root);
    expect(facts.receipt).toBeNull();
    expect(facts.problems.join(" ")).toContain("does not name Mona");
  });
});
