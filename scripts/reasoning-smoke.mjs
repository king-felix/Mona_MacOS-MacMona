#!/usr/bin/env node
// Reasoning live check: the pinned engine's live provider roster reports
// `reasoning_effort: unknown` for deepseek-flash while its own Models.dev
// catalog publishes low|high|max. This script reproduces that exact state in
// an isolated home, then proves Mona recovers the published ladder, persists a
// level, refuses an unpublished one, and keeps the transcript preference out of
// the engine. No model turn is started, so no provider charge is incurred.
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { CodewhaleAdapter } = require(join(ROOT, "dist/main/main/engine/adapter.js"));
const { MemorySubmissionStore } = require(join(ROOT, "dist/main/main/engine/submission-store.js"));
const { RouteWorkbench } = require(join(ROOT, "dist/main/main/work/settings.js"));
const { PROFILE_SCOPE, REASONING_DISPLAY_SCOPE } = require(
  join(ROOT, "dist/main/main/work/profile.js"),
);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));

// The runtime's daemon socket path has a 103-byte platform limit, so the
// isolated home must be short.
const base = await mkdtemp("/tmp/mona-reasoning-");
const home = join(base, "h");
const workspace = join(base, "w");
const codeHome = join(home, ".codewhale");
const product = join(base, "p");
await mkdir(join(codeHome, "catalog"), { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(product, { recursive: true });
await writeFile(
  join(codeHome, "config.toml"),
  'provider = "deepseek"\nmodel = "deepseek-flash"\nreasoning_effort = "auto"\n',
);

// The engine's Models.dev metadata is public, non-secret model data. Prefer the
// host's own cache — that is what the user's Mona reads — and fall back to the
// exact entries captured from it on 2026-11-14, so the check runs the same way on
// a machine that has not fetched the catalog yet. The report names which source
// was used; a fixture is never labelled as the live cache.
const modelsDevSource = join(
  process.env.HOME ?? "",
  ".codewhale",
  "catalog",
  "models-dev-catalog.json",
);
const hostCache = await stat(modelsDevSource).then(
  (info) => info.isFile(),
  () => false,
);
const modelsDevTarget = join(codeHome, "catalog", "models-dev-catalog.json");
if (hostCache) {
  await copyFile(modelsDevSource, modelsDevTarget);
} else {
  const capturedProviders = {
    deepseek: {
      id: "deepseek",
      models: {
        "deepseek-flash": {
          id: "deepseek-flash",
          family: "deepseek-flash",
          reasoning: true,
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: ["low", "high", "max"] },
          ],
          canonical_model_id: "deepseek/deepseek-v4.1-flash-1017",
        },
        "deepseek-v4-pro": {
          id: "deepseek-v4-pro",
          family: "deepseek-pro",
          reasoning: true,
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: ["low", "high", "max"] },
          ],
          canonical_model_id: "deepseek/deepseek-v4-pro-0813",
        },
      },
    },
  };
  await writeFile(
    modelsDevTarget,
    `${JSON.stringify({ schema_version: 2, fetched_at: 1_800_000_000 })}\n${JSON.stringify({ providers: capturedProviders })}\n`,
  );
}

// The user's home carries a live roster entry for this provider. Reproduce it
// with a fresh timestamp so the engine answers from live facts, not metadata.
const FINGERPRINT = "812b1f7c4a8b1af438d207c4d010794296f83296c29dcd10b8b6dd22f64c79db";
const nowSecs = Math.floor(Date.now() / 1000);
const offering = (wire_model_id) => ({
  provider: "deepseek",
  wire_model_id,
  endpoint_key: "chat",
  default_for_provider: false,
  source: { kind: "live", base_url_fingerprint: FINGERPRINT, fetched_at: nowSecs },
});
await writeFile(
  join(codeHome, "catalog", "provider-catalogs.json"),
  JSON.stringify(
    {
      schema_version: 2,
      cache: {
        entries: {
          [`deepseek:deepseek\u001f${FINGERPRINT}`]: {
            provider: "deepseek:deepseek",
            base_url_fingerprint: FINGERPRINT,
            fetched_at: nowSecs,
            ttl_secs: 86400,
            offerings: [offering("deepseek-flash"), offering("deepseek-v4-pro")],
            status: { state: "fresh" },
          },
        },
      },
    },
    null,
    2,
  ),
);

const report = {
  schema_version: 1,
  label: "Reasoning controls — live route check",
  captured_at: new Date().toISOString(),
  ok: false,
  isolated_home: true,
  checks: {},
  observations: {},
  error: null,
};
const check = (name, value, detail = null) => {
  report.checks[name] = { ok: value === true, ...(detail ? { detail } : {}) };
  if (value !== true) report.first_failure ??= name;
};

const adapter = new CodewhaleAdapter({ store: new MemorySubmissionStore() });
const store = await StateStore.open({
  dbPath: join(product, "mona.sqlite"),
  backupDir: join(product, "backups"),
  artifactRoot: join(product, "artifacts"),
});
const projectId = "prj_0000000000000001";
let handle = null;
try {
  handle = await adapter.startOwnedRuntime({
    workspace,
    stateDir: join(base, "s"),
    logDir: join(base, "s", "logs"),
    env: {
      HOME: home,
      CODEWHALE_HOME: codeHome,
      DEEPSEEK_API_KEY: ["sk", "reasoning", "fixture", String(Date.now())].join("-"),
      NO_COLOR: "1",
    },
    startupTimeoutMs: 45_000,
  });

  const engineCatalog = await adapter.listModels("deepseek", null);
  const liveFlash = engineCatalog.models.find((model) => model.id === "deepseek-flash");
  report.observations.engine_catalog = {
    models: engineCatalog.models.length,
    flash_state: liveFlash?.reasoningEffort ?? null,
    flash_levels: liveFlash?.reasoningEffortLevels ?? [],
    flash_facts_source: liveFlash?.factsSource ?? null,
  };
  report.observations.metadata_source = hostCache
    ? "the host engine cache"
    : "entries captured from the host engine cache on 2026-11-14";
  check(
    "the live roster shadow makes the engine report an unknown ladder",
    liveFlash?.reasoningEffort === "unknown" &&
      (liveFlash?.reasoningEffortLevels ?? []).length === 0,
  );

  const bench = new RouteWorkbench({
    store,
    engine: () => ({ adapter, workspace }),
    studio: async () => null,
    backupDir: join(product, "engine-config"),
    homeDir: home,
    configRoot: codeHome,
    engineBinary: () => process.execPath,
    runDoctor: async () => ({ stdout: "", stderr: "", code: 0 }),
  });

  const snapshot = await bench.snapshot(projectId);
  const flash = snapshot.models.models.find((model) => model.id === "deepseek-flash");
  report.observations.mona = {
    support: flash?.reasoningSupport ?? null,
    requested: snapshot.reasoning.requested,
    declared: snapshot.reasoning.declared,
    inheritance: snapshot.reasoning.inheritance,
    display: snapshot.reasoning.display,
    engine_default: snapshot.engineDefault.reasoningEffort,
  };
  check(
    "Mona recovers the published ladder from the engine's own metadata",
    flash?.reasoningSupport.effort === "metadata" &&
      flash?.reasoningSupport.levels.join(",") === "low,high,max" &&
      flash?.reasoningSupport.thinking === "toggle",
  );
  check(
    "the recovered ladder is labelled, not presented as a live catalog answer",
    flash?.reasoningSupport.degraded === true &&
      String(flash?.reasoningSupport.sourceDetail ?? "").includes("Models.dev"),
  );
  check(
    "the reasoning setting is declared as auto, stored and sent, and not editable",
    snapshot.reasoning.declared.value === "auto" &&
      snapshot.reasoning.declared.editable === false &&
      snapshot.reasoning.requested.effort === "auto" &&
      snapshot.reasoning.inheritance.configuredDefault === "auto" &&
      snapshot.reasoning.inheritance.effective === null &&
      snapshot.reasoning.inheritance.note.includes("reasoning selector resolves"),
  );
  const storedProfile = await store.getSettings(PROFILE_SCOPE);
  check(
    "a read does not write, and says whether the row carries the setting yet",
    snapshot.reasoning.declared.stored === false && storedProfile === null,
  );

  const saved = await bench.saveDefault({
    projectId,
    expectedRevision: snapshot.savedDefault.revision,
    provider: "deepseek",
    // The screen sends the provider row's canonical id for a built-in route.
    exactId: "deepseek",
    model: "deepseek-flash",
    reasoningEffort: "high",
    permissionPosture: "full_access",
    autoApprove: true,
    trustMode: true,
    allowShell: true,
  });
  const persisted = await store.getSettings(PROFILE_SCOPE);
  report.observations.saved = persisted?.value ?? null;
  check(
    "an explicit save persists the setting, and the snapshot then reports it stored",
    persisted?.value?.reasoningEffort === "high" &&
      saved.snapshot.reasoning.declared.stored === true,
  );

  const refused = await bench
    .saveDefault({
      projectId,
      expectedRevision: saved.snapshot.savedDefault.revision,
      provider: "deepseek",
      exactId: "deepseek",
      model: "deepseek-flash",
      reasoningEffort: "medium",
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    })
    .then(() => null)
    .catch((error) => error);
  report.observations.refused = refused?.message ?? null;
  const afterRefusal = await store.getSettings(PROFILE_SCOPE);
  check(
    "an unpublished tier is refused and the stored route is unchanged",
    refused?.code === "INVALID_ROUTE" && afterRefusal?.value?.reasoningEffort === "high",
  );

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
  check(
    "the published thinking toggle persists the engine's off value",
    (await store.getSettings(PROFILE_SCOPE))?.value?.reasoningEffort === "off" &&
      off.snapshot.reasoning.requested.thinking === "off",
  );

  // A user-configured endpoint is a different route. The engine's metadata
  // describes the first-party host, so Mona must not claim it there.
  const customHome = join(base, "c2");
  await mkdir(join(customHome, "catalog"), { recursive: true });
  await writeFile(
    join(customHome, "config.toml"),
    [
      'provider = "deepseek"',
      'model = "deepseek-flash"',
      "",
      "[providers.deepseek]",
      'base_url = "https://gateway.example.com/v1"',
    ].join("\n"),
  );
  await copyFile(modelsDevTarget, join(customHome, "catalog", "models-dev-catalog.json"));
  const customBench = new RouteWorkbench({
    store,
    engine: () => ({ adapter, workspace }),
    studio: async () => null,
    backupDir: join(product, "engine-config-custom"),
    homeDir: home,
    configRoot: customHome,
    engineBinary: () => process.execPath,
    runDoctor: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  const customSnapshot = await customBench.snapshot(projectId);
  const customFlash = customSnapshot.models.models.find((model) => model.id === "deepseek-flash");
  report.observations.custom_endpoint = {
    effort: customFlash?.reasoningSupport.effort ?? null,
    levels: customFlash?.reasoningSupport.levels ?? [],
  };
  check(
    "a configured endpoint does not borrow first-party metadata",
    customFlash?.reasoningSupport.effort === "unknown" &&
      (customFlash?.reasoningSupport.levels ?? []).length === 0,
  );

  const display = await bench.setReasoningDisplay({ projectId, showReasoning: false });
  check(
    "the transcript preference is persisted locally",
    display.snapshot.reasoning.display.showReasoning === false &&
      (await store.getSettings(REASONING_DISPLAY_SCOPE))?.value?.showReasoning === false,
  );
  check("no model turn was started", (await store.summarizeUsage(projectId)).turns === 0);
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  if (handle) {
    try {
      await adapter.shutdownOwnedRuntime(handle);
    } catch (error) {
      report.stop_error = String(error);
    }
  }
  await store.close?.().catch?.(() => undefined);
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
}

report.ok = Object.values(report.checks).every((entry) => entry.ok);
report.captured_sha256 = createHash("sha256").update(JSON.stringify(report.checks)).digest("hex");
await mkdir(join(ROOT, "docs", "evidence", "macos", "artifacts"), { recursive: true });
await writeFile(
  join(ROOT, "docs", "evidence", "macos", "artifacts", "reasoning-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    { ok: report.ok, checks: Object.keys(report.checks).length, error: report.error },
    null,
    2,
  ),
);
process.exit(report.ok ? 0 : 1);
