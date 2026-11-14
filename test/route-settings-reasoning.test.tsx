// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RouteSettings } from "../src/renderer/shell/RouteSettings";
import type { SettingsSnapshot } from "../src/shared/contracts/settings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const calls: Array<{ method: string; input: unknown }> = [];

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  const support = {
    effort: "metadata" as const,
    levels: ["low", "high", "max"],
    thinking: "toggle" as const,
    source: "engine_catalog_cache" as const,
    sourceDetail: "the engine's Models.dev catalog cache, fetched 2026-11-14T18:01:32.000Z",
    degraded: true,
    note: "The engine's live catalog projection omitted this model's metadata, but the engine's own Models.dev catalog publishes low, high, max for it. Mona offers only those published values.",
  };
  return {
    projectId: "prj_0000000000000001",
    runtime: "connected",
    runtimeNote: "live",
    savedDefault: {
      route: {
        provider: "deepseek",
        exactId: null,
        model: "deepseek-flash",
        reasoningEffort: "auto",
      },
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
      revision: 1,
      source: "configured",
      updatedAt: "2026-11-14T00:00:00.000Z",
      validation: {
        ok: true,
        checkedAt: "2026-11-14T00:00:00.000Z",
        reason: null,
        catalog: "live",
      },
    },
    engineDefault: {
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: "auto",
      endpointAuthority: "https://api.deepseek.com",
      endpointStatus: "configured",
      approvalMode: "suggest",
      sandboxMode: "workspace-write",
      allowShell: false,
      readAt: "2026-11-14T00:00:00.000Z",
      source: "live",
      error: null,
    },
    observed: null,
    providers: {
      current: "deepseek",
      currentExactId: "deepseek",
      providers: [
        {
          id: "deepseek",
          exactId: "deepseek",
          displayName: "DeepSeek",
          defaultModel: "deepseek-flash",
          hasModelCatalog: true,
          current: true,
          credentialState: "configured",
          credentialSource: "secret_store",
          credentialWritable: true,
          credentialWritableReason: null,
          browserConnect: false,
        },
      ],
      readAt: "2026-11-14T00:00:00.000Z",
      source: "live",
      error: null,
    },
    models: {
      provider: "deepseek",
      exactId: null,
      models: [
        {
          id: "deepseek-flash",
          imageInput: "supported",
          reasoningEffort: "unknown",
          reasoningEffortLevels: [],
          reasoningEffortSource: null,
          contextTokens: 1_000_000,
          outputTokens: 384_000,
          factsSource: "live",
          reasoningSupport: support,
        },
      ],
      readAt: "2026-11-14T00:00:00.000Z",
      source: "live",
      error: null,
    },
    reasoning: {
      support,
      requested: { effort: "auto", thinking: "unspecified" },
      inheritance: {
        configuredDefault: "auto",
        configuredSource: "engine_config",
        configuredReadAt: null,
        effective: null,
        effectiveSource: null,
        effectiveTurnId: null,
        note: "Mona declares `auto` and sends it on every new thread and turn, so the engine's reasoning selector resolves a concrete tier for each turn. That tier is not reported back, so the effective value stays unknown; the request is not proof of what the provider did. Because Mona sends `auto` explicitly, the engine's own configured default does not govern this route.",
      },
      declared: {
        value: "auto",
        editable: false,
        stored: true,
        note: "Auto is the engine's own default: its reasoning selector resolves a concrete tier for each turn. Mona sends it explicitly and does not offer a different setting here, so the value is declared rather than implied.",
      },
      display: {
        showReasoning: true,
        note: "Mona renders the reasoning items the engine streams. This preference changes Mona's transcript only; it is never sent to the engine and it does not change thinking or effort.",
      },
    },
    policy: { autoRoute: false, fallback: "refuse", note: "no router" },
    engineSelection: {
      source: "bundled",
      path: "/tmp/engine",
      sha256: null,
      version: "0.10.2",
      commit: "ff466b2ed0bf",
      note: "bundled",
    },
    engineConfigRevision: null,
    configPath: "/tmp/config.toml",
    settingsPath: "/tmp/settings.toml",
    settingsRevision: 1,
    ...overrides,
  };
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  calls.length = 0;
  Object.defineProperty(window, "mona", {
    writable: true,
    value: {
      settingsSnapshot: async () => ({ ok: true as const, value: snapshot() }),
      settingsModels: async () => ({ ok: true as const, value: snapshot().models }),
      saveSavedRoute: async (input: unknown) => {
        calls.push({ method: "save", input });
        return {
          ok: true as const,
          value: {
            receipt: {
              applied: true,
              target: "saved_default",
              before: {
                provider: "deepseek",
                exactId: null,
                model: "deepseek-flash",
                reasoningEffort: null,
              },
              after: {
                provider: "deepseek",
                exactId: null,
                model: "deepseek-flash",
                reasoningEffort: "low",
              },
              persisted: true,
              requiresReload: false,
              backupPath: null,
              backupSha256: null,
              revisionBefore: "1",
              revisionAfter: "2",
              verification: "ok",
              note: "saved",
            },
            snapshot: snapshot(),
          },
        };
      },
      setReasoningDisplay: async (input: { showReasoning: boolean }) => {
        calls.push({ method: "display", input });
        return {
          ok: true as const,
          value: {
            receipt: { persisted: true, showReasoning: input.showReasoning, note: "stored" },
            snapshot: snapshot(),
          },
        };
      },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <RouteSettings projectId={"prj_0000000000000001" as never} onOpenStudio={() => undefined} />,
    );
  });
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button ${label} not found`);
  return found;
}

describe("reasoning controls", () => {
  it("declares Auto as the setting and offers no control to change it", async () => {
    await render();
    const text = container?.textContent ?? "";
    expect(container?.querySelector('[data-testid="reasoning-declared"]')?.textContent).toBe(
      "auto",
    );
    expect(text).toContain("read-only");
    expect(text).toContain("no control to change it");
    expect(text).toContain("reasoning selector resolves a concrete tier");
    expect(text).toContain("does not govern this route");
    // No reasoning-level control of any kind is present.
    expect(text).not.toContain("Engine decides");
    expect(text).not.toContain("Model default (omit)");
    for (const label of ["Off", "On", "medium", "high"]) {
      expect(
        Array.from(container?.querySelectorAll("button") ?? []).map((b) => b.textContent?.trim()),
      ).not.toContain(label);
    }
    expect(container?.querySelector('select[label="Reasoning effort"]')).toBeNull();
  });

  it("saves the declared value even though the screen no longer lets it be picked", async () => {
    await render();
    await act(async () => button("Save default").click());
    await settle();
    expect(calls.find((call) => call.method === "save")?.input).toMatchObject({
      reasoningEffort: "auto",
    });
  });

  it("reports the published tiers as information, not as choices", async () => {
    await render();
    const text = container?.textContent ?? "";
    expect(text).toContain("the effort tiers low, high, max");
    expect(text).toContain("informational only");
    expect(text).toContain("engine catalog metadata");
  });

  it("shows an engine-reported effective value, with its source and evidence", async () => {
    const base = snapshot();
    const next = {
      ...base,
      observed: {
        threadId: "thr_engine",
        turnId: "turn_0001",
        requestedProvider: "deepseek",
        requestedModel: "deepseek-flash",
        effectiveProvider: "deepseek",
        effectiveModel: "deepseek-flash",
        permissionPosture: "full_access",
        effectiveReasoningEffort: "high",
        effectiveReasoningSource: "requested",
        reasoningTokens: 96,
        reasoningEvidence:
          "The engine reported 96 reasoning tokens for that turn: thinking demonstrably ran.",
        usedFallback: false,
        observedAt: "2026-11-14T00:00:00.000Z",
        matchesSavedDefault: true,
      },
      reasoning: {
        ...base.reasoning,
        inheritance: {
          ...base.reasoning.inheritance,
          effective: "high",
          effectiveSource: "engine_turn_receipt" as const,
          effectiveTurnId: "turn_0001",
          note: "The runtime reported `reasoning_effort = high` for turn turn_0001. That is the value the engine parsed for that turn; it does not promise the next one.",
        },
      },
    };
    Object.defineProperty(window, "mona", {
      writable: true,
      value: {
        settingsSnapshot: async () => ({ ok: true as const, value: next }),
        settingsModels: async () => ({ ok: true as const, value: next.models }),
      },
    });
    await render();
    const text = container?.textContent ?? "";
    expect(text).toContain("effective high");
    expect(text).toContain("a fact the engine reported");
    expect(text).toContain("does not promise the next one");
    expect(container?.querySelector('[data-testid="reasoning-evidence"]')?.textContent).toContain(
      "thinking demonstrably ran",
    );
  });

  it("saves the transcript preference without touching the route", async () => {
    await render();
    const display = Array.from(
      container?.querySelectorAll<HTMLElement>('[role="switch"]') ?? [],
    ).find((element) => element.textContent?.includes("Show reasoning"));
    expect(display?.getAttribute("aria-checked")).toBe("true");
    await act(async () => (display as HTMLElement).click());
    await settle();
    const call = calls.find((entry) => entry.method === "display");
    expect(call?.input).toEqual({ projectId: "prj_0000000000000001", showReasoning: false });
  });
});
