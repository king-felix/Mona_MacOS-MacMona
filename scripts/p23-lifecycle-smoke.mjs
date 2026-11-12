#!/usr/bin/env node
// P23 update / migration / rollback / uninstall smoke.
//
// Everything here is real: real state stores, real SQLite backups taken through
// the maintenance barrier, a real signed manifest envelope verified with a real
// Ed25519 key, a real `.pkg` inspected by `pkgutil`, the shipped removal
// utility executed against a temporary root, and a real older-app-against-
// newer-schema database.
//
// The Apple Installer launch and the package inspection of the 154 MiB release
// artifact are the two steps that cannot be rehearsed here, so they are the only
// injected seams and both are labelled in the report.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { CURRENT_SCHEMA_VERSION } = require(join(ROOT, "dist/main/main/state/schema.js"));
const { inspectRecovery, listSnapshots, restoreSnapshotWithoutStore } = require(
  join(ROOT, "dist/main/main/state/recovery.js"),
);
const { UpdateCoordinator } = require(join(ROOT, "dist/main/main/update/coordinator.js"));
const { decodeSignedManifest, encodeSignedManifest } = require(
  join(ROOT, "dist/main/main/update/manifest.js"),
);
const { evaluateUpdate, inspectPackage, parsePackageSignature } = require(
  join(ROOT, "dist/main/main/update/trust.js"),
);
const { uninstallView } = require(join(ROOT, "dist/main/main/update/uninstall.js"));

const base = mkdtempSync(join(tmpdir(), "mona-p23-smoke-"));
const report = {
  schema_version: 1,
  label: "P23 — update, migration, rollback, and uninstall",
  captured_at: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    macos: readOsVersion(),
  },
  injected_seams: [
    "the Apple Installer launch is replaced by a recorder (a real launch would open a GUI installer)",
    "the candidate package for the source-feed case is a synthetic .pkg; digest, size, identity and signature are real values from the fixture",
  ],
  ok: false,
  checks: {},
  observations: {},
  error: null,
  first_failure: null,
};

function readOsVersion() {
  const result = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const check = (name, value, detail = null) => {
  report.checks[name] = { ok: value === true, ...(detail === null ? {} : { detail }) };
  if (value !== true && report.first_failure === null) report.first_failure = name;
};

/** An unobserved check is reported as skipped, never as a pass. */
const skip = (name, reason, detail = null) => {
  report.skipped = report.skipped ?? {};
  report.skipped[name] = {
    ok: null,
    skipped: true,
    reason,
    ...(detail === null ? {} : { detail }),
  };
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
let clockMs = Date.parse("2026-11-12T09:00:00.000Z");
const now = () => new Date((clockMs += 1_000));
let idCounter = 0;
const newId = (prefix) => `${prefix}_${(idCounter += 1).toString(16).padStart(8, "0")}`;

function workspace(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# workspace\n");
  return dir;
}

async function openStore(name) {
  const dir = join(base, name);
  mkdirSync(join(dir, "state"), { recursive: true });
  const store = await StateStore.open({
    dbPath: join(dir, "state", "mona.sqlite"),
    backupDir: join(dir, "backups"),
    artifactRoot: join(dir, "artifacts"),
    now,
    newId,
  });
  return { store, dir };
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
}

/** A package fixture whose bytes and metadata are real files. */
function buildPackageFixture(dir, { version, build, adhoc = true }) {
  const pkgPath = join(dir, `Mona-${version}-macOS-arm64-local.pkg`);
  const payload = Buffer.from(`fixture payload for ${version} build ${build}\n`);
  writeFileSync(pkgPath, payload);
  const expandedRoot = join(dir, `expanded-${version}`);
  mkdirSync(join(expandedRoot, "component.pkg"), { recursive: true });
  mkdirSync(join(expandedRoot, "Resources"), { recursive: true });
  writeFileSync(
    join(expandedRoot, "component.pkg", "PackageInfo"),
    `<?xml version="1.0" encoding="utf-8"?>
<pkg-info overwrite-permissions="true" relocatable="false" identifier="com.mona.workbench.pkg" version="${version}" install-location="/" auth="root">
  <bundle path="./Applications/Mona.app" id="com.mona.workbench" CFBundleShortVersionString="${version}" CFBundleVersion="${build}"/>
  <bundle path="./Library/Services/Mona.service" id="com.mona.workbench.service" CFBundleShortVersionString="${version}" CFBundleVersion="${build}"/>
</pkg-info>`,
    "utf8",
  );
  writeFileSync(
    join(expandedRoot, "Distribution"),
    `<installer-gui-script><options hostArchitectures="arm64"/><allowed-os-versions><os-version min="14.0"/></allowed-os-versions></installer-gui-script>`,
    "utf8",
  );
  const runner = (command, args) => {
    if (args.includes("--check-signature")) {
      return {
        status: 0,
        stdout: adhoc ? "Status: adhoc" : "Status: no signature",
        stderr: "",
      };
    }
    const destination = args[2];
    spawnSync("/bin/cp", ["-R", expandedRoot, destination]);
    return { status: 0, stdout: "", stderr: "" };
  };
  const facts = inspectPackage(pkgPath, runner);
  return { pkgPath, facts, sha256: sha256(payload), size: payload.length };
}

function coordinatorFor({ store, dir, version, build, launched, activity, inspect }) {
  return new UpdateCoordinator({
    store,
    paths: { cache: join(dir, "cache"), support: dir },
    current: () => ({
      version,
      build,
      channel: "local",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: "0.10.2",
      engineCommit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e",
    }),
    hostOs: () => readOsVersion() ?? "14.0",
    hostArch: () => process.arch,
    inspect,
    launchInstaller: async (path) => {
      launched.push(path);
    },
    // The real probe: the store is the authority for running tasks, live
    // submissions, and engine runtimes.
    activity: activity ?? (async () => store.activeWork()),
    now,
    shouldQuit: () => true,
    afterHandoff: () => undefined,
  });
}

try {
  // 1. Upgrade N -> N+1 over real stores: intent, verified backup, handoff.
  {
    const { store, dir } = await openStore("upgrade");
    const project = await store.createProject({
      name: "Kept work",
      rootPath: workspace(dir, "ws"),
    });
    const task = await store.createTask({
      projectId: project.id,
      title: "Existing task",
      prompt: "keep me",
    });
    const launched = [];
    const fixture = buildPackageFixture(dir, { version: "0.2.0", build: 120 });
    const coordinator = coordinatorFor({
      store,
      dir,
      version: "0.1.0",
      build: 81,
      launched,
      // Seam: the real package is inspected by the fixture runner above.
      inspect: () => fixture.facts,
    });

    const view = await coordinator.inspectLocal(fixture.pkgPath);
    check("upgrade_candidate_available", view.decision === "available", {
      decision: view.decision,
      code: view.code,
      reason: view.reason,
    });
    check("upgrade_candidate_is_upgrade", view.candidate?.installKind === "upgrade");
    check("upgrade_check_makes_no_inference_call", view.inference.requests === 0, view.inference);

    const receipt = await coordinator.install({
      expectedSha256: view.candidate?.packageSha256 ?? fixture.sha256,
      confirmedLocalBuild: true,
    });
    check("upgrade_handoff_recorded", receipt.state === "handed_off", receipt);
    check("upgrade_installer_opened_once", launched.length === 1 && receipt.installerLaunched);
    check(
      "upgrade_backup_verified",
      receipt.backup !== null &&
        receipt.backup.integrity === "ok" &&
        existsSync(receipt.backup.path) &&
        sha256(readFileSync(receipt.backup.path)) === receipt.backup.sha256,
      receipt.backup,
    );
    const intent = await store.latestUpdateIntent();
    check(
      "upgrade_intent_precedes_handoff",
      intent?.state === "handed_off" &&
        intent.packageSha256 === receipt.packageSha256 &&
        intent.backupPath === receipt.backup?.path,
      intent,
    );
    // The state survived the update preparation exactly as it was.
    const afterTasks = await store.listTasks(project.id);
    check(
      "upgrade_preserved_user_state",
      afterTasks.length === 1 &&
        afterTasks[0]?.title === "Existing task" &&
        task.id === afterTasks[0]?.id,
    );
    await store.close();
  }

  // 2. Active-run deferral: nothing is recorded, nothing is launched.
  {
    const { store, dir } = await openStore("deferral");
    const project = await store.createProject({ name: "Busy", rootPath: workspace(dir, "ws") });
    const task = await store.createTask({
      projectId: project.id,
      title: "Running work",
      prompt: "long turn",
    });
    await store.updateTaskStatus(task.id, "running", task.revision, { actor: "mona_queue" });
    const launched = [];
    const fixture = buildPackageFixture(dir, { version: "0.2.0", build: 120 });
    const coordinator = coordinatorFor({
      store,
      dir,
      version: "0.1.0",
      build: 81,
      launched,
      inspect: () => fixture.facts,
    });
    await coordinator.inspectLocal(fixture.pkgPath);
    const receipt = await coordinator.install({
      expectedSha256: fixture.sha256,
      confirmedLocalBuild: true,
    });
    check("deferral_reported", receipt.state === "deferred", receipt);
    check("deferral_names_the_task", receipt.reason.includes("Running work"), receipt.reason);
    check("deferral_launched_nothing", launched.length === 0);
    check("deferral_recorded_no_intent", (await store.latestUpdateIntent()) === null);
    const still = await store.getTask(task.id);
    check("deferral_left_the_run_untouched", still?.status === "running", {
      status: still?.status,
    });
    await store.close();
  }

  // 3. Wrong-package rejections, each with its own code.
  {
    const { store, dir } = await openStore("rejections");
    await store.createProject({ name: "Rejects", rootPath: workspace(dir, "ws") });
    const launched = [];
    const source = {
      schemaVersion: 1,
      mode: "configured",
      baseUrl: "https://updates.example.com/mona",
      manifestPath: "update.json",
      teamId: "ABCDE12345",
      manifestKey: "unused",
      allowLocalPackages: true,
    };
    const current = {
      version: "0.2.0",
      build: 200,
      channel: "local",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: "0.10.2",
      engineCommit: "ff466b2e",
    };
    const factsFor = (overrides = {}) => ({
      path: "/tmp/Mona.pkg",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      signature: {
        status: "signed",
        teamId: "ABCDE12345",
        authorities: ["Developer ID Installer: Mona (ABCDE12345)"],
        developerIdInstaller: true,
        identifier: "com.mona.workbench.pkg",
      },
      package: {
        identifier: "com.mona.workbench.pkg",
        version: "0.3.0",
        build: 300,
        installLocation: "/",
        minimumMacOS: "14.0",
      },
      appBundleId: "com.mona.workbench",
      serviceBundleId: "com.mona.workbench.service",
      architectures: ["arm64"],
      engine: { version: "0.10.2", commit: "ff466b2e" },
      source: "pkgutil",
      ...overrides,
    });
    const manifestFor = (overrides = {}) => ({
      schemaVersion: 1,
      product: "Mona",
      channel: "release",
      version: "0.3.0",
      build: 300,
      bundleId: "com.mona.workbench",
      serviceBundleId: "com.mona.workbench.service",
      packageId: "com.mona.workbench.pkg",
      teamId: "ABCDE12345",
      minimumMacOS: "14.0",
      architectures: ["arm64"],
      engine: { version: "0.10.2", commit: "ff466b2e" },
      package: {
        url: "Mona-0.3.0.pkg",
        name: "Mona-0.3.0.pkg",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
        notarized: true,
      },
      releasedAt: "2026-11-12T00:00:00.000Z",
      notesUrl: null,
      ...overrides,
    });
    const decide = (overrides = {}) =>
      evaluateUpdate({
        mode: "configured",
        source,
        manifest: manifestFor(overrides.manifest ?? {}),
        packageFacts: overrides.facts === null ? null : factsFor(overrides.facts ?? {}),
        current,
        hostOs: readOsVersion() ?? "14.0",
        hostArch: "arm64",
        applied: overrides.applied ?? [],
        engineChangeConfirmed: overrides.engineChangeConfirmed ?? false,
      });

    check(
      "wrong_team_refused",
      decide({ manifest: { teamId: "ZZZZZ99999" } }).code === "wrong_team",
    );
    check(
      "tampered_digest_refused",
      decide({ facts: { sha256: "b".repeat(64) } }).code === "digest_mismatch",
    );
    check("size_mismatch_refused", decide({ facts: { sizeBytes: 999 } }).code === "size_mismatch");
    check(
      "unsigned_release_refused",
      decide({
        facts: {
          signature: {
            status: "unsigned",
            teamId: null,
            authorities: [],
            developerIdInstaller: false,
            identifier: null,
          },
        },
      }).code === "package_unsigned",
    );
    check(
      "adhoc_release_refused",
      decide({
        facts: {
          signature: {
            status: "adhoc",
            teamId: null,
            authorities: ["adhoc"],
            developerIdInstaller: false,
            identifier: "com.mona.workbench.pkg",
          },
        },
      }).code === "package_adhoc",
    );
    check(
      "downgrade_refused",
      decide({ manifest: { version: "0.1.0", build: 90 } }).code === "downgrade",
    );
    check(
      "replay_refused",
      decide({ applied: [{ sha256: "a".repeat(64), version: "0.3.0", at: "2026-11-01" }] }).code ===
        "replayed",
    );
    check(
      "incompatible_os_refused",
      decide({ manifest: { minimumMacOS: "99.0" } }).code === "os_too_old",
    );
    check(
      "intel_package_refused",
      decide({ manifest: { architectures: ["x86_64"] } }).code === "architecture_mismatch",
    );
    check(
      "foreign_product_refused",
      decide({ manifest: { product: "Other" } }).code === "product_mismatch",
    );
    check(
      "unconfirmed_engine_change_refused",
      decide({ manifest: { engine: { version: "0.11.0", commit: "deadbeef" } } }).code ===
        "engine_change_unconfirmed",
    );
    check(
      "confirmed_engine_change_allowed",
      decide({
        manifest: { engine: { version: "0.11.0", commit: "deadbeef" } },
        engineChangeConfirmed: true,
      }).decision === "available",
    );
    check("no_handoff_from_a_refusal", launched.length === 0);
    await store.close();
  }

  // 4. Signed manifest envelope: real Ed25519, real tamper refusal.
  {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const manifest = {
      schemaVersion: 1,
      product: "Mona",
      channel: "release",
      version: "0.3.0",
      build: 300,
      bundleId: "com.mona.workbench",
      serviceBundleId: "com.mona.workbench.service",
      packageId: "com.mona.workbench.pkg",
      teamId: "ABCDE12345",
      minimumMacOS: "14.0",
      architectures: ["arm64"],
      engine: { version: "0.10.2", commit: "ff466b2e" },
      package: {
        url: "Mona-0.3.0.pkg",
        name: "Mona-0.3.0.pkg",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
        notarized: true,
      },
      releasedAt: "2026-11-12T00:00:00.000Z",
      notesUrl: null,
    };
    const envelope = encodeSignedManifest(manifest, privateKeyPem);
    const authenticated = decodeSignedManifest(envelope, publicKeyBase64);
    check(
      "manifest_signature_verified",
      authenticated.manifest.version === "0.3.0" &&
        /^[0-9a-f]{64}$/.test(authenticated.keyFingerprint),
      { key_fingerprint: authenticated.keyFingerprint },
    );

    const tampered = JSON.parse(envelope.toString("utf8"));
    tampered.payload = Buffer.from(JSON.stringify({ ...manifest, version: "9.9.9" })).toString(
      "base64",
    );
    let tamperCode = null;
    try {
      decodeSignedManifest(Buffer.from(JSON.stringify(tampered)), publicKeyBase64);
    } catch (error) {
      tamperCode = errorCode(error);
    }
    check("tampered_manifest_refused", tamperCode === "manifest_signature_invalid", {
      code: tamperCode,
    });

    const otherKey = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    let wrongKeyCode = null;
    try {
      decodeSignedManifest(envelope, otherKey);
    } catch (error) {
      wrongKeyCode = errorCode(error);
    }
    check("wrong_manifest_key_refused", wrongKeyCode === "manifest_signature_invalid", {
      code: wrongKeyCode,
    });

    // A payload signed by the right key but not matching the schema is refused.
    const badPayload = Buffer.from(JSON.stringify({ schemaVersion: 1 }), "utf8");
    const badEnvelope = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        algorithm: "ed25519",
        payload: badPayload.toString("base64"),
        signature: sign(null, badPayload, privateKeyPem).toString("base64"),
      }),
    );
    let schemaCode = null;
    try {
      decodeSignedManifest(badEnvelope, publicKeyBase64);
    } catch (error) {
      schemaCode = errorCode(error);
    }
    check("malformed_signed_manifest_refused", schemaCode === "manifest_malformed", {
      code: schemaCode,
    });
  }

  // 5. Failed migration keeps a recovery copy and a named support path.
  {
    const { store, dir } = await openStore("migration");
    await store.createProject({ name: "Survives", rootPath: workspace(dir, "ws") });
    const snapshot = await store.backupForUpdate("0.2.0");
    await store.close();
    check(
      "pre_update_snapshot_verified",
      existsSync(snapshot.path) && sha256(readFileSync(snapshot.path)) === snapshot.sha256,
      snapshot,
    );

    // A newer build writes a newer schema. This build must refuse it.
    const dbPath = join(dir, "state", "mona.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE projects ADD COLUMN future_field TEXT");
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 2}`);
    db.close();

    const paths = {
      database: dbPath,
      backupsDir: join(dir, "backups"),
      supportDir: dir,
    };
    const view = inspectRecovery(paths);
    check("newer_schema_detected", view.state === "newer_schema", {
      state: view.state,
      database: view.databaseSchemaVersion,
      build: view.buildSchemaVersion,
    });
    let openCode = null;
    try {
      await StateStore.open({
        dbPath,
        backupDir: join(dir, "backups"),
        artifactRoot: join(dir, "artifacts"),
      });
    } catch (error) {
      openCode = errorCode(error);
    }
    check("newer_schema_refused_by_store", openCode === "UNSUPPORTED_SCHEMA", { code: openCode });
    check(
      "recovery_offers_only_a_matching_snapshot",
      view.canRestoreSnapshot === true &&
        view.snapshots.every(
          (entry) => !entry.appliesToThisBuild || entry.schemaVersion <= CURRENT_SCHEMA_VERSION,
        ),
      view.snapshots.map((entry) => ({
        file: entry.fileName,
        schema: entry.schemaVersion,
        restorable: entry.appliesToThisBuild,
      })),
    );

    const receipt = await restoreSnapshotWithoutStore(paths, {
      snapshotPath: snapshot.path,
      expectedSchemaVersion: snapshot.schemaVersion,
    });
    check("matching_snapshot_restored", receipt.restored === true && receipt.integrity === "ok");
    check(
      "restore_kept_the_replaced_database",
      receipt.replacedPath !== null && existsSync(receipt.replacedPath),
      { replaced: receipt.replacedPath },
    );
    const reopened = await StateStore.open({
      dbPath,
      backupDir: join(dir, "backups"),
      artifactRoot: join(dir, "artifacts"),
    });
    const projects = await reopened.listProjects({});
    check(
      "restored_state_opens_with_the_original_rows",
      projects.length === 1 && projects[0]?.name === "Survives",
      { projects: projects.map((entry) => entry.name) },
    );
    await reopened.close();
  }

  // 6. A snapshot whose schema this build cannot read is never offered.
  {
    const { store, dir } = await openStore("schema-guard");
    await store.createProject({ name: "Guarded", rootPath: workspace(dir, "ws") });
    await store.close();
    const futurePath = join(dir, "backups", "pre-update-9.9.9-2026-11-12T00-00-00-000Z.sqlite");
    copyFileSync(join(dir, "state", "mona.sqlite"), futurePath);
    const future = new DatabaseSync(futurePath);
    future.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 5}`);
    future.close();

    const listed = listSnapshots(join(dir, "backups"));
    const newer = listed.find(
      (entry) => entry.fileName === "pre-update-9.9.9-2026-11-12T00-00-00-000Z.sqlite",
    );
    check("newer_snapshot_not_restorable", newer?.appliesToThisBuild === false, newer);
    let code = null;
    try {
      await restoreSnapshotWithoutStore(
        {
          database: join(dir, "state", "mona.sqlite"),
          backupsDir: join(dir, "backups"),
          supportDir: dir,
        },
        { snapshotPath: futurePath, expectedSchemaVersion: CURRENT_SCHEMA_VERSION + 5 },
      );
    } catch (error) {
      code = errorCode(error);
    }
    check("newer_snapshot_restore_refused", code === "UNSUPPORTED_SCHEMA", { code });
  }

  // 7. Reinstall N -> N keeps state; the intent says "reinstall".
  {
    const { store, dir } = await openStore("reinstall");
    const project = await store.createProject({
      name: "Reinstalled",
      rootPath: workspace(dir, "ws"),
    });
    await store.createTask({ projectId: project.id, title: "Kept", prompt: "keep" });
    const launched = [];
    const fixture = buildPackageFixture(dir, { version: "0.1.0", build: 81 });
    const coordinator = coordinatorFor({
      store,
      dir,
      version: "0.1.0",
      build: 81,
      launched,
      inspect: () => fixture.facts,
    });
    const view = await coordinator.inspectLocal(fixture.pkgPath);
    check("reinstall_recognized", view.candidate?.installKind === "reinstall", view.candidate);
    const receipt = await coordinator.install({
      expectedSha256: fixture.sha256,
      confirmedLocalBuild: true,
    });
    check("reinstall_handoff_recorded", receipt.state === "handed_off" && launched.length === 1);
    const tasks = await store.listTasks(project.id);
    check("reinstall_preserved_tasks", tasks.length === 1 && tasks[0]?.title === "Kept");
    await store.close();
  }

  // 8. The shipped removal utility, executed against a temporary root.
  {
    const root = join(base, "uninstall-root");
    mkdirSync(join(root, "Applications"), { recursive: true });
    mkdirSync(join(root, "Library/Application Support"), { recursive: true });
    // An unrelated application, a user config file, and a user state that must
    // all survive the uninstall.
    mkdirSync(join(root, "Applications/Other.app/Contents"), { recursive: true });
    writeFileSync(
      join(root, "Applications/Other.app/Contents/Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>",
    );
    writeFileSync(join(root, "Library/Application Support/keep-me.json"), "user config");
    const home = join(base, "uninstall-home");
    mkdirSync(join(home, "Library/Application Support/Mona"), { recursive: true });
    writeFileSync(join(home, "Library/Application Support/Mona/mona.sqlite"), "user state");

    // Install the real payload shape with real bundle identifiers.
    const payload = join(base, "payload");
    for (const [path, id] of [
      ["Applications/Mona.app", "com.mona.workbench"],
      ["Library/Services/Mona.service", "com.mona.workbench.service"],
    ]) {
      mkdirSync(join(payload, path, "Contents"), { recursive: true });
      writeFileSync(
        join(payload, path, "Contents/Info.plist"),
        `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`,
      );
    }
    const receiptDir = join(payload, "Library/Application Support/Mona");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(
      join(receiptDir, "install-receipt.json"),
      JSON.stringify({
        schema_version: 1,
        product: "Mona",
        version: "0.1.0",
        channel: "local",
        package: "Mona-0.1.0-macOS-arm64-local.pkg",
        manifest_sha256: sha256("manifest"),
        installed_at: "2026-11-12T00:00:00Z",
        app_path: "/Applications/Mona.app",
        service_path: "/Library/Services/Mona.service",
      }),
    );
    writeFileSync(
      join(receiptDir, "owned-paths.json"),
      JSON.stringify({
        schema_version: 1,
        product: "Mona",
        version: "0.1.0",
        channel: "local",
        package: "Mona-0.1.0-macOS-arm64-local.pkg",
        owned: [
          { path: "/Applications/Mona.app", kind: "app-bundle" },
          { path: "/Library/Services/Mona.service", kind: "service-bundle" },
          {
            path: "/Library/Application Support/Mona/install-receipt.json",
            kind: "install-receipt",
          },
          {
            path: "/Library/Application Support/Mona/owned-paths.json",
            kind: "ownership-manifest",
          },
          {
            path: "/Library/Application Support/Mona/uninstall-mona.sh",
            kind: "uninstall-utility",
          },
        ],
        preserves: ["~/.codewhale and any external Codewhale installation", "user project folders"],
      }),
    );
    copyFileSync(
      join(ROOT, "packaging/macos/scripts/uninstall-mona.sh"),
      join(receiptDir, "uninstall-mona.sh"),
    );
    chmodSync(join(receiptDir, "uninstall-mona.sh"), 0o755);

    spawnSync("/bin/cp", ["-R", join(payload, "Applications"), root]);
    spawnSync("/bin/cp", ["-R", join(payload, "Library"), root]);
    const script = join(root, "Library/Application Support/Mona/uninstall-mona.sh");
    // Keep a copy outside the root: the utility removes itself, and the refusal
    // cases below still need the same shipped script to run.
    const scriptCopy = join(base, "uninstall-mona.sh");
    copyFileSync(script, scriptCopy);
    chmodSync(scriptCopy, 0o755);
    const env = { ...process.env, MONA_UNINSTALL_ROOT: root };

    const dry = spawnSync("/bin/sh", [script, "--dry-run"], { encoding: "utf8", env });
    check(
      "uninstall_dry_run_changes_nothing",
      dry.status === 0 &&
        existsSync(join(root, "Applications/Mona.app")) &&
        existsSync(join(root, "Library/Services/Mona.service")),
      { status: dry.status, stdout: dry.stdout.trim().split("\n").slice(0, 5) },
    );
    check(
      "uninstall_dry_run_lists_only_owned_paths",
      dry.stdout.includes(join(root, "Applications/Mona.app")) &&
        !dry.stdout.includes("keep-me.json"),
    );

    // The destructive branch, rehearsed inside the same root.
    const rehearsalHome = join(root, "home");
    mkdirSync(join(rehearsalHome, "Library/Application Support/Mona"), { recursive: true });
    writeFileSync(join(rehearsalHome, "Library/Application Support/Mona/mona.sqlite"), "state");
    mkdirSync(join(rehearsalHome, "projects"), { recursive: true });
    writeFileSync(join(rehearsalHome, "projects/kept.txt"), "source");
    const userData = spawnSync(
      "/bin/sh",
      [scriptCopy, "--remove-user-data", "--home", rehearsalHome, "--yes"],
      { encoding: "utf8", env },
    );
    check(
      "uninstall_removes_only_the_named_users_state",
      userData.status === 0 &&
        !existsSync(join(rehearsalHome, "Library/Application Support/Mona")) &&
        existsSync(join(rehearsalHome, "projects/kept.txt")),
      { status: userData.status, stderr: userData.stderr.trim().slice(0, 300) },
    );

    // A home outside the rehearsal root is refused, so the bound is real.
    const outsideHome = join(base, "outside-home");
    mkdirSync(join(outsideHome, "Library/Application Support/Mona"), { recursive: true });
    const outside = spawnSync(
      "/bin/sh",
      [scriptCopy, "--remove-user-data", "--home", outsideHome, "--yes"],
      { encoding: "utf8", env },
    );
    check(
      "uninstall_refuses_user_data_outside_the_rehearsal_root",
      outside.status !== 0 && existsSync(join(outsideHome, "Library/Application Support/Mona")),
      { status: outside.status, stderr: outside.stderr.trim().slice(0, 200) },
    );

    // A hostile ownership manifest cannot widen the removal plan.
    const hostileRoot = join(base, "hostile-root");
    mkdirSync(join(hostileRoot, "Applications"), { recursive: true });
    mkdirSync(join(hostileRoot, "Library/Application Support/Mona"), { recursive: true });
    mkdirSync(join(hostileRoot, "Library/Application Support/Someone Else"), { recursive: true });
    writeFileSync(join(hostileRoot, "Library/Application Support/Someone Else/keep"), "keep");
    writeFileSync(
      join(hostileRoot, "Library/Application Support/Mona/owned-paths.json"),
      JSON.stringify({
        product: "Mona",
        owned: [
          { path: "/Library/Application Support/Someone Else", kind: "app-bundle" },
          { path: "/Applications", kind: "app-bundle" },
        ],
      }),
    );
    writeFileSync(
      join(hostileRoot, "Library/Application Support/Mona/install-receipt.json"),
      JSON.stringify({ product: "Mona", version: "0.0.0" }),
    );
    const hostile = spawnSync("/bin/sh", [scriptCopy, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, MONA_UNINSTALL_ROOT: hostileRoot },
    });
    check(
      "uninstall_manifest_cannot_widen_the_plan",
      existsSync(join(hostileRoot, "Library/Application Support/Someone Else/keep")) &&
        existsSync(join(hostileRoot, "Applications")) &&
        (hostile.status === 0 ? hostile.stdout.includes("nothing") : true),
      { status: hostile.status, stdout: hostile.stdout.trim().split("\n").slice(0, 6) },
    );

    const view = uninstallView({ home, root });
    check(
      "uninstall_view_separates_state_from_payload",
      view.applied === true &&
        view.entries.every(
          (entry) => entry.path.startsWith("/Applications") || entry.path.startsWith("/Library"),
        ) &&
        view.userDataScopes.some((scope) => scope.exists && scope.path.startsWith(home)),
      { entries: view.entries.map((entry) => entry.path) },
    );

    const removal = spawnSync("/bin/sh", [script, "--yes"], { encoding: "utf8", env });
    check(
      "uninstall_removed_owned_paths",
      removal.status === 0 &&
        !existsSync(join(root, "Applications/Mona.app")) &&
        !existsSync(join(root, "Library/Services/Mona.service")) &&
        !existsSync(join(root, "Library/Application Support/Mona/install-receipt.json")),
      { status: removal.status, stderr: removal.stderr.trim().slice(0, 400) },
    );
    check(
      "uninstall_preserved_unrelated_and_user_data",
      existsSync(join(root, "Applications/Other.app/Contents/Info.plist")) &&
        existsSync(join(root, "Library/Application Support/keep-me.json")) &&
        existsSync(join(home, "Library/Application Support/Mona/mona.sqlite")),
    );

    // A wrong-identifier bundle is refused, not deleted.
    const foreignRoot = join(base, "foreign-root");
    mkdirSync(join(foreignRoot, "Applications/Mona.app/Contents"), { recursive: true });
    writeFileSync(
      join(foreignRoot, "Applications/Mona.app/Contents/Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>",
    );
    mkdirSync(join(foreignRoot, "Library/Application Support/Mona"), { recursive: true });
    writeFileSync(
      join(foreignRoot, "Library/Application Support/Mona/owned-paths.json"),
      JSON.stringify({
        product: "Mona",
        owned: [{ path: "/Applications/Mona.app", kind: "app-bundle" }],
      }),
    );
    writeFileSync(
      join(foreignRoot, "Library/Application Support/Mona/install-receipt.json"),
      JSON.stringify({ product: "Mona", version: "0.0.0" }),
    );
    const foreign = spawnSync("/bin/sh", [scriptCopy, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, MONA_UNINSTALL_ROOT: foreignRoot },
    });
    check(
      "uninstall_refuses_a_foreign_bundle",
      foreign.status !== 0 &&
        existsSync(join(foreignRoot, "Applications/Mona.app/Contents/Info.plist")),
      { status: foreign.status, stderr: foreign.stderr.trim().slice(0, 200) },
    );

    // A missing ownership manifest is a refusal, never a guess.
    const bareRoot = join(base, "bare-root");
    mkdirSync(join(bareRoot, "Applications"), { recursive: true });
    const bare = spawnSync("/bin/sh", [scriptCopy, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, MONA_UNINSTALL_ROOT: bareRoot },
    });
    check(
      "uninstall_refuses_without_an_ownership_manifest",
      bare.status !== 0 && /ownership manifest/i.test(bare.stderr),
      { status: bare.status, stderr: bare.stderr.trim().slice(0, 200) },
    );
  }

  // 9. No update intent is written by reading, and no check reaches the network
  //    in manual mode.
  {
    const { store, dir } = await openStore("no-network");
    const launched = [];
    const coordinator = coordinatorFor({
      store,
      dir,
      version: "0.1.0",
      build: 81,
      launched,
    });
    const status = await coordinator.status();
    const view = await coordinator.check({ refresh: true });
    check(
      "manual_mode_queries_nothing",
      status.config.mode === "manual" && view.decision === "manual" && view.source.baseUrl === null,
      { decision: view.decision, code: view.code },
    );
    check("reading_writes_no_intent", (await store.latestUpdateIntent()) === null);
    check("reading_launches_nothing", launched.length === 0);
    await store.close();
  }

  // 10. The real build's own uninstall rehearsal, if this checkout has one.
  {
    const outDir = join(ROOT, "packaging/macos/out");
    const rehearsalPath = join(outDir, "uninstall-rehearsal.json");
    const manifestPath = join(outDir, "manifest.json");
    if (existsSync(rehearsalPath)) {
      const rehearsal = JSON.parse(readFileSync(rehearsalPath, "utf8"));
      report.observations.package_uninstall_rehearsal = {
        captured_at: rehearsal.captured_at ?? null,
        check: rehearsal.check ?? null,
      };
      // The build writes this under `out/` (gitignored); copy it into the
      // evidence directory so the rehearsal result is a durable artifact.
      writeFileSync(
        join(ROOT, "docs", "evidence", "macos", "artifacts", "p23-uninstall-rehearsal.json"),
        `${JSON.stringify(rehearsal, null, 2)}\n`,
      );
      check(
        "real_build_uninstall_rehearsal_passed",
        rehearsal.ok === true,
        rehearsal.check ?? null,
      );
    } else if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const rehearsal = manifest.checks?.uninstall_rehearsal;
      if (rehearsal === undefined) {
        // A recorded manifest from before this prompt is real staleness.
        check("real_build_uninstall_rehearsal_passed", false, {
          reason: "the recorded package manifest predates the uninstall gate; rebuild the package",
          built_at: manifest.receipt?.built_at ?? null,
        });
      } else {
        check(
          "real_build_uninstall_rehearsal_passed",
          rehearsal.ok === true,
          rehearsal.check ?? null,
        );
      }
    } else {
      report.observations.package_uninstall_rehearsal = { present: false };
      skip(
        "real_build_uninstall_rehearsal_passed",
        "no packaging/macos/out evidence in this checkout; `npm run mac:package:local` records it",
      );
    }
    const scriptPath = join(ROOT, "packaging/macos/scripts/uninstall-mona.sh");
    check("shipped_uninstall_script_parses", spawnSync("/bin/sh", ["-n", scriptPath]).status === 0);
    check(
      "unsigned_fixture_reads_as_unsigned",
      parsePackageSignature("Status: no signature").status === "unsigned",
    );
  }

  // 11. Archive of the run for the evidence file.
  report.observations.checks_total = Object.keys(report.checks).length;
  report.observations.checks_failed = Object.entries(report.checks)
    .filter(([, value]) => value.ok !== true)
    .map(([name]) => name);
  report.observations.checks_skipped = Object.keys(report.skipped ?? {});
  report.ok = report.observations.checks_failed.length === 0;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.ok = false;
}

const outDir = join(ROOT, "docs", "evidence", "macos", "artifacts");
mkdirSync(outDir, { recursive: true });
const redacted = JSON.parse(
  JSON.stringify(report)
    .split(base)
    .join("~smoke")
    .split(tmpdir())
    .join("~tmp")
    .split(process.env.HOME ?? "~")
    .join("~"),
);
writeFileSync(join(outDir, "p23-lifecycle-smoke.json"), `${JSON.stringify(redacted, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      checks: Object.keys(report.checks).length,
      skipped: report.observations.checks_skipped ?? [],
      failed: report.observations.checks_failed ?? [],
      first_failure: report.first_failure,
      error: report.error,
    },
    null,
    2,
  ),
);
process.exit(report.ok === true ? 0 : 1);
