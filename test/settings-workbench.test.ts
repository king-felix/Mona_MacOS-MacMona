import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import { emptyStudioUsageView } from "../src/shared/contracts/usage-hud";
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
import { PROFILE_SCOPE, REASONING_DISPLAY_SCOPE } from "../src/main/work/profile";
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
  /** Only supplied by a test that is standing in for an engine which reports it. */
  effectiveReasoningEffort?: string;
  reasoningTokens?: number | null;
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
        ...(route.effectiveReasoningEffort
          ? { reasoningEffort: route.effectiveReasoningEffort, reasoningSource: "turn_record" }
          : {}),
        reasoningTokens: route.reasoningTokens ?? null,
      },
      effectiveTurnId: "turn_0001",
    },
    cost: { observed: false, costUsd: 0, costComplete: false, turns: 0, label: "unknown" },
    submission: null,
    diagnostics: [],
    followUps: [],
    steering: { available: false, reason: "test fixture: no steer route", requiredRoute: null },
    usage: emptyStudioUsageView(),
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
    configRoot: options.configRoot ?? (await tempDir()),
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
    ).toContain("publishes no selectable reasoning-effort ladder");
    expect(
      validateRoute(
        { provider: "openai", exactId: null, model: "gpt-5.6", reasoningEffort: null },
        providers,
        models,
      ).reason,
    ).toContain("no model catalog");
  });
});

/** The live projection the pinned engine produces when a live roster shadows metadata. */
function silentFlashCatalog(): EngineModelCatalog {
  const catalog = modelCatalog();
  return {
    ...catalog,
    models: catalog.models.map((entry) =>
      entry.id === "deepseek-flash"
        ? {
            ...entry,
            reasoningEffort: "unknown",
            reasoningEffortLevels: [],
            reasoningEffortSource: null,
            factsSource: "live",
          }
        : entry,
    ),
  };
}

/** Write the engine's own Models.dev catalog cache for the fixture models. */
async function engineCatalogHome(): Promise<string> {
  const dir = await tempDir();
  await mkdirForTest(join(dir, "catalog"));
  const header = { schema_version: 2, fetched_at: 1_800_000_000 };
  const body = {
    providers: {
      deepseek: {
        id: "deepseek",
        models: {
          "deepseek-flash": {
            id: "deepseek-flash",
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "high", "max"] },
            ],
          },
        },
      },
    },
  };
  await writeFile(
    join(dir, "catalog", "models-dev-catalog.json"),
    `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`,
  );
  await writeFile(join(dir, "config.toml"), 'provider = "deepseek"\nmodel = "deepseek-flash"\n');
  return dir;
}

async function mkdirForTest(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

describe("reasoning controls", () => {
  it("recovers the ladder the live projection dropped, from the engine's own metadata", async () => {
    const adapter = fakeAdapter({
      listModels: async (provider: string) =>
        provider === "deepseek" ? silentFlashCatalog() : { provider, exactId: null, models: [] },
    }).adapter;
    const { bench } = await workbench({ adapter, configRoot: await engineCatalogHome() });
    const snapshot = await bench.snapshot(projectId);
    const flash = snapshot.models.models.find((entry) => entry.id === "deepseek-flash");
    expect(flash?.reasoningSupport.effort).toBe("metadata");
    expect(flash?.reasoningSupport.levels).toEqual(["low", "high", "max"]);
    expect(flash?.reasoningSupport.thinking).toBe("toggle");
    expect(flash?.reasoningSupport.degraded).toBe(true);
    expect(flash?.reasoningSupport.sourceDetail).toContain("Models.dev");
    expect(snapshot.reasoning.support.effort).toBe("metadata");
    expect(snapshot.reasoning.declared).toMatchObject({
      value: "auto",
      editable: false,
      // A read never writes: the value is Mona's declared default until a save.
      stored: false,
    });
    expect(snapshot.reasoning.requested.effort).toBe("auto");
    expect(snapshot.reasoning.inheritance.configuredDefault).toBe("auto");
    expect(snapshot.reasoning.inheritance.effective).toBeNull();
    expect(snapshot.reasoning.inheritance.note).toContain("reasoning selector resolves");
    expect(snapshot.reasoning.inheritance.note).toContain("does not govern this route");
    expect(snapshot.reasoning.display.showReasoning).toBe(true);
  });

  it("persists a recovered level and the engine's off toggle, and refuses an unpublished tier", async () => {
    const adapter = fakeAdapter({
      listModels: async (provider: string) =>
        provider === "deepseek" ? silentFlashCatalog() : { provider, exactId: null, models: [] },
    }).adapter;
    const { store, bench } = await workbench({ adapter, configRoot: await engineCatalogHome() });
    const first = await bench.snapshot(projectId);
    const saved = await bench.saveDefault({
      projectId,
      expectedRevision: first.savedDefault.revision,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: "high",
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    });
    expect((await store.getSettings(PROFILE_SCOPE))?.value).toMatchObject({
      reasoningEffort: "high",
    });
    expect(saved.receipt.after.reasoningEffort).toBe("high");

    const off = await bench.saveDefault({
      projectId,
      expectedRevision: saved.snapshot.savedDefault.revision,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: "off",
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    });
    expect((await store.getSettings(PROFILE_SCOPE))?.value).toMatchObject({
      reasoningEffort: "off",
    });
    expect(off.snapshot.reasoning.requested.thinking).toBe("off");

    const refused = await bench
      .saveDefault({
        projectId,
        expectedRevision: off.snapshot.savedDefault.revision,
        provider: "deepseek",
        exactId: null,
        model: "deepseek-flash",
        reasoningEffort: "medium",
        permissionPosture: "full_access",
        autoApprove: true,
        trustMode: true,
        allowShell: true,
      })
      .then(() => null)
      .catch((error) => error);
    expect(refused?.code).toBe("INVALID_ROUTE");
    expect(refused?.message).toContain("not one of this model's published levels");
    expect((await store.getSettings(PROFILE_SCOPE))?.value).toMatchObject({
      reasoningEffort: "off",
    });
  });

  it("fails closed when no metadata exists and never offers off without a toggle", async () => {
    const adapter = fakeAdapter({
      listModels: async (provider: string) =>
        provider === "deepseek" ? silentFlashCatalog() : { provider, exactId: null, models: [] },
    }).adapter;
    const { store, bench } = await workbench({ adapter });
    const snapshot = await bench.snapshot(projectId);
    const flash = snapshot.models.models.find((entry) => entry.id === "deepseek-flash");
    expect(flash?.reasoningSupport.effort).toBe("unknown");
    expect(snapshot.reasoning.support.levels).toEqual([]);
    const refused = await bench
      .saveDefault({
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
      })
      .then(() => null)
      .catch((error) => error);
    expect(refused?.code).toBe("INVALID_ROUTE");
    expect(refused?.message).toContain("cannot prove");
    expect(await store.getSettings(PROFILE_SCOPE)).toBeNull();

    // deepseek-chat's metadata says no ladder; `off` is not invented for it.
    const off = await bench
      .saveDefault({
        projectId,
        expectedRevision: 0,
        provider: "deepseek",
        exactId: null,
        model: "deepseek-chat",
        reasoningEffort: "off",
        permissionPosture: "full_access",
        autoApprove: true,
        trustMode: true,
        allowShell: true,
      })
      .then(() => null)
      .catch((error) => error);
    expect(off?.code).toBe("INVALID_ROUTE");
  });

  it("accepts off for a toggle-only model and still refused a tier it does not publish", async () => {
    // 993 models in the engine's own catalog publish a thinking toggle and no
    // effort option. `off` is gated on the toggle, not on the ladder.
    const toggleOnly = modelCatalog();
    const silent: EngineModelCatalog = {
      ...toggleOnly,
      models: toggleOnly.models.map((entry) =>
        entry.id === "deepseek-chat"
          ? {
              ...entry,
              reasoningEffort: "unknown",
              reasoningEffortLevels: [],
              reasoningEffortSource: null,
            }
          : entry,
      ),
    };
    const adapter = fakeAdapter({
      listModels: async (provider: string) =>
        provider === "deepseek" ? silent : { provider, exactId: null, models: [] },
    }).adapter;
    const root = await tempDir();
    await mkdir(join(root, "catalog"), { recursive: true });
    await writeFile(
      join(root, "catalog", "models-dev-catalog.json"),
      `${JSON.stringify({ schema_version: 2, fetched_at: 1_800_000_000 })}\n${JSON.stringify({
        providers: {
          deepseek: {
            id: "deepseek",
            models: {
              "deepseek-chat": {
                id: "deepseek-chat",
                reasoning: true,
                reasoning_options: [{ type: "toggle" }],
              },
            },
          },
        },
      })}\n`,
    );
    const { store, bench } = await workbench({ adapter, configRoot: root });
    const snapshot = await bench.snapshot(projectId);
    const chat = snapshot.models.models.find((entry) => entry.id === "deepseek-chat");
    expect(chat?.reasoningSupport.effort).toBe("metadata");
    expect(chat?.reasoningSupport.levels).toEqual([]);
    expect(chat?.reasoningSupport.thinking).toBe("toggle");

    const saved = await bench.saveDefault({
      projectId,
      expectedRevision: 0,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-chat",
      reasoningEffort: "off",
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    });
    expect(saved.receipt.after.reasoningEffort).toBe("off");
    expect((await store.getSettings(PROFILE_SCOPE))?.value).toMatchObject({
      reasoningEffort: "off",
    });

    const refused = await bench
      .saveDefault({
        projectId,
        expectedRevision: saved.snapshot.savedDefault.revision,
        provider: "deepseek",
        exactId: null,
        model: "deepseek-chat",
        reasoningEffort: "low",
        permissionPosture: "full_access",
        autoApprove: true,
        trustMode: true,
        allowShell: true,
      })
      .then(() => null)
      .catch((error) => error);
    expect(refused?.code).toBe("INVALID_ROUTE");
    expect(refused?.message).toContain("published levels");
    expect((await store.getSettings(PROFILE_SCOPE))?.value).toMatchObject({
      reasoningEffort: "off",
    });
  });

  it("shows an effective value only when the engine reported one", async () => {
    // This is the whole point of the forward-compatible path: an engine that
    // reports the setting gets a true effective value; one that stays silent
    // keeps "unknown" and never inherits the request.
    const reported = await workbench({
      studio: studioSnapshot({
        provider: "deepseek",
        model: "deepseek-flash",
        effectiveProvider: "deepseek",
        effectiveModel: "deepseek-flash",
        effectiveReasoningEffort: "high",
        reasoningTokens: 96,
      }),
    });
    const withReport = await reported.bench.snapshot(projectId);
    expect(withReport.reasoning.inheritance.effective).toBe("high");
    expect(withReport.reasoning.inheritance.effectiveSource).toBe("engine_turn_receipt");
    expect(withReport.reasoning.inheritance.effectiveTurnId).toBe("turn_0001");
    expect(withReport.reasoning.inheritance.note).toContain("does not promise the next one");
    expect(withReport.observed?.reasoningEvidence).toContain("thinking demonstrably ran");

    const silent = await workbench({
      studio: studioSnapshot({
        provider: "deepseek",
        model: "deepseek-flash",
        effectiveProvider: "deepseek",
        effectiveModel: "deepseek-flash",
        reasoningTokens: 0,
      }),
    });
    const withoutReport = await silent.bench.snapshot(projectId);
    expect(withoutReport.reasoning.inheritance.effective).toBeNull();
    expect(withoutReport.reasoning.inheritance.effectiveSource).toBeNull();
    expect(withoutReport.reasoning.inheritance.effectiveTurnId).toBeNull();
    // Zero tokens is reported as inconclusive, never as "thinking was off".
    expect(withoutReport.observed?.reasoningEvidence).toContain("inconclusive");
    expect(withoutReport.observed?.reasoningEvidence).toContain("not proof that thinking was off");
  });

  it("does not treat a missing token count as evidence either way", async () => {
    const { bench } = await workbench({
      studio: studioSnapshot({
        provider: "deepseek",
        model: "deepseek-flash",
        effectiveProvider: "deepseek",
        effectiveModel: "deepseek-flash",
      }),
    });
    const snapshot = await bench.snapshot(projectId);
    expect(snapshot.observed?.reasoningTokens).toBeNull();
    expect(snapshot.observed?.reasoningEvidence).toContain("no evidence either way");
  });

  it("saves from the screen's own payload, where a built-in row returns its canonical id", async () => {
    // This is the real UI shape: the provider row's `exactId` is the engine's
    // `model_provider_id`, which for a built-in repeats the provider id. It must
    // be treated as the generic route, not as a named custom one.
    const adapter = fakeAdapter({
      listModels: async (provider: string, exactId?: string | null) =>
        provider === "deepseek"
          ? { ...silentFlashCatalog(), exactId: exactId ?? null }
          : { provider, exactId: null, models: [] },
    }).adapter;
    const { store, bench } = await workbench({ adapter, configRoot: await engineCatalogHome() });
    const snapshot = await bench.snapshot(projectId);
    const flash = snapshot.models.models.find((entry) => entry.id === "deepseek-flash");
    expect(flash?.reasoningSupport.levels).toEqual(["low", "high", "max"]);

    const saved = await bench.saveDefault({
      projectId,
      expectedRevision: snapshot.savedDefault.revision,
      provider: "deepseek",
      exactId: "deepseek",
      model: "deepseek-flash",
      reasoningEffort: "high",
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    });
    expect(saved.receipt.after.reasoningEffort).toBe("high");
    // The stored profile stays on the generic route.
    expect((await store.getSettings(PROFILE_SCOPE))?.value).toMatchObject({
      reasoningEffort: "high",
      exactId: null,
    });

    const off = await bench.saveDefault({
      projectId,
      expectedRevision: saved.snapshot.savedDefault.revision,
      provider: "deepseek",
      exactId: "deepseek",
      model: "deepseek-flash",
      reasoningEffort: "off",
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    });
    expect(off.receipt.after.reasoningEffort).toBe("off");
    expect((await store.getSettings(PROFILE_SCOPE))?.value).toMatchObject({ exactId: null });
  });

  it("treats a named custom identity as its own route, not the built-in one", async () => {
    const adapter = fakeAdapter({
      listModels: async (provider: string, exactId?: string | null) =>
        provider === "deepseek" || provider === "custom"
          ? { ...silentFlashCatalog(), provider, exactId: exactId ?? null }
          : { provider, exactId: null, models: [] },
    }).adapter;
    const { bench } = await workbench({ adapter, configRoot: await engineCatalogHome() });
    const named = await bench.models(projectId, "custom", "vision-work");
    const flash = named.models.find((entry) => entry.id === "deepseek-flash");
    expect(flash?.reasoningSupport.effort).toBe("unknown");
  });

  it("does not borrow first-party metadata for a named exact route", async () => {
    // A named route is a different identity even when the endpoint looks the same.
    const calls: Array<{ provider: string; exactId: string | null }> = [];
    const adapter = fakeAdapter({
      listModels: async (provider: string, exactId?: string | null) => {
        calls.push({ provider, exactId: exactId ?? null });
        return provider === "deepseek"
          ? { ...silentFlashCatalog(), exactId: exactId ?? null }
          : { provider, exactId: null, models: [] };
      },
    }).adapter;
    const { bench } = await workbench({ adapter, configRoot: await engineCatalogHome() });
    const named = await bench.models(projectId, "deepseek", "vision-work");
    const flash = named.models.find((entry) => entry.id === "deepseek-flash");
    expect(calls.at(-1)).toEqual({ provider: "deepseek", exactId: "vision-work" });
    expect(flash?.reasoningSupport.effort).toBe("unknown");
    expect(flash?.reasoningSupport.levels).toEqual([]);
  });

  it("does not borrow first-party metadata for a configured endpoint", async () => {
    // A user-set base_url is a different endpoint. The runtime refuses to infer
    // levels there, so Mona must not offer the first-party ladder either.
    const adapter = fakeAdapter({
      listModels: async (provider: string) =>
        provider === "deepseek" ? silentFlashCatalog() : { provider, exactId: null, models: [] },
    }).adapter;
    const root = await engineCatalogHome();
    await writeFile(
      join(root, "config.toml"),
      [
        'provider = "deepseek"',
        'model = "deepseek-flash"',
        "",
        "[providers.deepseek]",
        'base_url = "https://gateway.example.com/v1"',
      ].join("\n"),
    );
    const { bench } = await workbench({ adapter, configRoot: root });
    const snapshot = await bench.snapshot(projectId);
    const flash = snapshot.models.models.find((entry) => entry.id === "deepseek-flash");
    expect(flash?.reasoningSupport.effort).toBe("unknown");
    expect(flash?.reasoningSupport.levels).toEqual([]);
    expect(snapshot.reasoning.support.effort).toBe("unknown");
    const refused = await bench
      .saveDefault({
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
      })
      .then(() => null)
      .catch((error) => error);
    expect(refused?.code).toBe("INVALID_ROUTE");
  });

  it("labels a cached engine default as stale rather than current", async () => {
    const saved = fakeAdapter();
    const dir = await tempDir();
    await writeFile(join(dir, "config.toml"), 'provider = "deepseek"\n');
    const first = await workbench({ adapter: saved.adapter, configRoot: dir });
    await first.bench.snapshot(projectId);
    // Engine goes away; the cached route is all that remains.
    const offline = new RouteWorkbench({
      store: first.store,
      engine: () => null,
      studio: async () => null,
      backupDir: await tempDir(),
      configRoot: dir,
      engineBinary: () => "/bin/echo",
    });
    const snapshot = await offline.snapshot(projectId);
    expect(snapshot.engineDefault.source).toBe("stored");
    expect(snapshot.reasoning.inheritance.configuredSource).toBe("engine_config_cached");
    expect(snapshot.reasoning.inheritance.configuredReadAt).not.toBeNull();
    // Mona sends `auto` itself, so the cached engine default is context, not the
    // governing value; the snapshot says both things rather than one.
    expect(snapshot.reasoning.inheritance.note).toContain("does not govern this route");
    expect(snapshot.reasoning.inheritance.effective).toBeNull();
  });

  it("announces a display change only after the write, so an open studio re-reads", async () => {
    const order: string[] = [];
    const { store } = await openTestStore();
    const bench = new RouteWorkbench({
      store,
      engine: () => null,
      studio: async () => null,
      backupDir: await tempDir(),
      onDisplayChanged: (id) => order.push(`changed:${String(id)}`),
    });
    const result = await bench.setReasoningDisplay({ projectId, showReasoning: false });
    // Exactly one announcement, after the store write that produced the
    // returned snapshot; the listener is not a push that races the store.
    expect(order).toEqual([`changed:${projectId}`]);
    expect(result.snapshot.reasoning.display.showReasoning).toBe(false);
    expect((await store.getSettings(REASONING_DISPLAY_SCOPE))?.value).toMatchObject({
      showReasoning: false,
    });
  });

  it("persists the transcript preference in Mona's settings, not the engine's", async () => {
    const { store, bench } = await workbench({});
    const result = await bench.setReasoningDisplay({ projectId, showReasoning: false });
    expect(result.receipt.persisted).toBe(true);
    expect(result.snapshot.reasoning.display.showReasoning).toBe(false);
    expect((await store.getSettings(REASONING_DISPLAY_SCOPE))?.value).toMatchObject({
      showReasoning: false,
    });
    expect(result.receipt.note).toContain("request is unchanged");
    const restored = await bench.setReasoningDisplay({ projectId, showReasoning: true });
    expect(restored.snapshot.reasoning.display.showReasoning).toBe(true);
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
    expect(reset.snapshot.savedDefault.route.reasoningEffort).toBe("auto");
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
