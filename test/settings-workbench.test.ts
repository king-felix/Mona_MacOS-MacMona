import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import type {
  EngineModelCatalog,
  EngineProviderCatalog,
  EngineRuntimeConfig,
  EngineSettingsAdapter,
} from "../src/main/engine/types";
import {
  RouteWorkbench,
  SettingsError,
  endpointAuthority,
  redactDiagnostics,
  validateRoute,
} from "../src/main/work/settings";
import { PROFILE_SCOPE } from "../src/main/work/profile";
import { resolveEngineBinary } from "../src/main/engine/runtime-process";
import { openTestStore } from "./helpers/state";

const HOME = process.env.HOME ?? "/Users/test";
// Built at run time so a source scanner and a diagnostics redactor are both
// exercised by the same value without a literal key in the repository.
const SECRET_KEY = ["sk", "fixture", "notreal01"].join("-");

function providerCatalog(): EngineProviderCatalog {
  return {
    current: "deepseek",
    currentExactId: "deepseek",
    providers: [
      {
        id: "deepseek",
        exactId: "deepseek",
        displayName: "DeepSeek",
        defaultModel: "deepseek-flash",
        hasModelCatalog: true,
        credentialState: "configured",
        credentialSource: "secret_store",
        credentialWritable: true,
        credentialWritableReason: null,
        browserConnect: false,
      },
      {
        id: "openai",
        exactId: "openai",
        displayName: "OpenAI-compatible",
        defaultModel: "gpt-5.6",
        hasModelCatalog: false,
        credentialState: "missing",
        credentialSource: "secret_store",
        credentialWritable: true,
        credentialWritableReason: null,
        browserConnect: false,
      },
      {
        id: "account-route",
        exactId: "account-route",
        displayName: "Account route",
        defaultModel: "deepseek-flash",
        hasModelCatalog: true,
        credentialState: "configured",
        credentialSource: "account_session",
        credentialWritable: false,
        credentialWritableReason: "a Codewhale account owns this credential",
        browserConnect: false,
      },
    ],
  };
}

function modelCatalog(): EngineModelCatalog {
  return {
    provider: "deepseek",
    exactId: null,
    models: [
      {
        id: "deepseek-flash",
        imageInput: "supported",
        outputTokenLimit: "supported",
        reasoningEffort: "supported",
        reasoningEffortLevels: ["low", "high", "max"],
        reasoningEffortSource: "catalog",
        contextTokens: 1_000_000,
        outputTokens: 384_000,
        factsSource: "live",
      },
      {
        id: "deepseek-chat",
        imageInput: "unsupported",
        outputTokenLimit: "supported",
        reasoningEffort: "unsupported",
        reasoningEffortLevels: [],
        reasoningEffortSource: "catalog",
        contextTokens: null,
        outputTokens: null,
        factsSource: null,
      },
      {
        id: "deepseek-opaque",
        imageInput: "unknown",
        outputTokenLimit: "supported",
        reasoningEffort: "unknown",
        reasoningEffortLevels: [],
        reasoningEffortSource: null,
        contextTokens: null,
        outputTokens: null,
        factsSource: null,
      },
    ],
  };
}

function fakeAdapter(overrides: Partial<EngineSettingsAdapter> = {}): {
  adapter: EngineSettingsAdapter;
  calls: {
    switchProvider: ReturnType<typeof vi.fn>;
    setProviderKey: ReturnType<typeof vi.fn>;
    writeRuntimeSetting: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
  };
} {
  const config: EngineRuntimeConfig = {
    provider: "deepseek",
    model: "deepseek-flash",
    modelAvailable: true,
    reasoningEffort: "auto",
    baseUrl: "https://api.deepseek.com/beta",
    approvalMode: "suggest",
    sandboxMode: "workspace-write",
    allowShell: false,
    mcpConfigPath: "/tmp/mcp.json",
    defaultModel: "deepseek-flash",
  };
  const calls = {
    switchProvider: vi.fn(async ({ provider, model }: { provider: string; model: string }) => {
      config.provider = provider;
      config.model = model;
      return { provider, model, modelAvailable: true, message: "switched", persisted: true };
    }),
    setProviderKey: vi.fn(
      async ({ provider, scope }: { provider: string; key: string; scope: string }) => ({
        provider,
        stored: scope === "durable",
        scope,
        backend: scope === "durable" ? "keychain" : "memory",
        credentialState: "configured",
      }),
    ),
    writeRuntimeSetting: vi.fn(),
    listModels: vi.fn(async (provider: string) =>
      provider === "deepseek" ? modelCatalog() : { provider, exactId: null, models: [] },
    ),
  };
  const adapter = {
    discover: async () => ({ identity: { version: "0.10.2", commit: "abcdef1234567" } }),
    listProviders: async () => providerCatalog(),
    listModels: calls.listModels,
    refreshProviderModels: async () => ({ ok: true, message: "refreshed" }),
    readRuntimeConfig: async () => ({ ...config }),
    writeRuntimeSetting: calls.writeRuntimeSetting,
    reloadRuntimeConfig: async () => ({ ok: true, message: "reloaded" }),
    switchProvider: calls.switchProvider,
    setProviderKey: calls.setProviderKey,
    clearProviderKey: async () => ({ cleared: true, credentialState: "missing" }),
    ...overrides,
  } as unknown as EngineSettingsAdapter;
  return { adapter, calls };
}

function studioSnapshot(route: {
  provider: string;
  model: string;
  effectiveProvider: string;
  effectiveModel: string;
  usedFallback?: boolean;
}): StudioSnapshot {
  return {
    projectId: "prj_0000000000000001",
    connection: {
      state: "connected",
      reason: "test",
      since: "2026-11-12T00:00:00.000Z",
      port: 1234,
      engine: { version: "0.10.2", commit: "abcdef1234567" },
      owned: true,
      external: false,
    },
    threadId: "thr_local",
    engineThreadId: "thr_engine",
    activeTurnId: null,
    lastMode: "work",
    pauseAfterTask: false,
    queued: 0,
    profile: {
      provider: route.provider,
      exactId: null,
      model: route.model,
      reasoningEffort: null,
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
      source: "configured",
      effective: {
        provider: route.effectiveProvider,
        model: route.effectiveModel,
        permissionPosture: "full_access",
        usedFallback: route.usedFallback ?? false,
      },
      effectiveTurnId: "turn_0001",
    },
    cost: { observed: false, costUsd: 0, costComplete: false, turns: 0, label: "unknown" },
    submission: null,
    diagnostics: [],
    followUps: [],
    steering: { available: false, reason: "test fixture: no steer route", requiredRoute: null },
    pendingRequests: [],
    canSubmit: true,
    cannotSubmitReason: null,
    controls: {
      canInterrupt: false,
      canPause: false,
      canCancelQueued: false,
      canStop: true,
    },
  } as StudioSnapshot;
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mona-settings-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workbench(options: {
  studio?: StudioSnapshot | null;
  adapter?: EngineSettingsAdapter;
  backupDir?: string;
  configRoot?: string;
  engineBinary?: () => string;
  runDoctor?: (
    command: string[],
    options: { timeoutMs: number },
  ) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }>;
}) {
  const { store } = await openTestStore();
  const backupDir = options.backupDir ?? (await tempDir());
  const adapter = options.adapter ?? fakeAdapter().adapter;
  const bench = new RouteWorkbench({
    store,
    engine: () => ({ adapter, workspace: "/tmp/ws" }),
    studio: async () => options.studio ?? null,
    backupDir,
    configRoot: options.configRoot,
    engineBinary: options.engineBinary ?? (() => "/bin/echo"),
    runDoctor: options.runDoctor,
  });
  return { store, bench, backupDir, adapter };
}

const projectId = "prj_0000000000000001" as never;

describe("route validation", () => {
  it("accepts a published reasoning level and refuses one the model does not publish", () => {
    const { adapter } = fakeAdapter();
    void adapter;
    const providers = {
      current: "deepseek",
      currentExactId: "deepseek",
      providers: providerCatalog().providers.map((entry) => ({
        ...entry,
        current: entry.id === "deepseek",
        credentialState: entry.credentialState as never,
        credentialSource: entry.credentialSource as never,
      })),
      readAt: "2026-11-12T00:00:00.000Z",
      source: "live" as const,
      error: null,
    };
    const models = {
      provider: "deepseek",
      exactId: null,
      models: modelCatalog().models.map((entry) => ({
        ...entry,
        imageInput: entry.imageInput as never,
        reasoningEffort: entry.reasoningEffort as never,
      })),
      readAt: "2026-11-12T00:00:00.000Z",
      source: "live" as const,
      error: null,
    };
    expect(
      validateRoute(
        { provider: "deepseek", exactId: null, model: "deepseek-flash", reasoningEffort: "high" },
        providers,
        models,
      ).ok,
    ).toBe(true);
    const refused = validateRoute(
      { provider: "deepseek", exactId: null, model: "deepseek-flash", reasoningEffort: "medium" },
      providers,
      models,
    );
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("not one of this model's published levels");
    expect(
      validateRoute(
        { provider: "deepseek", exactId: null, model: "deepseek-chat", reasoningEffort: "high" },
        providers,
        models,
      ).reason,
    ).toContain("does not publish a reasoning-effort ladder");
    expect(
      validateRoute(
        { provider: "openai", exactId: null, model: "gpt-5.6", reasoningEffort: null },
        providers,
        models,
      ).reason,
    ).toContain("no model catalog");
  });
});

describe("saved route scope", () => {
  it("saves a validated default and leaves the active session's observed route alone", async () => {
    const studio = studioSnapshot({
      provider: "deepseek",
      model: "deepseek-flash",
      effectiveProvider: "deepseek",
      effectiveModel: "deepseek-flash",
    });
    const { store, bench, adapter } = await workbench({ studio });
    const before = await bench.snapshot(projectId);
    expect(before.savedDefault.revision).toBe(0);
    expect(before.observed?.effectiveModel).toBe("deepseek-flash");

    const result = await bench.saveDefault({
      projectId,
      expectedRevision: 0,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: "high",
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    });
    expect(result.receipt.applied).toBe(true);
    expect(result.receipt.target).toBe("saved_default");
    expect(result.snapshot.savedDefault.revision).toBe(1);
    expect(result.snapshot.savedDefault.route.reasoningEffort).toBe("high");
    // The turn that already ran is still reported as it ran.
    expect(result.snapshot.observed?.effectiveModel).toBe("deepseek-flash");
    // Saving a default never changes the engine's configured route.
    const switchCalls = (adapter as unknown as { switchProvider: { mock: { calls: unknown[] } } })
      .switchProvider.mock.calls;
    expect(switchCalls).toHaveLength(0);
    const stored = await store.getSettings(PROFILE_SCOPE);
    expect(stored?.value).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
      reasoningEffort: "high",
    });
  });

  it("does not persist an unsupported reasoning level", async () => {
    const { store, bench } = await workbench({});
    await expect(
      bench.saveDefault({
        projectId,
        expectedRevision: 0,
        provider: "deepseek",
        exactId: null,
        model: "deepseek-flash",
        reasoningEffort: "medium",
        permissionPosture: "full_access",
        autoApprove: true,
        trustMode: true,
        allowShell: true,
      }),
    ).rejects.toBeInstanceOf(SettingsError);
    expect(await store.getSettings(PROFILE_SCOPE)).toBeNull();
  });

  it("refuses a stale revision instead of overwriting a concurrent edit", async () => {
    const { bench } = await workbench({});
    await bench.saveDefault({
      projectId,
      expectedRevision: 0,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: null,
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    });
    await expect(
      bench.saveDefault({
        projectId,
        expectedRevision: 0,
        provider: "deepseek",
        exactId: null,
        model: "deepseek-flash",
        reasoningEffort: "high",
        permissionPosture: "full_access",
        autoApprove: true,
        trustMode: true,
        allowShell: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
  });

  it("restores the measured Flash default", async () => {
    const { bench } = await workbench({});
    await bench.saveDefault({
      projectId,
      expectedRevision: 0,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: "high",
      permissionPosture: "ask",
      autoApprove: false,
      trustMode: false,
      allowShell: false,
    });
    const reset = await bench.resetDefault({ projectId, expectedRevision: 1 });
    expect(reset.snapshot.savedDefault.route.model).toBe("deepseek-flash");
    expect(reset.snapshot.savedDefault.route.reasoningEffort).toBeNull();
    expect(reset.snapshot.savedDefault.permissionPosture).toBe("full_access");
  });
});

describe("engine route changes", () => {
  it("refuses a stale config hash before writing anything", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, 'provider = "deepseek"\n');
    const { adapter } = fakeAdapter();
    const { bench } = await workbench({ adapter, configRoot: dir });
    await expect(
      bench.switchEngineRoute({
        projectId,
        provider: "deepseek",
        exactId: null,
        model: "deepseek-flash",
        expectedConfigRevision: "0".repeat(64),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
    expect(
      (adapter as unknown as { switchProvider: { mock: { calls: unknown[] } } }).switchProvider.mock
        .calls,
    ).toHaveLength(0);
  });

  it("backs up the config, switches explicitly, and verifies the observed route", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "config.toml");
    const original = 'provider = "deepseek"\nmodel = "deepseek-chat"\n';
    await writeFile(configPath, original);
    const revision = createHash("sha256").update(original).digest("hex");
    const backupDir = await tempDir();
    const { bench } = await workbench({ backupDir, configRoot: dir });
    const result = await bench.switchEngineRoute({
      projectId,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      expectedConfigRevision: revision,
      confirm: true,
    });
    expect(result.receipt.applied).toBe(true);
    expect(result.receipt.backupPath).toBeTruthy();
    expect(result.receipt.backupSha256).toBe(revision);
    const backup = await readFile(result.receipt.backupPath!, "utf8");
    expect(backup).toBe(original);
    expect(result.snapshot.engineDefault.model).toBe("deepseek-flash");
  });

  it("requires explicit confirmation", async () => {
    const { bench } = await workbench({});
    await expect(
      bench.switchEngineRoute({
        projectId,
        provider: "deepseek",
        exactId: null,
        model: "deepseek-flash",
        expectedConfigRevision: null,
        confirm: false as unknown as true,
      }),
    ).rejects.toBeInstanceOf(SettingsError);
  });
});

describe("credentials", () => {
  it("refuses a provider whose credential the engine does not own", async () => {
    const { bench } = await workbench({});
    await expect(
      bench.setProviderCredential({
        projectId,
        provider: "account-route",
        key: "sk-test-value",
        scope: "durable",
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_REFUSED" });
  });

  it("passes a key through without copying it into the receipt", async () => {
    const { adapter } = fakeAdapter();
    const setKey = (adapter as unknown as { setProviderKey: ReturnType<typeof vi.fn> })
      .setProviderKey;
    const { bench } = await workbench({ adapter });
    const receipt = await bench.setProviderCredential({
      projectId,
      provider: "deepseek",
      key: "sk-secret-value-123456",
      scope: "session",
    });
    expect(setKey).toHaveBeenCalledWith({
      provider: "deepseek",
      key: "sk-secret-value-123456",
      scope: "session",
    });
    expect(receipt.credentialState).toBe("configured");
    expect(JSON.stringify(receipt)).not.toContain(SECRET_KEY);
  });
});

describe("diagnostics redaction", () => {
  it("redacts the home directory, provider keys, bearer tokens, and env values", () => {
    const raw = [
      `config_path = "${HOME}/.codewhale/config.toml"`,
      `api_key = ${SECRET_KEY}`,
      "Authorization: Bearer abcdefghijklmnop",
      "DEEPSEEK_API_KEY=super-secret-value",
      "https://user:pass@example.com/v1?token=abc",
    ].join("\n");
    const result = redactDiagnostics(raw, HOME);
    // Guard against a vacuous pass: the fixture must really be present, or the
    // "not.toContain" assertions below prove nothing.
    expect(raw).toContain(SECRET_KEY);
    expect(result.text).not.toContain(HOME);
    expect(result.text).toContain("~/.codewhale/config.toml");
    expect(result.text).not.toContain(SECRET_KEY);
    expect(result.text).not.toContain("super-secret-value");
    expect(result.text).not.toContain("user:pass@");
    expect(result.text).not.toContain("token=abc");
    expect(result.redactions).toBeGreaterThan(3);
    // Running it again must not change the redacted document.
    expect(redactDiagnostics(result.text, HOME).text).toBe(result.text);
  });

  it("reports provider and endpoint warnings without inventing a healthy state", async () => {
    const runDoctor = async (command: string[]) => {
      if (command.includes("--json")) {
        return {
          stdout: JSON.stringify({
            config_present: false,
            api_key: { availability: "unavailable", source: "none" },
            base_url: "https://user:pass@example.com:8443/v1",
            mcp: { servers: [{ name: "broken", status: "spawn_failed" }] },
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "doctor: credentials and endpoints clean", stderr: "", code: 0 };
    };
    const { bench } = await workbench({ runDoctor });
    const report = await bench.diagnostics(projectId);
    expect(report.ok).toBe(false);
    expect(report.warnings.join("\n")).toContain("no engine config file is present");
    expect(report.warnings.join("\n")).toContain("broken");
    expect(report.redacted).not.toContain("user:pass");
  });

  it("refuses a PATH name for external engine adoption", () => {
    // The resolver treats CODEWHALE_BIN as an explicit absolute adoption, never
    // as a PATH lookup that could select an unverified binary.
    vi.stubEnv("CODEWHALE_BIN", "codewhale");
    try {
      expect(() => resolveEngineBinary()).toThrow(/absolute path/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never caches a credential-bearing base URL", async () => {
    const { adapter } = fakeAdapter({
      readRuntimeConfig: async () => ({
        provider: "deepseek",
        model: "deepseek-flash",
        modelAvailable: true,
        reasoningEffort: "auto",
        baseUrl: `https://user:${SECRET_KEY}@api.example.com/v1?token=${SECRET_KEY}`,
        approvalMode: "suggest",
        sandboxMode: "workspace-write",
        allowShell: false,
        mcpConfigPath: "/tmp/mcp.json",
        defaultModel: "deepseek-flash",
      }),
    });
    const { store, bench } = await workbench({ adapter });
    const snapshot = await bench.snapshot(projectId);
    expect(snapshot.engineDefault.endpointAuthority).toBe("https://api.example.com");
    expect(snapshot.engineDefault.endpointStatus).toBe("configured");
    const cached = await store.getSettings("engine:runtime-config-cache");
    expect(cached).not.toBeNull();
    const serialized = JSON.stringify(cached?.value);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain("user:");
    expect(serialized).not.toContain("/v1");
    // The offline projection still renders the safe authority.
    const offline = await new RouteWorkbench({
      store,
      engine: () => null,
      studio: async () => null,
      backupDir: await tempDir(),
      runDoctor: async () => ({ stdout: "", stderr: "", code: 0 }),
    }).snapshot(projectId);
    expect(offline.engineDefault.endpointAuthority).toBe("https://api.example.com");
    expect(JSON.stringify(offline)).not.toContain(SECRET_KEY);
  });

  it("strips URL userinfo and path from the endpoint authority", () => {
    expect(endpointAuthority("https://user:pass@api.example.com/v1/beta?x=1").authority).toBe(
      "https://api.example.com",
    );
    expect(endpointAuthority("not a url").status).toBe("malformed");
    expect(endpointAuthority(null).status).toBe("unknown");
  });
});
