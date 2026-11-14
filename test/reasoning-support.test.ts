import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveReasoningSupport,
  describeInheritance,
  parseEngineCatalog,
  readEngineCatalogModelFacts,
  customEndpointConfigured,
  readEngineCatalogModelFactsBatch,
} from "../src/main/work/reasoning";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function engineHome(catalog?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mona-reasoning-"));
  tempDirs.push(dir);
  if (catalog !== undefined) {
    await mkdir(join(dir, "catalog"), { recursive: true });
    const header = {
      schema_version: 2,
      fetched_at: 1_800_000_000,
      source_label: "https://models.dev/catalog.json",
    };
    await writeFile(
      join(dir, "catalog", "models-dev-catalog.json"),
      `${JSON.stringify(header)}\n${JSON.stringify(catalog)}\n`,
    );
  }
  return dir;
}

function catalogBody() {
  return {
    providers: {
      deepseek: {
        id: "deepseek",
        models: {
          "deepseek-flash": {
            id: "deepseek-flash",
            family: "deepseek-flash",
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "high", "max", "invented"] },
            ],
            canonical_model_id: "deepseek/deepseek-v4.1-flash-1017",
          },
          "deepseek-chat": {
            id: "deepseek-chat",
            reasoning: false,
          },
        },
      },
    },
  };
}

describe("engine catalog metadata", () => {
  it("reads the two-document cache and keeps only canonical published tiers", async () => {
    const root = await engineHome(catalogBody());
    const facts = await readEngineCatalogModelFacts(root, "deepseek", "deepseek-flash");
    expect(facts).not.toBeNull();
    expect(facts?.levels).toEqual(["low", "high", "max"]);
    expect(facts?.toggle).toBe(true);
    expect(facts?.canonicalModelId).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(facts?.fetchedAt).toBe(new Date(1_800_000_000_000).toISOString());
    // An unrecognized tier in the metadata is not offered.
    expect(facts?.levels).not.toContain("invented");
  });

  it("returns null for a model, provider, or file it cannot read", async () => {
    const root = await engineHome(catalogBody());
    expect(await readEngineCatalogModelFacts(root, "deepseek", "deepseek-opaque")).toBeNull();
    expect(await readEngineCatalogModelFacts(root, "openai", "deepseek-flash")).toBeNull();
    expect(
      await readEngineCatalogModelFacts(await engineHome(), "deepseek", "deepseek-flash"),
    ).toBeNull();
  });

  it("resolves a whole roster from one read, including a large provider", async () => {
    const models: Record<string, unknown> = {};
    for (let index = 0; index < 600; index += 1) {
      models[`model-${index}`] = {
        id: `model-${index}`,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      };
    }
    const root = await engineHome({ providers: { big: { id: "big", models } } });
    const ids = Object.keys(models);
    const resolved = await readEngineCatalogModelFactsBatch(root, "big", ids);
    expect(resolved.size).toBe(600);
    expect(resolved.get("model-599")?.levels).toEqual(["low", "high"]);
    // A model the metadata does not list stays null; nothing is borrowed.
    expect(resolved.get("model-absent")).toBeUndefined();
    const other = await readEngineCatalogModelFacts(root, "big", "model-absent");
    expect(other).toBeNull();
  });

  it("refuses an unreadable or newer layout instead of guessing", () => {
    expect(parseEngineCatalog("")).toBeNull();
    expect(parseEngineCatalog('{"providers":')).toBeNull();
    expect(parseEngineCatalog('{"nope":true}\n{"providers":{}}')).toBeNull();
    expect(
      parseEngineCatalog(
        JSON.stringify({ schema_version: 3, fetched_at: 1 }) +
          "\n" +
          JSON.stringify({ providers: {} }),
      ),
    ).toBeNull();
  });

  it("does not treat a silent catalog as disabled thinking", () => {
    const support = deriveReasoningSupport({
      engineState: "unknown",
      engineLevels: [],
      engineSource: null,
      facts: null,
    });
    expect(support.effort).toBe("unknown");
    expect(support.levels).toEqual([]);
    expect(support.thinking).toBe("unknown");
    expect(support.note).toContain("not the same as unsupported or disabled");
  });

  it("attributes a thinking toggle to the metadata, never to the live catalog", () => {
    const facts = {
      reasoning: true,
      levels: ["low", "high", "max"],
      toggle: true,
      canonicalModelId: null,
      fetchedAt: null,
      sourceLabel: "the engine's Models.dev catalog cache",
    };
    const published = deriveReasoningSupport({
      engineState: "supported",
      engineLevels: ["low", "high"],
      engineSource: "catalog",
      facts,
    });
    expect(published.thinking).toBe("toggle");
    expect(published.sourceDetail).toContain("Models.dev");
    expect(published.note).toContain("not from the live catalog answer");

    const unsupported = deriveReasoningSupport({
      engineState: "unsupported",
      engineLevels: [],
      engineSource: "catalog",
      facts,
    });
    expect(unsupported.thinking).toBe("toggle");
    expect(unsupported.sourceDetail).toContain("Models.dev");
    expect(unsupported.note).toContain("not from the live catalog answer");
  });

  it("prefers an explicit engine answer and marks recovered metadata as degraded", () => {
    const facts = {
      reasoning: true,
      levels: ["low", "high", "max"],
      toggle: true,
      canonicalModelId: null,
      fetchedAt: null,
      sourceLabel: "the engine's Models.dev catalog cache",
    };
    const published = deriveReasoningSupport({
      engineState: "supported",
      engineLevels: ["low", "high"],
      engineSource: "catalog",
      facts,
    });
    expect(published.effort).toBe("published");
    expect(published.levels).toEqual(["low", "high"]);
    expect(published.degraded).toBe(false);

    const unsupported = deriveReasoningSupport({
      engineState: "unsupported",
      engineLevels: [],
      engineSource: "catalog",
      facts,
    });
    expect(unsupported.effort).toBe("unsupported");
    expect(unsupported.levels).toEqual([]);
    expect(unsupported.note).toContain("not evidence that thinking is disabled");

    const recovered = deriveReasoningSupport({
      engineState: "unknown",
      engineLevels: [],
      engineSource: null,
      facts,
    });
    expect(recovered.effort).toBe("metadata");
    expect(recovered.levels).toEqual(["low", "high", "max"]);
    expect(recovered.thinking).toBe("toggle");
    expect(recovered.degraded).toBe(true);
    expect(recovered.source).toBe("engine_catalog_cache");
  });
});

describe("endpoint scoping", () => {
  it("treats the provider's own first-party config as metadata-eligible", () => {
    const toml = [
      'provider = "deepseek"',
      'model = "deepseek-flash"',
      "",
      "[stream]",
      "open_timeout_secs = 45",
    ].join("\n");
    expect(customEndpointConfigured(toml, "deepseek")).toBe(false);
    expect(customEndpointConfigured('provider = "deepseek"\nmodel = "x"\n', "deepseek")).toBe(
      false,
    );
  });

  it("refuses the fallback for a configured endpoint, top-level or per-provider", () => {
    const perProvider = [
      'provider = "deepseek"',
      "",
      "[providers.deepseek]",
      'model = "deepseek-flash"',
      'base_url = "https://gateway.example.com/v1"',
    ].join("\n");
    expect(customEndpointConfigured(perProvider, "deepseek")).toBe(true);
    // An accepted spelling of the same provider is the same route.
    expect(customEndpointConfigured(perProvider, "deepseek-cn")).toBe(false);
    expect(
      customEndpointConfigured(
        'base_url = "https://gateway.example.com"\nprovider = "deepseek"',
        "deepseek",
      ),
    ).toBe(true);
    expect(
      customEndpointConfigured(
        ["[profiles.work.providers.deepseek]", 'base_url = "https://gateway.example.com"'].join(
          "\n",
        ),
        "deepseek",
      ),
    ).toBe(true);
    // A different provider's endpoint says nothing about this one.
    expect(
      customEndpointConfigured(
        ['provider = "deepseek"', "[providers.zai]", 'base_url = "https://x"'].join("\n"),
        "deepseek",
      ),
    ).toBe(false);
  });

  it("sees a dotted key and an inline providers table as the same endpoint", () => {
    // Both are valid TOML for the same route, and the engine's own
    // `config list` prints the flattened form.
    expect(customEndpointConfigured('providers.deepseek.base_url = "https://x"', "deepseek")).toBe(
      true,
    );
    expect(
      customEndpointConfigured('providers."deepseek".base_url = "https://x"', "deepseek"),
    ).toBe(true);
    expect(
      customEndpointConfigured('providers = { deepseek = { base_url = "https://x" } }', "deepseek"),
    ).toBe(true);
    expect(
      customEndpointConfigured(
        'providers = { zai = { base_url = "https://a" }, deepseek = { base_url = "https://b" } }',
        "deepseek",
      ),
    ).toBe(true);
    // ... and the inline table only counts when it names this provider's endpoint.
    expect(
      customEndpointConfigured(
        'providers = { zai = { base_url = "https://a" } }\nprovider = "deepseek"',
        "deepseek",
      ),
    ).toBe(false);
    expect(customEndpointConfigured('providers = { deepseek = { model = "x" } }', "deepseek")).toBe(
      false,
    );
    expect(customEndpointConfigured('providers.zai.base_url = "https://x"', "deepseek")).toBe(
      false,
    );
  });

  it("fails closed when the config exists but cannot be read", () => {
    expect(customEndpointConfigured(null, "deepseek")).toBe(true);
  });
});

describe("requested versus effective", () => {
  it("explains that omission inherits the engine's configured default", () => {
    const inherited = describeInheritance({
      requested: null,
      configuredDefault: "auto",
      configuredSource: "engine_config",
    });
    expect(inherited.effective).toBeNull();
    expect(inherited.note).toContain("reasoning_effort = auto");
    expect(inherited.note).toContain("auto selector");
    expect(inherited.note).toContain("not 'thinking off'");

    const missing = describeInheritance({
      requested: null,
      configuredDefault: null,
      configuredSource: "unavailable",
    });
    expect(missing.effective).toBeNull();
    expect(missing.note).toContain("unknown");
    expect(missing.note).toContain("does not mean thinking is disabled");
  });

  it("never turns a request into an effective claim", () => {
    const requested = describeInheritance({
      requested: "high",
      configuredDefault: "auto",
      configuredSource: "engine_config",
    });
    expect(requested.effective).toBeNull();
    expect(requested.effectiveSource).toBeNull();
    expect(requested.note).toContain("not proof");
  });
});
