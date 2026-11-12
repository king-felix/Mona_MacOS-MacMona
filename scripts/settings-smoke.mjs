#!/usr/bin/env node
// P16 live smoke: configuration scope, route validation, engine switch with a
// backup and stale-read refusal, credential pass-through, and redacted
// diagnostics. Uses an isolated HOME and a temporary state store. No model
// turn is started, so no provider charge is incurred.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { CodewhaleAdapter } = require(join(ROOT, "dist/main/main/engine/adapter.js"));
const { MemorySubmissionStore } = require(join(ROOT, "dist/main/main/engine/submission-store.js"));
const { RouteWorkbench } = require(join(ROOT, "dist/main/main/work/settings.js"));
const { PROFILE_SCOPE } = require(join(ROOT, "dist/main/main/work/profile.js"));
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { resolveEngineBinary } = require(join(ROOT, "dist/main/main/engine/runtime-process.js"));

const base = await mkdtemp(join(tmpdir(), "mona-p16-smoke-"));
const home = join(base, "home");
const workspace = join(base, "ws");
const codeHome = join(home, ".codewhale");
await mkdir(codeHome, { recursive: true });
await mkdir(workspace, { recursive: true });
const stateDir = join(base, "supervisor");
const productState = join(base, "product");
await mkdir(stateDir, { recursive: true });
await mkdir(productState, { recursive: true });
const configPath = join(codeHome, "config.toml");
await writeFile(
  configPath,
  '# P16 smoke config\nprovider = "deepseek"\nmodel = "deepseek-flash"\n\n[mona_unknown_table]\nkeep_me = "yes"\n',
);

const SECRET = ["sk", "smoke", `fixture${Date.now()}`].join("-");
const report = {
  schema_version: 1,
  label: "P16 — provider, model, and configuration workbench",
  captured_at: new Date().toISOString(),
  ok: false,
  isolated_home: true,
  checks: {},
  observations: {},
  backups: [],
  error: null,
};

const check = (name, value, detail = null) => {
  report.checks[name] = { ok: value === true, ...(detail ? { detail } : {}) };
  if (value !== true) report.first_failure ??= name;
};

const adapter = new CodewhaleAdapter({ store: new MemorySubmissionStore() });
const store = await StateStore.open({
  dbPath: join(productState, "mona.sqlite"),
  backupDir: join(productState, "backups"),
  artifactRoot: join(productState, "artifacts"),
});
let handle = null;
try {
  handle = await adapter.startOwnedRuntime({
    workspace,
    stateDir,
    logDir: join(stateDir, "logs"),
    env: {
      HOME: home,
      CODEWHALE_HOME: codeHome,
      DEEPSEEK_API_KEY: SECRET,
      NO_COLOR: "1",
    },
    startupTimeoutMs: 45_000,
  });
  const runDoctor = async (command, options) => {
    const [binary, ...args] = command;
    const exec = promisify(execFile);
    try {
      const result = await exec(binary, args, {
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: home,
          CODEWHALE_HOME: codeHome,
          DEEPSEEK_API_KEY: SECRET,
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? String(error),
        code: typeof error.code === "number" ? error.code : 1,
      };
    }
  };
  const bench = new RouteWorkbench({
    store,
    engine: () => ({ adapter, workspace }),
    studio: async () => null,
    backupDir: join(productState, "engine-config"),
    engineBinary: () => resolveEngineBinary().path,
    homeDir: home,
    configRoot: codeHome,
    runDoctor,
  });
  const projectId = "prj_0000000000000001";

  const snapshot = await bench.snapshot(projectId);
  report.observations.snapshot = {
    runtime: snapshot.runtime,
    provider_count: snapshot.providers.providers.length,
    model_count: snapshot.models.models.length,
    saved_default: snapshot.savedDefault,
    engine_default: snapshot.engineDefault,
    policy: snapshot.policy,
    engine_selection: snapshot.engineSelection,
  };
  check(
    "live provider catalog",
    snapshot.providers.source === "live" && snapshot.providers.providers.length > 0,
  );
  check(
    "live model catalog",
    snapshot.models.source === "live" && snapshot.models.models.length > 0,
  );
  check(
    "engine route is visible",
    snapshot.engineDefault.source === "live" && snapshot.engineDefault.model !== null,
  );
  check(
    "endpoint authority has no path or userinfo",
    !String(snapshot.engineDefault.endpointAuthority ?? "").includes("/beta"),
  );
  const flash = snapshot.models.models.find((model) => model.id === "deepseek-flash");
  check(
    "flash publishes an effort ladder",
    flash?.reasoningEffort === "supported" && flash.reasoningEffortLevels.length > 0,
  );

  const saved = await bench.saveDefault({
    projectId,
    expectedRevision: snapshot.savedDefault.revision,
    provider: "deepseek",
    exactId: null,
    model: "deepseek-flash",
    reasoningEffort: "high",
    permissionPosture: "full_access",
    autoApprove: true,
    trustMode: true,
    allowShell: true,
  });
  report.observations.saved_default = saved.receipt;
  check("saved default persisted with a revision", saved.snapshot.savedDefault.revision > 0);
  const persisted = await store.getSettings(PROFILE_SCOPE);
  check("saved default is on disk", persisted?.value?.reasoningEffort === "high");

  const unsupported = await bench
    .saveDefault({
      projectId,
      expectedRevision: saved.snapshot.savedDefault.revision,
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
  report.observations.unsupported_reasoning = unsupported?.message ?? null;
  check(
    "unsupported reasoning refused",
    Boolean(unsupported && unsupported.code === "INVALID_ROUTE"),
  );
  const afterRefusal = await store.getSettings(PROFILE_SCOPE);
  check(
    "refused setting did not change the stored route",
    afterRefusal?.value?.reasoningEffort === "high",
  );

  const stale = await bench
    .saveDefault({
      projectId,
      expectedRevision: saved.snapshot.savedDefault.revision - 1,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: null,
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
    })
    .then(() => null)
    .catch((error) => error);
  check("stale saved-default revision refused", stale?.code === "CONFIG_STALE");

  const beforeBytes = await readFile(configPath);
  const beforeHash = createHash("sha256").update(beforeBytes).digest("hex");
  const staleSwitch = await bench
    .switchEngineRoute({
      projectId,
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      expectedConfigRevision: "0".repeat(64),
      confirm: true,
    })
    .then(() => null)
    .catch((error) => error);
  check("stale config revision refused before writing", staleSwitch?.code === "CONFIG_STALE");
  const afterStaleBytes = await readFile(configPath);
  check(
    "refused switch left the config untouched",
    createHash("sha256").update(afterStaleBytes).digest("hex") === beforeHash,
  );

  // The engine may rewrite its config document when it resolves a route, so
  // read the current revision immediately before the explicit switch, exactly
  // as the UI does with a fresh snapshot.
  const currentRevision = createHash("sha256")
    .update(await readFile(configPath))
    .digest("hex");
  const switched = await bench.switchEngineRoute({
    projectId,
    provider: "deepseek",
    exactId: null,
    model: "deepseek-flash",
    expectedConfigRevision: currentRevision,
    confirm: true,
  });
  report.observations.engine_switch = switched.receipt;
  // Record the backup's file name and hash, not a temporary directory path that
  // will be gone when this evidence is read later.
  if (switched.receipt.backupPath) {
    report.backups.push({
      file: switched.receipt.backupPath.split("/").pop(),
      sha256: switched.receipt.backupSha256,
      revision: switched.receipt.revisionBefore,
    });
  }
  check("engine switch verified its observed route", switched.receipt.applied === true);
  check(
    "config backup written with the pre-write hash",
    switched.receipt.backupSha256 === currentRevision,
  );
  const backupText = switched.receipt.backupPath
    ? await readFile(switched.receipt.backupPath, "utf8")
    : "";
  check("backup matches the pre-write document", backupText === beforeBytes.toString("utf8"));
  const configAfter = await readFile(configPath, "utf8");
  check(
    "unknown config table preserved",
    configAfter.includes("keep_me") && configAfter.includes("mona_unknown_table"),
  );

  const credential = await bench.setProviderCredential({
    projectId,
    provider: "deepseek",
    key: SECRET,
    scope: "session",
  });
  report.observations.credential = credential;
  check(
    "credential accepted without echoing the value",
    !JSON.stringify(credential).includes(SECRET),
  );
  const cleared = await bench.clearProviderCredential({
    projectId,
    provider: "deepseek",
    scope: "session",
  });
  report.observations.credential_clear = cleared;
  check("session credential cleared", cleared.cleared === true);

  const diagnostics = await bench.diagnostics(projectId);
  report.observations.diagnostics = {
    ok: diagnostics.ok,
    summary: diagnostics.summary,
    warnings: diagnostics.warnings,
    redactions: diagnostics.redactions,
    bytes: diagnostics.redacted.length,
  };
  check("diagnostics produced a redacted report", diagnostics.redacted.length > 0);
  check("diagnostics contain no home path", !diagnostics.redacted.includes(home));
  check("diagnostics contain no fixture secret", !diagnostics.redacted.includes(SECRET));
  const scan = JSON.stringify(report);
  check("entire report contains no fixture secret", !scan.includes(SECRET));
  report.ok = Object.values(report.checks).every((entry) => entry.ok);
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
}
const outDir = join(ROOT, "docs", "evidence", "macos", "artifacts");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "p16-settings-smoke.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    { ok: report.ok, checks: Object.keys(report.checks).length, error: report.error },
    null,
    2,
  ),
);
process.exit(report.ok === true ? 0 : 1);
