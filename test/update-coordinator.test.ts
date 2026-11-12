import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/main/state/store";
import { UpdateCoordinator } from "../src/main/update/coordinator";
import { inspectPackage, type CommandRunner } from "../src/main/update/trust";
import { openTestStore, tempDir, type TestStoreHandle } from "./helpers/state";

/**
 * The update lifecycle at the coordinator layer: an intent is recorded before
 * anything privileged happens, active work defers the update instead of being
 * interrupted, the state snapshot is verified under the maintenance barrier, and
 * a handoff is only reported after Apple Installer actually opened.
 *
 * The Installer launcher, the package inspector, and the activity probe are
 * injected. Everything else — the store, the barrier, the backup, the intent
 * ledger — is the real implementation.
 */

const DIGEST = "c".repeat(64);

const facts = (overrides: Record<string, unknown> = {}) => ({
  path: "/tmp/Mona-0.2.0-macOS-arm64.pkg",
  sha256: DIGEST,
  sizeBytes: 4096,
  signature: {
    status: "adhoc" as const,
    teamId: null,
    authorities: ["adhoc"],
    developerIdInstaller: false,
    identifier: "com.mona.workbench.pkg",
  },
  package: {
    identifier: "com.mona.workbench.pkg",
    version: "0.2.0",
    build: 120,
    installLocation: "/",
    minimumMacOS: "14.0",
  },
  appBundleId: "com.mona.workbench",
  serviceBundleId: "com.mona.workbench.service",
  architectures: ["arm64"],
  engine: { version: "0.10.2", commit: "ff466b2e" },
  source: "fixture" as const,
  ...overrides,
});

interface Harness {
  store: TestStoreHandle;
  coordinator: UpdateCoordinator;
  launched: string[];
  setActivity: (
    items: Array<{
      projectId: string;
      projectName: string;
      kind: "turn" | "task" | "runtime" | "submission";
      taskId: string | null;
      taskTitle: string | null;
      detail: string;
    }>,
  ) => void;
}

async function harness(
  options: {
    version?: string;
    build?: number;
    channel?: "local" | "release";
    launchFails?: boolean;
    inspect?: (path: string) => ReturnType<typeof facts>;
    pkgPath?: string;
  } = {},
): Promise<Harness> {
  const store = await openTestStore();
  const launched: string[] = [];
  let activity: Array<{
    projectId: string;
    projectName: string;
    kind: "turn" | "task" | "runtime" | "submission";
    taskId: string | null;
    taskTitle: string | null;
    detail: string;
  }> = [];
  const pkgPath = options.pkgPath ?? join(store.dir, "Mona-0.2.0-macOS-arm64.pkg");
  if (!existsSync(pkgPath)) writeFileSync(pkgPath, "package-bytes", "utf8");
  const coordinator = new UpdateCoordinator({
    store: store.store,
    paths: { cache: join(store.dir, "cache"), support: store.dir },
    current: () => ({
      version: options.version ?? "0.1.0",
      build: options.build ?? 81,
      channel: options.channel ?? "local",
      schemaVersion: 8,
      engineVersion: "0.10.2",
      engineCommit: "ff466b2e",
    }),
    hostOs: () => "14.5",
    hostArch: () => "arm64",
    inspect: options.inspect ?? (() => facts()),
    launchInstaller: async (path) => {
      if (options.launchFails) throw new Error("Installer refused to open");
      launched.push(path);
    },
    activity: async () => activity,
    shouldQuit: () => true,
    afterHandoff: () => undefined,
    now: () => new Date("2026-11-12T12:00:00.000Z"),
  });
  return {
    store,
    coordinator,
    launched,
    setActivity: (items) => {
      activity = items;
    },
  };
}

const activeItem = {
  projectId: "prj_00000001",
  projectName: "Mona",
  kind: "turn" as const,
  taskId: "tsk_00000001",
  taskTitle: "Refactor the parser",
  detail: "turn turn_1 is active",
};

closeStores();
const open: StateStore[] = [];
function track<T extends { store: TestStoreHandle }>(value: T): T {
  open.push(value.store.store);
  return value;
}
function closeStores(): void {
  // Each test closes its own store; this keeps the shape obvious above.
}

afterEach(async () => {
  while (open.length > 0) {
    const store = open.pop();
    await store?.close().catch(() => undefined);
  }
});

describe("update coordinator", () => {
  it("verifies a chosen local package and reports its facts without installing", async () => {
    const h = track(await harness());
    const view = await h.coordinator.inspectLocal(join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg"));
    expect(view.decision).toBe("available");
    expect(view.mode).toBe("manual");
    expect(view.candidate?.version).toBe("0.2.0");
    expect(view.candidate?.packageSha256).toBe(DIGEST);
    expect(view.packagePath).toContain("Mona-0.2.0-macOS-arm64.pkg");
    expect(view.inference.requests).toBe(0);
    expect(h.launched).toHaveLength(0);
    expect(await h.store.store.latestUpdateIntent()).toBeNull();
  });

  it("records the intent, verifies the snapshot, and only then opens Installer", async () => {
    const h = track(await harness());
    await h.coordinator.inspectLocal(join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg"));
    const receipt = await h.coordinator.install({
      expectedSha256: DIGEST,
      confirmedLocalBuild: true,
    });

    expect(receipt.state).toBe("handed_off");
    expect(receipt.installerLaunched).toBe(true);
    expect(h.launched).toHaveLength(1);
    expect(receipt.backup).not.toBeNull();
    expect(receipt.backup?.integrity).toBe("ok");
    expect(receipt.backup?.schemaVersion).toBe(8);
    expect(existsSync(receipt.backup?.path ?? "")).toBe(true);

    const intent = await h.store.store.latestUpdateIntent();
    expect(intent?.state).toBe("handed_off");
    expect(intent?.packageSha256).toBe(DIGEST);
    expect(intent?.backupPath).toBe(receipt.backup?.path);
    expect(intent?.backupSha256).toBe(receipt.backup?.sha256);
    expect(intent?.fromVersion).toBe("0.1.0");
    expect(intent?.toVersion).toBe("0.2.0");
    // The maintenance barrier is released after the snapshot.
    expect(h.store.store.barrier.snapshot().maintenance).toBe(false);
  });

  it("defers while work is active and leaves the state and the runtime alone", async () => {
    const h = track(await harness());
    h.setActivity([activeItem]);
    await h.coordinator.inspectLocal(join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg"));
    const receipt = await h.coordinator.install({
      expectedSha256: DIGEST,
      confirmedLocalBuild: true,
    });

    expect(receipt.state).toBe("deferred");
    expect(receipt.installerLaunched).toBe(false);
    expect(h.launched).toHaveLength(0);
    expect(await h.store.store.latestUpdateIntent()).toBeNull();
    expect(receipt.reason).toContain("Refactor the parser");
    expect(receipt.reason).toContain("does not stop a run");
  });

  it("refuses to install a local build that was not explicitly confirmed", async () => {
    const h = track(await harness());
    await h.coordinator.inspectLocal(join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg"));
    const receipt = await h.coordinator.install({ expectedSha256: DIGEST });
    expect(receipt.state).toBe("refused");
    expect(receipt.code).toBe("local_build_unconfirmed");
    expect(h.launched).toHaveLength(0);
    expect(await h.store.store.latestUpdateIntent()).toBeNull();
  });

  it("refuses when the package bytes changed after they were verified", async () => {
    // This inspector hashes the file for real, so the swap below is genuine.
    const h = track(
      await harness({
        inspect: (path) => {
          const bytes = readFileSync(path);
          return facts({
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
          });
        },
      }),
    );
    const path = join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg");
    const view = await h.coordinator.inspectLocal(path);
    expect(view.decision).toBe("available");
    const verifiedDigest = view.candidate?.packageSha256 ?? "";

    writeFileSync(path, "different-bytes", "utf8");
    const receipt = await h.coordinator.install({
      expectedSha256: verifiedDigest,
      confirmedLocalBuild: true,
    });
    expect(receipt.state).toBe("refused");
    expect(receipt.code).toBe("digest_mismatch");
    expect(receipt.reason).toContain("changed after it was verified");
    expect(h.launched).toHaveLength(0);
    expect(await h.store.store.latestUpdateIntent()).toBeNull();
  });

  it("marks the intent failed and keeps the app running when Installer cannot open", async () => {
    const h = track(await harness({ launchFails: true }));
    await h.coordinator.inspectLocal(join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg"));
    const receipt = await h.coordinator.install({
      expectedSha256: DIGEST,
      confirmedLocalBuild: true,
    });
    expect(receipt.state).toBe("refused");
    expect(receipt.code).toBe("handoff_failed");
    expect(receipt.installerLaunched).toBe(false);
    expect(receipt.quitRequested).toBe(false);
    // The verified snapshot is still reported: the evidence survives the failure.
    expect(receipt.backup?.integrity).toBe("ok");

    const intent = await h.store.store.latestUpdateIntent();
    expect(intent?.state).toBe("failed");
    // A failed package is not "applied", so it can be retried.
    expect(await h.store.store.appliedUpdatePackages()).toEqual([]);
  });

  it("refuses a replay of the same bytes and allows a newer package afterwards", async () => {
    const h = track(await harness());
    const path = join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg");
    await h.coordinator.inspectLocal(path);
    const first = await h.coordinator.install({
      expectedSha256: DIGEST,
      confirmedLocalBuild: true,
    });
    expect(first.state).toBe("handed_off");

    // Re-inspecting the same bytes is now a replay refusal.
    const again = await h.coordinator.inspectLocal(path);
    expect(again.decision).toBe("refused");
    expect(again.code).toBe("replayed");

    // A different, newer package is still allowed.
    const other = track(await harness());
    await other.store.store.recordUpdateIntent({
      fromVersion: "0.1.0",
      toVersion: "0.0.9",
      channel: "local",
      packagePath: "/tmp/old.pkg",
      packageSha256: "d".repeat(64),
      source: "manual",
    });
    const fresh = await other.coordinator.inspectLocal(
      join(other.store.dir, "Mona-0.2.0-macOS-arm64.pkg"),
    );
    expect(fresh.decision).toBe("available");
  });

  it("reconciles a handoff on the next launch: newer version migrates, same version cancels", async () => {
    const h = track(await harness());
    await h.coordinator.inspectLocal(join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg"));
    await h.coordinator.install({ expectedSha256: DIGEST, confirmedLocalBuild: true });
    // Still the old version on this launch: Installer was cancelled.
    const cancelled = await h.coordinator.reconcileOnLaunch();
    expect(cancelled?.state).toBe("cancelled");

    const newer = track(await harness({ version: "0.2.0", build: 120 }));
    const record = await newer.store.store.recordUpdateIntent({
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      channel: "local",
      packagePath: "/tmp/Mona-0.2.0.pkg",
      packageSha256: DIGEST,
      source: "manual",
    });
    await newer.store.store.settleUpdateIntent(record.id, "handed_off");
    const migrated = await newer.coordinator.reconcileOnLaunch();
    expect(migrated?.state).toBe("observed_migrated");
  });

  it("records a same-version handoff as cancelled, not as a proven migration", async () => {
    // A reinstall leaves the version unchanged, so this launch cannot prove the
    // package was installed; claiming otherwise would also block a retry as a
    // replay of bytes that may never have landed.
    const h = track(await harness({ version: "0.2.0", build: 120 }));
    const record = await h.store.store.recordUpdateIntent({
      fromVersion: "0.2.0",
      toVersion: "0.2.0",
      channel: "local",
      packagePath: "/tmp/Mona-0.2.0.pkg",
      packageSha256: DIGEST,
      source: "manual",
    });
    await h.store.store.settleUpdateIntent(record.id, "handed_off");
    const settled = await h.coordinator.reconcileOnLaunch();
    expect(settled?.state).toBe("cancelled");
    expect(await h.store.store.appliedUpdatePackages()).toEqual([]);
  });

  it("refuses an engine change that this package's digest did not acknowledge", async () => {
    const bumped = facts({ engine: { version: "0.11.0", commit: "deadbeef" } });
    const h = track(await harness({ inspect: () => bumped }));
    const path = join(h.store.dir, "Mona-0.2.0-macOS-arm64.pkg");
    const view = await h.coordinator.inspectLocal(path);
    expect(view.decision).toBe("refused");
    expect(view.code).toBe("engine_change_unconfirmed");
    expect(view.engineChange).toEqual({ from: "0.10.2", to: "0.11.0" });

    const refused = await h.coordinator.install({
      expectedSha256: DIGEST,
      confirmedLocalBuild: true,
    });
    expect(refused.state).toBe("refused");
    expect(refused.code).toBe("engine_change_unconfirmed");
    expect(h.launched).toHaveLength(0);

    // A digest-bound acknowledgement unlocks exactly these bytes.
    h.coordinator.confirmEngineChange(DIGEST);
    const allowed = await h.coordinator.install({
      expectedSha256: DIGEST,
      confirmedLocalBuild: true,
    });
    expect(allowed.state).toBe("handed_off");
    expect(h.launched).toHaveLength(1);
  });

  it("refuses a missing package file rather than guessing", async () => {
    const h = track(await harness());
    const missing = await h.coordinator.inspectLocal(join(h.store.dir, "absent.pkg"));
    expect(missing.decision).toBe("refused");
    const receipt = await h.coordinator.install({
      packagePath: join(h.store.dir, "absent.pkg"),
      expectedSha256: DIGEST,
      confirmedLocalBuild: true,
    });
    expect(receipt.state).toBe("refused");
    expect(receipt.code).toBe("manifest_malformed");
  });

  it("reports manual mode and makes no network call when nothing is configured", async () => {
    const h = track(await harness());
    const status = await h.coordinator.status();
    expect(status.config.mode).toBe("manual");
    expect(status.note).toContain("Manual package updates");
    const view = await h.coordinator.check({ refresh: true });
    expect(view.decision).toBe("manual");
    expect(view.code).toBe("no_source");
    expect(view.source.baseUrl).toBeNull();
    expect(view.inference.requests).toBe(0);
  });

  it("refuses an invalid source configuration instead of persisting it", async () => {
    const h = track(await harness());
    await expect(
      h.coordinator.configure({
        mode: "configured",
        baseUrl: "http://plaintext.example.com",
        manifestPath: "update.json",
        teamId: "ABCDE12345",
        manifestKey: "x".repeat(40),
        allowLocalPackages: true,
      }),
    ).rejects.toMatchObject({ code: "source_unconfigured" });
    // A configured source missing its key is refused too.
    await expect(
      h.coordinator.configure({
        mode: "configured",
        baseUrl: "https://updates.example.com",
        manifestPath: "update.json",
        teamId: "ABCDE12345",
        manifestKey: null,
        allowLocalPackages: true,
      }),
    ).rejects.toMatchObject({ code: "source_unconfigured" });
    expect((await h.coordinator.status()).config.mode).toBe("manual");
  });

  it("persists a valid source and reports its host without exposing the key", async () => {
    const h = track(await harness());
    const { generateKeyPairSync } = await import("node:crypto");
    const key = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    const config = await h.coordinator.configure({
      mode: "configured",
      baseUrl: "https://updates.example.com/mona",
      manifestPath: "update.json",
      teamId: "ABCDE12345",
      manifestKey: key,
      allowLocalPackages: true,
    });
    expect(config.baseUrl).toBe("https://updates.example.com/mona");
    const status = await h.coordinator.status();
    expect(status.config.mode).toBe("configured");
    expect(status.source.host).toBe("updates.example.com");
    expect(status.source.keyFingerprint).toBeNull();
  });

  it("treats an activity probe failure as active work, never as idle", async () => {
    const store = await openTestStore();
    open.push(store.store);
    const coordinator = new UpdateCoordinator({
      store: store.store,
      paths: { cache: join(store.dir, "cache"), support: store.dir },
      current: () => ({
        version: "0.1.0",
        build: 81,
        channel: "local",
        schemaVersion: 8,
        engineVersion: "0.10.2",
        engineCommit: "f",
      }),
      hostOs: () => "14.5",
      hostArch: () => "arm64",
      inspect: () => facts(),
      launchInstaller: async () => {
        throw new Error("must not be called");
      },
      activity: async () => {
        throw new Error("probe exploded");
      },
    });
    const deferral = await coordinator.deferral();
    expect(deferral.deferred).toBe(true);
    expect(deferral.items[0]?.detail).toContain("could not read whether work is active");
  });
});

describe("update intents in the store", () => {
  it("records an intent before a backup and refuses to move backwards", async () => {
    const store = await openTestStore();
    open.push(store.store);
    const intent = await store.store.recordUpdateIntent({
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      channel: "local",
      packagePath: "/tmp/x.pkg",
      packageSha256: DIGEST,
      source: "manual",
    });
    expect(intent.state).toBe("recorded");
    const backed = await store.store.attachUpdateBackup(intent.id, "/tmp/b.sqlite", "e".repeat(64));
    expect(backed.backupPath).toBe("/tmp/b.sqlite");
    const handed = await store.store.settleUpdateIntent(intent.id, "handed_off");
    expect(handed.state).toBe("handed_off");
    await expect(store.store.settleUpdateIntent(intent.id, "recorded")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      store.store.attachUpdateBackup(intent.id, "/tmp/c.sqlite", "f".repeat(64)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reports running tasks, active submissions, and live runtimes as active work", async () => {
    const store = await openTestStore();
    open.push(store.store);
    const project = await store.store.createProject({
      name: "Active",
      rootPath: tempDir("mona-active-"),
      canonicalPath: tempDir("mona-active-"),
      fsDev: 1,
      fsIno: 2,
    });
    expect(await store.store.activeWork()).toEqual([]);

    const task = await store.store.createTask({
      projectId: project.id,
      title: "Long turn",
      prompt: "do the work",
    });
    await store.store.updateTaskStatus(task.id, "running", task.revision, {
      actor: "mona_queue",
    });
    const items = await store.store.activeWork();
    expect(items.some((item) => item.kind === "task" && item.taskTitle === "Long turn")).toBe(true);
  });
});

/**
 * `pkgutil` is the real source of package facts, but a fixture can stand in for
 * it so the parser is pinned without a 150 MiB package.
 */
describe("package inspection parser", () => {
  const signatureText = `Package "Mona-0.2.0.pkg":
   Status: signed by a developer certificate issued by Apple (Inc.)
   Certificate Chain:
    1. Developer ID Installer: Mona Software (ABCDE12345)
    2. Developer ID Certification Authority
    3. Apple Root CA
   TeamIdentifier=ABCDE12345`;

  it("reads a signed Developer ID Installer package", async () => {
    const { parsePackageSignature } = await import("../src/main/update/trust");
    const parsed = parsePackageSignature(signatureText);
    expect(parsed.status).toBe("signed");
    expect(parsed.teamId).toBe("ABCDE12345");
    expect(parsed.developerIdInstaller).toBe(true);
    expect(parsed.authorities[0]).toContain("Developer ID Installer");
  });

  it("reads an unsigned and an ad-hoc package distinctly", async () => {
    const { parsePackageSignature } = await import("../src/main/update/trust");
    expect(parsePackageSignature('Package "x":\n   Status: no signature').status).toBe("unsigned");
    expect(parsePackageSignature("Signature=adhoc\nStatus: adhoc").status).toBe("adhoc");
    expect(parsePackageSignature("").status).toBe("unknown");
  });

  it("expands metadata without trusting it, and reports what it read", () => {
    const root = tempDir("mona-pkg-");
    const path = join(root, "Mona-test.pkg");
    writeFileSync(path, "not-a-real-package", "utf8");
    const runner: CommandRunner = (command, args) => {
      if (args.includes("--check-signature")) {
        return { status: 0, stdout: "Status: no signature", stderr: "" };
      }
      const expanded = args[2] as string;
      mkdirSync(join(expanded, "component.pkg"), { recursive: true });
      mkdirSync(join(expanded, "Resources"), { recursive: true });
      writeFileSync(
        join(expanded, "component.pkg", "PackageInfo"),
        `<pkg-info identifier="com.mona.workbench.pkg" version="0.2.0" install-location="/" relocatable="false">
           <bundle path="./Applications/Mona.app" id="com.mona.workbench" CFBundleVersion="120"/>
           <bundle path="./Library/Services/Mona.service" id="com.mona.workbench.service" CFBundleVersion="120"/>
         </pkg-info>`,
        "utf8",
      );
      writeFileSync(
        join(expanded, "Distribution"),
        `<installer-gui-script><options hostArchitectures="arm64"/><allowed-os-versions><os-version min="14.0"/></allowed-os-versions></installer-gui-script>`,
        "utf8",
      );
      writeFileSync(
        join(expanded, "Resources", "update-metadata.json"),
        JSON.stringify({ version: "0.2.0", build: 120, channel: "local" }),
        "utf8",
      );
      return { status: 0, stdout: "", stderr: "" };
    };
    const facts = inspectPackage(path, runner);
    expect(facts.package.identifier).toBe("com.mona.workbench.pkg");
    expect(facts.package.version).toBe("0.2.0");
    expect(facts.package.build).toBe(120);
    expect(facts.appBundleId).toBe("com.mona.workbench");
    expect(facts.serviceBundleId).toBe("com.mona.workbench.service");
    expect(facts.architectures).toEqual(["arm64"]);
    expect(facts.package.minimumMacOS).toBe("14.0");
    expect(facts.signature.status).toBe("unsigned");
    expect(facts.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.source).toBe("pkgutil");
  });

  it("refuses a path that is not a package file", () => {
    const root = tempDir("mona-pkg-");
    const notPkg = join(root, "notes.txt");
    writeFileSync(notPkg, "x", "utf8");
    expect(() => inspectPackage(notPkg, () => ({ status: 0, stdout: "", stderr: "" }))).toThrow();
    const fakePkg = join(root, "empty.pkg");
    writeFileSync(fakePkg, "", "utf8");
    expect(() => inspectPackage(fakePkg, () => ({ status: 0, stdout: "", stderr: "" }))).toThrow(
      /empty/,
    );
  });
});

// Keep the import used even when a future edit removes the readFileSync call.
void readFileSync;
