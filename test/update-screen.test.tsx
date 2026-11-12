// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RecoveryView,
  UninstallView,
  UpdateCheckView,
  UpdateStatusView,
} from "../src/shared/contracts/update";
import { UpdateSettings } from "../src/renderer/shell/UpdateSettings";

/**
 * The Updates screen renders recorded facts and refuses to overstate them: a
 * refusal shows its code, a deferred update lists the exact active work, a
 * local package needs an explicit confirmation, and an unverified snapshot is
 * not offered as restorable.
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const status: UpdateStatusView = {
  current: {
    version: "0.1.0",
    build: 81,
    channel: "local",
    schemaVersion: 8,
    engineVersion: "0.10.2",
  },
  config: {
    schemaVersion: 1,
    mode: "configured",
    baseUrl: "https://updates.example.com/mona",
    manifestPath: "update.json",
    teamId: "ABCDE12345",
    manifestKey: "k".repeat(44),
    allowLocalPackages: true,
  },
  configProblem: null,
  source: {
    baseUrl: "https://updates.example.com/mona",
    host: "updates.example.com",
    manifestAuthenticated: true,
    keyFingerprint: "f".repeat(64),
  },
  lastCheck: null,
  lastIntent: null,
  history: [],
  deferral: {
    deferred: false,
    items: [],
    reason: "No task, turn, or runtime is active.",
    action: "An update can be verified and handed to Installer now.",
  },
  note: "A distribution source is configured.",
};

const check: UpdateCheckView = {
  mode: "configured",
  decision: "available",
  code: null,
  reason: "Mona 0.2.0 (build 120) is available; the installed version is 0.1.0.",
  checkedAt: "2026-11-12T12:00:00.000Z",
  current: status.current,
  candidate: {
    version: "0.2.0",
    build: 120,
    channel: "release",
    packageName: "Mona-0.2.0-macOS-arm64.pkg",
    packageSha256: "a".repeat(64),
    packageSize: 4096,
    minimumMacOS: "14.0",
    architectures: ["arm64"],
    engineVersion: "0.10.2",
    teamId: "ABCDE12345",
    notarized: true,
    releasedAt: "2026-11-12T00:00:00.000Z",
    installKind: "upgrade",
  },
  engineChange: null,
  deferral: status.deferral,
  packagePath: "/tmp/Mona-0.2.0-macOS-arm64.pkg",
  source: status.source,
  inference: { requests: 0, note: "no model call" },
};

const uninstall: UninstallView = {
  applied: true,
  installedReceipt: {
    version: "0.1.0",
    channel: "local",
    package: "Mona-0.1.0-macOS-arm64-local.pkg",
    manifestSha256: "b".repeat(64),
    installedAt: "2026-11-12T00:00:00Z",
  },
  ownershipManifestPresent: true,
  entries: [
    {
      path: "/Applications/Mona.app",
      kind: "app-bundle",
      present: true,
      verified: true,
      detail: "owned bundle",
    },
    {
      path: "/Library/Services/Mona.service",
      kind: "service-bundle",
      present: true,
      verified: false,
      detail: "refused: bundle identifier is com.example.other",
    },
  ],
  userDataScopes: [
    {
      label: "Product state",
      path: "/Users/example/Library/Application Support/Mona",
      exists: true,
      note: "Database, backups, artifacts.",
    },
  ],
  preserves: ["user project folders"],
  utility: {
    path: "/Library/Application Support/Mona/uninstall-mona.sh",
    signed: false,
    commands: {
      dryRun: 'sudo sh "/Library/Application Support/Mona/uninstall-mona.sh" --dry-run',
      removeService: 'sudo sh "/Library/Application Support/Mona/uninstall-mona.sh" --yes',
      removeUserData:
        'sh "/Library/Application Support/Mona/uninstall-mona.sh" --remove-user-data --home "/Users/example" --yes',
    },
  },
  note: "Removing Mona and deleting your state are separate actions.",
};

const recovery: RecoveryView = {
  buildSchemaVersion: 8,
  databaseSchemaVersion: 9,
  state: "newer_schema",
  problem: { code: "UNSUPPORTED_SCHEMA", message: "This Mac's state was written by a newer Mona." },
  snapshots: [
    {
      path: "/Users/example/Library/Application Support/Mona/backups/pre-update-0.2.0.sqlite",
      fileName: "pre-update-0.2.0.sqlite",
      schemaVersion: 9,
      createdAt: "2026-11-12T00:00:00.000Z",
      sizeBytes: 2048,
      sha256: "c".repeat(64),
      integrity: "ok",
      appliesToThisBuild: false,
    },
    {
      path: "/Users/example/Library/Application Support/Mona/backups/pre-migration-v7.sqlite",
      fileName: "pre-migration-v7.sqlite",
      schemaVersion: 8,
      createdAt: "2026-11-11T00:00:00.000Z",
      sizeBytes: 1024,
      sha256: "d".repeat(64),
      integrity: "ok",
      appliesToThisBuild: true,
    },
  ],
  journal: null,
  support: {
    supportPath: "/Users/example/Library/Application Support/Mona",
    backupsPath: "/Users/example/Library/Application Support/Mona/backups",
    reportPath: null,
    instruction: "",
  },
  canRestoreSnapshot: true,
  note: "App rollback and database rollback are different.",
};

interface BridgeOverrides {
  status?: UpdateStatusView;
  check?: UpdateCheckView;
  uninstall?: UninstallView;
  recovery?: RecoveryView;
}

function installBridge(overrides: BridgeOverrides = {}): void {
  (window as unknown as { mona: unknown }).mona = {
    updateStatus: async () => ({ ok: true, value: overrides.status ?? status }),
    uninstallGuide: async () => ({ ok: true, value: overrides.uninstall ?? uninstall }),
    stateRecovery: async () => ({ ok: true, value: overrides.recovery ?? recovery }),
    checkForUpdate: async () => ({ ok: true, value: overrides.check ?? check }),
    configureUpdateSource: async () => ({ ok: true, value: { config: status.config, status } }),
    chooseUpdatePackage: async () => ({ ok: true, value: { chosen: false, view: null } }),
    inspectLocalUpdate: async () => ({ ok: true, value: check }),
    installUpdate: async () => ({
      ok: true,
      value: {
        intentId: "upd_00000001",
        state: "deferred",
        code: null,
        reason: "1 active item: turn in Mona.",
        fromVersion: "0.1.0",
        toVersion: "0.2.0",
        packagePath: "/tmp/Mona-0.2.0-macOS-arm64.pkg",
        packageSha256: "a".repeat(64),
        backup: null,
        intentRecordedAt: null,
        handedOffAt: null,
        installerLaunched: false,
        quitRequested: false,
      },
    }),
    confirmEngineChange: async () => ({ ok: true, value: { confirmed: true } }),
    cancelUpdateIntent: async () => ({ ok: true, value: null }),
    restoreRecoverySnapshot: async () => ({ ok: true, value: null }),
  };
}

async function render(): Promise<void> {
  await act(async () => {
    root?.render(<UpdateSettings />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const text = (): string => container?.textContent ?? "";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("Updates screen", () => {
  it("shows this build's real identity and an unauthenticated-free source", async () => {
    installBridge();
    await render();
    expect(text()).toContain("0.1.0");
    expect(text()).toContain("local development build");
    expect(text()).toContain("updates.example.com");
    expect(text()).toContain("v8");
  });

  it("renders a refusal with its machine-readable code", async () => {
    installBridge({
      check: {
        ...check,
        decision: "refused",
        code: "replayed",
        reason: "This exact package was already applied on 2026-11-12.",
        candidate: null,
      },
    });
    await render();
    const button = container?.querySelector('[data-testid="update-check"]');
    expect(button).not.toBeNull();
    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    expect(text()).toContain("Refused");
    expect(container?.querySelector('[data-testid="update-decision-code"]')?.textContent).toContain(
      "replayed",
    );
  });

  it("lists the exact active work that defers an update", async () => {
    installBridge({
      status: {
        ...status,
        deferral: {
          deferred: true,
          items: [
            {
              projectId: "prj_00000001",
              projectName: "Mona",
              kind: "turn",
              taskId: "tsk_00000001",
              taskTitle: "Refactor the parser",
              detail: "turn turn_1 is active",
            },
          ],
          reason: "1 active item: turn in Mona.",
          action: "Finish or interrupt the active work first.",
        },
      },
    });
    await render();
    await act(async () => {
      (container?.querySelector('[data-testid="update-check"]') as HTMLButtonElement).click();
    });
    const items = container?.querySelector('[data-testid="update-deferral-items"]');
    expect(items?.textContent).toContain("Refactor the parser");
    const install = container?.querySelector('[data-testid="update-install"]') as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    expect(text()).toContain("Finish active work first.");
  });

  it("requires an explicit confirmation before a local package can be installed", async () => {
    installBridge({
      check: {
        ...check,
        mode: "manual",
        candidate: check.candidate
          ? { ...check.candidate, channel: "local", notarized: false }
          : null,
        source: { baseUrl: null, host: null, manifestAuthenticated: false, keyFingerprint: null },
      },
    });
    await render();
    await act(async () => {
      (container?.querySelector('[data-testid="update-check"]') as HTMLButtonElement).click();
    });
    expect(text()).toContain("Local development build");
    const install = container?.querySelector('[data-testid="update-install"]') as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    const toggle = Array.from(container?.querySelectorAll('[role="switch"]') ?? []).find((node) =>
      node.textContent?.includes("local development build"),
    ) as HTMLButtonElement | undefined;
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle?.click();
    });
    expect(
      (container?.querySelector('[data-testid="update-install"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("offers a restore only for a snapshot this build can open", async () => {
    installBridge();
    await render();
    const list = container?.querySelector('[data-testid="recovery-snapshots"]');
    expect(list?.textContent).toContain("pre-migration-v7.sqlite");
    expect(list?.textContent).toContain("not this build's schema");
    expect(list?.textContent).toContain("Restore…");
    // Exactly one restorable snapshot means exactly one Restore control.
    const restores = Array.from(container?.querySelectorAll("button") ?? []).filter((button) =>
      button.textContent?.includes("Restore…"),
    );
    expect(restores).toHaveLength(1);
    expect(text()).toContain("written by a newer Mona");
  });

  it("separates package-owned paths from user data in the uninstall guide", async () => {
    installBridge();
    await render();
    expect(container?.querySelector('[data-testid="uninstall-entries"]')?.textContent).toContain(
      "refused: bundle identifier is com.example.other",
    );
    expect(container?.querySelector('[data-testid="uninstall-user-data"]')?.textContent).toContain(
      "Product state",
    );
    expect(container?.querySelector('[data-testid="uninstall-commands"]')?.textContent).toContain(
      "--remove-user-data",
    );
  });

  it("says an unrepresentable build identity is unavailable rather than guessing", async () => {
    (window as unknown as { mona: unknown }).mona = {
      updateStatus: async () => ({
        ok: false,
        error: { code: "CONFLICT", message: "the update surface is not available in this build" },
      }),
      uninstallGuide: async () => ({ ok: false, error: { code: "CONFLICT", message: "no" } }),
      stateRecovery: async () => ({ ok: false, error: { code: "CONFLICT", message: "no" } }),
    };
    await render();
    expect(text()).toContain("Build identity unavailable");
    expect(text()).toContain("the update surface is not available in this build");
    expect(text()).toContain("Uninstall facts unavailable");
    expect(text()).toContain("Recovery facts unavailable");
  });
});
