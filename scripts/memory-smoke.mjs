#!/usr/bin/env node
// P19 smoke: project memory, prompt shelf, portable handoff, settings
// backup/restore, and the diagnostics bundle — against real stores in isolated
// temporary directories.
//
// The engine binary is replaced by a tripwire script. If anything on this
// surface starts an engine or a model call, the tripwire file appears and the
// run fails. Nothing here is mocked except the clock and the engine identity.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);

const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { ProjectMemory } = require(join(ROOT, "dist/main/main/work/memory.js"));
const { PromptShelf } = require(join(ROOT, "dist/main/main/work/shelf.js"));
const { ProjectHandoff } = require(join(ROOT, "dist/main/main/work/handoff.js"));
const { writeArchive, readArchive } = require(join(ROOT, "dist/main/main/state/safe-archive.js"));
const { discoverTools } = require(join(ROOT, "dist/main/main/tool-discovery.js"));

const base = mkdtempSync(join(tmpdir(), "mona-p19-smoke-"));
const home = join(base, "home");
const workspace = join(base, "workspace");
const tripwirePath = join(base, "engine-was-invoked");
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });

// Tripwire: any attempt to run the engine leaves a file and a non-zero exit.
// Named exactly what the app looks for, so a presence check finds it and any
// execution leaves a mark. Presence is a PATH stat; execution is the failure.
const tripwireEngine = join(base, "codewhale");
writeFileSync(
  tripwireEngine,
  `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(tripwirePath)}\nexit 97\n`,
  { mode: 0o755 },
);
chmodSync(tripwireEngine, 0o755);
process.env.CODEWHALE_BIN = tripwireEngine;
process.env.PATH = `${base}:${process.env.PATH ?? ""}`;

const SECRET = ["sk", "p19", `fixture${Date.now()}`].join("-");
const HOME_MARKER = home;

const report = {
  schema_version: 1,
  label: "P19 — project memory, portable handoff, and diagnostics",
  captured_at: new Date().toISOString(),
  ok: false,
  isolated_home: true,
  checks: {},
  observations: {},
  error: null,
  first_failure: null,
};

const check = (name, value, detail = null) => {
  report.checks[name] = { ok: value === true, ...(detail === null ? {} : { detail }) };
  if (value !== true && report.first_failure === null) report.first_failure = name;
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

let clockMs = Date.parse("2026-11-12T09:00:00.000Z");
const now = () => new Date((clockMs += 1_000));
let idCounter = 0;
const newId = (prefix) => `${prefix}_${(idCounter += 1).toString(16).padStart(8, "0")}`;

function openStore(name) {
  const dir = join(base, name);
  mkdirSync(join(dir, "state"), { recursive: true });
  return StateStore.open({
    dbPath: join(dir, "state", "mona.sqlite"),
    backupDir: join(dir, "backups"),
    artifactRoot: join(dir, "artifacts"),
    now,
    newId,
  });
}

let store = null;
let second = null;
let third = null;

try {
  store = await openStore("primary");

  // ---------------------------------------------------------------- fixture
  writeFileSync(join(workspace, "README.md"), "# P19 fixture\n\npacket builder notes\n");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "resume.ts"),
    [
      "// resume packet builder",
      "export function buildPacket() {",
      "  return 'packet';",
      "}",
      "",
    ].join("\n"),
  );
  mkdirSync(join(workspace, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(workspace, "node_modules", "left-pad", "index.js"), "packet\n");
  const outsideDir = join(base, "outside");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "secret.ts"), "packet outside the root\n");
  // A symlink that points outside the workspace must never be read.
  try {
    execFileSync("/bin/ln", ["-s", join(outsideDir, "secret.ts"), join(workspace, "escape.ts")]);
  } catch {
    // A host that refuses symlinks is fine; the check still holds vacuously.
  }
  writeFileSync(join(workspace, "binary.ts"), Buffer.from([0x00, 0x01, 0x70, 0x00]));
  writeFileSync(join(workspace, "ignored.pdf"), "packet\n");

  const project = await store.createProject({ name: "Recall", rootPath: workspace });
  const taskOne = await store.createTask({
    projectId: project.id,
    title: "Resume packet",
    prompt: "Build the resume packet from stored records only.",
    acceptance: [{ text: "packet renders", kind: "check" }],
    requirements: ["MONA-024"],
  });
  const taskTwo = await store.createTask({
    projectId: project.id,
    title: "Board polish",
    prompt: "Unrelated work.",
  });
  await store.addDecision({
    projectId: project.id,
    title: "Packet format",
    body: "The packet is plain text, never JSON.",
  });
  await store.addDecision({
    projectId: project.id,
    title: "Rotation key",
    body: `The sample credential is ${SECRET} and must never travel.`,
  });
  await store.addRequirementEvidence({
    projectId: project.id,
    requirementId: "MONA-024",
    path: "src/resume.ts",
    note: "packet builder and its test",
  });
  await store.addRequirementEvidence({
    projectId: project.id,
    requirementId: "MONA-025",
    path: "docs/absent-evidence.md",
    note: "a pointer whose file is not on this machine",
  });
  await store.recordAttempt({
    projectId: project.id,
    taskId: taskOne.id,
    problemId: "prob-1",
    requirement: "MONA-024",
    hypothesis: "the packet can be assembled locally",
    action: "read stored records",
    observed: "packet text produced",
    materialProgress: true,
    evidence: [],
  });
  await store.putSettings("polish:preferences", {
    notifications: { enabled: true },
    dockBadge: true,
    menuBarStatus: true,
    keepAwakeDuringWork: false,
    launchAtLogin: false,
  });
  await store.putSettings("tests:secret", { token: SECRET });
  // A project-scoped setting that looks like a credential must not travel in
  // the project export either, not merely be redacted.
  await store.putSettings(`project:${project.id}`, { keep: "this one" });
  await store.putSettings(`project:${project.id}:api-key`, { value: SECRET });

  // The engine identity the P19 surface reports comes from a stored capability
  // snapshot, not a probe. Record one, exactly as the capability explorer does.
  await store.saveCapabilitySnapshot({
    engineVersion: "0.10.2",
    engineCommit: "ff466b2ed0bf",
    payload: { source: "p19 smoke fixture" },
  });
  const recorded = await store.latestCapabilitySnapshot();
  const engineInfo = () => ({
    version: recorded?.engineVersion ?? null,
    commit: recorded?.engineCommit ?? null,
    binaryPresent: true,
    observedAt: recorded?.capturedAt ?? null,
  });
  // A snapshot recorded before this run, so the identity both workbenches read
  // is a stored observation rather than a probe.
  check("a stored capability snapshot supplies the engine identity", recorded !== null);

  const memory = new ProjectMemory({
    store,
    now,
    homeDir: home,
    engineInfo,
  });
  const shelf = new PromptShelf({ store, now, homeDir: home });
  const handoff = new ProjectHandoff({
    store,
    now,
    homeDir: home,
    engineInfo,
    productVersion: "0.1.0-p19",
    promptPack: async () => shelf.exportPack(),
  });
  const identity = engineInfo();
  check("the recorded identity is a snapshot, not a probe", identity.version === "0.10.2");

  // ---------------------------------------------------------------- search
  const revisionBefore = await store.stateRevision();
  const found = await memory.search({ projectId: project.id, query: "packet" });
  const foundAgain = await memory.search({ projectId: project.id, query: "packet" });
  const revisionAfter = await store.stateRevision();

  check("search finds records across sources", found.total >= 3, {
    total: found.total,
    sources: found.hits.map((hit) => hit.source),
  });
  check(
    "search is deterministic",
    JSON.stringify(found.hits.map((h) => h.id)) ===
      JSON.stringify(foundAgain.hits.map((h) => h.id)),
  );
  check("search is a read", revisionBefore === revisionAfter, {
    before: revisionBefore,
    after: revisionAfter,
  });
  check("search is not persisted", found.persisted === false);
  check("search redacts the fixture secret", !JSON.stringify(found).includes(SECRET), {
    redactions: found.redactions,
  });
  check("search reports redactions", found.redactions > 0, { redactions: found.redactions });

  const index = await memory.indexStatus(project.id);
  check("index declares no credentials", index.credentialsIndexed === false);
  check("index declares no embeddings", index.embeddings === false);
  check("index names repository contents as on demand", index.repositoryContents === "on_demand");
  check("index states exclusions", index.excluded.length >= 3, {
    excluded: index.excluded.map((entry) => entry.what),
  });
  const indexAgain = await memory.indexStatus(project.id);
  check("index digest is stable", index.digest === indexAgain.digest);

  // ------------------------------------------------------- workspace search
  const workspaceHits = await memory.searchWorkspace({
    projectId: project.id,
    query: "packet",
    limit: 50,
  });
  const hitPaths = workspaceHits.hits.map((hit) => hit.path);
  check("workspace search finds a source line", hitPaths.includes("src/resume.ts"), {
    paths: [...new Set(hitPaths)],
  });
  check(
    "workspace search skips node_modules",
    !hitPaths.some((path) => path.startsWith("node_modules/")),
  );
  check("workspace search skips a symlink that escapes the root", !hitPaths.includes("escape.ts"));
  check(
    "workspace search skips binary and unsupported files",
    workspaceHits.skippedReasons.some((reason) => reason.reason === "binary") &&
      workspaceHits.skippedReasons.some((reason) => reason.reason === "extension"),
    { skipped: workspaceHits.skippedReasons },
  );
  check("workspace search persists nothing", workspaceHits.persisted === false);
  check("workspace search is still a read", (await store.stateRevision()) === revisionBefore);

  // --------------------------------------------------------- prompt shelf
  const saved = await shelf.save({
    label: "Explain a change",
    description: "Explain what changed and why.",
    body: "Explain {{area}} to {{audience}} with acceptance: {{criteria}}.",
    acceptance: ["Names the files", "States the verification"],
    tags: ["review"],
    note: "first version",
  });
  const rendered = await shelf.render({
    promptId: saved.id,
    values: { area: "the packet builder", audience: "a new contributor" },
  });
  check("shelf substitutes supplied variables", rendered.text.includes("the packet builder"));
  check("shelf reports a missing variable", rendered.missing.includes("criteria"), {
    missing: rendered.missing,
  });
  check("shelf keeps the unfilled token visible", rendered.text.includes("{{criteria}}"));
  check("shelf render is inert", rendered.inert === true);

  const savedAgain = await shelf.save({
    id: saved.id,
    label: "Explain a change",
    body: "Explain {{area}} and {{criteria}}.",
    acceptance: ["Names the files"],
  });
  check("shelf appends a version only on a real change", savedAgain.currentVersion === 2, {
    version: savedAgain.currentVersion,
    versions: savedAgain.versions.length,
  });

  let refusedSecret = false;
  try {
    await shelf.save({ label: "Leak", body: `here is ${SECRET}` });
  } catch (error) {
    refusedSecret = error?.code === "INVALID_INPUT";
  }
  check("shelf refuses secret-shaped text", refusedSecret);

  const pack = await shelf.exportPack();
  check("prompt pack carries a digest", /^[a-f0-9]{64}$/.test(pack.digest), {
    prompts: pack.prompts.length,
  });
  const packText = JSON.stringify(pack);
  check("prompt pack contains no fixture secret", !packText.includes(SECRET));
  const packPath = join(base, "prompts.json");
  writeFileSync(packPath, packText);

  // ------------------------------------------------------------- handoff
  const preview = await handoff.preview(project.id);
  check("handoff preview counts real records", preview.counts.tasks === 2, {
    counts: preview.counts,
  });
  check("handoff preview names what it cannot carry", preview.excluded.length >= 4, {
    excluded: preview.excluded.map((entry) => entry.what),
  });
  check(
    "handoff drops a credential-bearing project setting",
    preview.excluded.some((entry) => entry.what.includes("api-key")),
    { excluded: preview.excluded.map((entry) => entry.what) },
  );
  check("handoff preview reports evidence pointers", preview.counts.pointers >= 2, {
    pointers: preview.counts.pointers,
  });
  check("handoff preview is exportable", preview.canExport === true);

  const handoffPath = join(base, "recall-handoff.zip");
  const exported = await handoff.exportToFile(project.id, handoffPath);
  check("handoff export wrote an archive", exported.saved === true && exported.bytes > 0, {
    bytes: exported.bytes,
    entries: exported.entries,
  });
  check("handoff export keeps the file private", (statSync(handoffPath).mode & 0o777) === 0o600, {
    mode: (statSync(handoffPath).mode & 0o777).toString(8),
  });

  const parsed = readArchive(readFileSync(handoffPath));
  check("handoff archive is safe to read", parsed.safe === true, { problems: parsed.problems });
  const entryNames = parsed.entries.map((entry) => entry.path).sort();
  check(
    "handoff archive has the documented entries",
    entryNames.includes("manifest.json") &&
      entryNames.includes("project.json") &&
      entryNames.includes("README.md"),
    {
      entries: entryNames,
    },
  );
  const bundleText = parsed.entries
    .filter((entry) => entry.path !== "manifest.json")
    .map((entry) => entry.data.toString("utf8"))
    .join("\n");
  check("handoff archive carries no fixture secret", !bundleText.includes(SECRET), {
    bytes: bundleText.length,
  });
  check("handoff archive carries no home path", !bundleText.includes(HOME_MARKER));
  check(
    "handoff archive drops the credential-bearing project scope",
    !bundleText.includes("api-key"),
    { mentionsApiKey: bundleText.includes("api-key") },
  );
  check("handoff archive keeps an ordinary project setting", bundleText.includes("this one"));

  const inspected = await handoff.inspect(handoffPath);
  check("handoff inspection is ok", inspected.ok === true, { problems: inspected.problems });
  check(
    "handoff inspection names the missing local file",
    inspected.missingLocalFiles.some((entry) => entry.path.includes("absent-evidence")),
    { missing: inspected.missingLocalFiles },
  );
  check("handoff inspection requires requalification", inspected.requalification.required === true);
  check(
    "handoff requalification reads a recorded engine identity",
    inspected.requalification.localEngine.version === "0.10.2" &&
      inspected.requalification.source === "capability_snapshot",
    {
      localEngine: inspected.requalification.localEngine,
      source: inspected.requalification.source,
    },
  );
  check("handoff inspection lists what cannot transfer", inspected.cannotTransfer.length >= 4, {
    cannotTransfer: inspected.cannotTransfer,
  });

  // Import into a clean store whose folder really holds the evidence file.
  second = await openStore("secondary");
  const secondHandoff = new ProjectHandoff({
    store: second,
    now,
    homeDir: home,
    engineInfo,
    productVersion: "0.1.0-p19",
  });
  const imported = await secondHandoff.importFrom({
    path: handoffPath,
    rootPath: workspace,
    mode: "create",
  });
  check("handoff import creates the records", imported.imported.tasks === 2, {
    imported: imported.imported,
  });
  check("handoff import starts no work", imported.startedWork === false);
  const importedTasks = await second.listTasks(project.id);
  check(
    "handoff import leaves no active turn",
    importedTasks.every((task) => !task.activeTurnId),
  );
  check(
    "handoff import still names the stale pointer",
    imported.missingLocalFiles.some((entry) => entry.path.includes("absent-evidence")),
  );

  // Tampering: rebuild the archive with a modified entry but the old manifest.
  const tampered = parsed.entries.map((entry) =>
    entry.path === "decisions.md"
      ? { path: entry.path, data: Buffer.from("# rewrote the decisions\n") }
      : { path: entry.path, data: entry.data },
  );
  const tamperedPath = join(base, "tampered-handoff.zip");
  writeFileSync(tamperedPath, writeArchive(tampered), { mode: 0o600 });
  const tamperedInspection = await handoff.inspect(tamperedPath);
  check("handoff rejects a tampered entry", tamperedInspection.ok === false, {
    problems: tamperedInspection.problems,
  });

  // A hostile archive: modelled byte-for-byte, because Mona's own writer would
  // refuse to create it. Nothing is extracted at all, so nothing can escape.
  const hostilePath = join(base, "hostile.zip");
  const escapeTarget = join(base, "..", "p19-should-not-exist.txt");
  writeFileSync(hostilePath, hostileZip("../p19-should-not-exist.txt", Buffer.from("pwn")), {
    mode: 0o600,
  });
  const hostile = await handoff.inspect(hostilePath);
  check(
    "handoff refuses an escaping path",
    hostile.ok === false && hostile.problems.some((line) => line.includes("PATH_ESCAPE")),
    { problems: hostile.problems },
  );
  check("nothing escaped to disk", !existsSync(escapeTarget));

  // ------------------------------------------------- settings backup/restore
  const backup = await handoff.settingsBackup();
  check(
    "settings backup excludes a secret-bearing scope",
    backup.excluded.some((entry) => entry.scope === "tests:secret"),
    { excluded: backup.excluded },
  );
  check(
    "settings backup includes a real scope",
    backup.scopes.some((scope) => scope.scope === "polish:preferences" && scope.included),
  );
  check("settings backup text carries no fixture secret", !backup.text.includes(SECRET));

  const backupPath = join(base, "settings-backup.zip");
  const backupWritten = await handoff.exportSettingsToFile(backupPath);
  check(
    "settings backup wrote an archive",
    backupWritten.saved === true && backupWritten.bytes > 0,
  );
  const backupInspection = await handoff.inspectSettingsBackup(backupPath);
  check("settings backup inspects cleanly", backupInspection.ok === true, {
    problems: backupInspection.problems,
  });

  third = await openStore("tertiary");
  await third.putSettings("polish:preferences", { dockBadge: false });
  const thirdHandoff = new ProjectHandoff({
    store: third,
    now,
    homeDir: home,
    engineInfo,
    productVersion: "0.1.0-p19",
  });

  let replaceRefused = false;
  try {
    await thirdHandoff.restoreSettings({ path: backupPath, mode: "replace" });
  } catch (error) {
    replaceRefused = error?.code === "INVALID_INPUT";
  }
  check("a replace restore needs explicit confirmation", replaceRefused);

  // A stale revision is refused inside the store's exclusive barrier.
  const revisionBeforeRestore = await third.stateRevision();
  let staleRefused = false;
  try {
    await thirdHandoff.restoreSettings({
      path: backupPath,
      mode: "merge",
      expectedRevision: revisionBeforeRestore + 500,
    });
  } catch (error) {
    staleRefused = error?.code === "STALE_REVISION";
  }
  check("a stale revision refuses the restore", staleRefused);
  check(
    "a refused restore changed nothing",
    (await third.stateRevision()) === revisionBeforeRestore,
    { before: revisionBeforeRestore, after: await third.stateRevision() },
  );

  // A concurrent writer must not slip inside the maintenance barrier.
  const concurrent = third.putSettings("concurrent:probe", { touched: true });
  const restoreReceipt = await thirdHandoff.restoreSettings({
    path: backupPath,
    mode: "merge",
  });
  await concurrent;
  check(
    "settings restore applied the backup",
    restoreReceipt.restored === true && restoreReceipt.applied.length >= 1,
    { applied: restoreReceipt.applied },
  );
  check("settings restore ran under the exclusive barrier", restoreReceipt.barrier === "exclusive");
  check("settings restore wrote a journal", existsSync(restoreReceipt.journal));
  check("settings restore wrote a snapshot", existsSync(restoreReceipt.snapshot));
  check("settings restore released the barrier", third.barrier.snapshot().maintenance === false);
  check(
    "the concurrent write survived the restore",
    (await third.getSettings("concurrent:probe")) !== null,
  );
  // Compare by content, not key order: the backup document is canonicalised,
  // so a restored value legitimately comes back with sorted keys.
  const restoredRow = await third.getSettings("polish:preferences");
  const restoredPreferences = restoredRow?.value ?? null;
  const restoredValue =
    restoredPreferences && typeof restoredPreferences === "object"
      ? restoredPreferences
      : { notifications: { enabled: false } };
  check(
    "the restored scope holds the backup value",
    restoredRow !== null &&
      restoredValue.notifications?.enabled === true &&
      restoredValue.dockBadge === true &&
      restoredValue.menuBarStatus === true &&
      restoredValue.keepAwakeDuringWork === false &&
      restoredValue.launchAtLogin === false,
    { restored: restoredPreferences },
  );

  // ------------------------------------------------------------ diagnostics
  const diagnostics = await handoff.diagnosticsPreview(project.id);
  const parsedDiagnostics = JSON.parse(diagnostics.text);
  check("diagnostics parse as JSON", typeof parsedDiagnostics === "object");
  check("diagnostics name the product version", parsedDiagnostics.product_version === "0.1.0-p19");
  check("diagnostics contain no home path", !diagnostics.text.includes(HOME_MARKER));
  check("diagnostics contain no fixture secret", !diagnostics.text.includes(SECRET));
  check("diagnostics exclude environment", diagnostics.environmentIncluded === false);
  check("diagnostics exclude credentials", diagnostics.credentialsIncluded === false);
  // The decision body carries a fixture secret and a home path, so a document
  // built from local facts must report at least one substitution.
  check("diagnostics report their redactions", diagnostics.redactions > 0, {
    redactions: diagnostics.redactions,
  });
  check("diagnostics digest matches their text", diagnostics.digest === sha256(diagnostics.text));
  check(
    "diagnostics list what they exclude",
    diagnostics.excluded.some((line) => line.toLowerCase().includes("environment")),
    { excluded: diagnostics.excluded },
  );

  // ------------------------------------------------------- context preview
  const slots = await memory.contextSlots(project.id, taskOne.id);
  check("context slots cover the contract", slots.length === 7, { slots: slots.length });
  const promptOnly = await memory.contextSelection({
    projectId: project.id,
    taskId: taskOne.id,
    include: ["prompt"],
  });
  const withDecisions = await memory.contextSelection({
    projectId: project.id,
    taskId: taskOne.id,
    include: ["prompt", "decisions", "prior_attempts"],
  });
  check("context preview grows with the selection", withDecisions.bytes > promptOnly.bytes, {
    promptOnly: promptOnly.bytes,
    withDecisions: withDecisions.bytes,
  });
  check("context preview shows the decision", withDecisions.text.includes("Packet format"));
  check(
    "context preview refuses to claim the provider request",
    withDecisions.exactProviderRequest === false && withDecisions.providerRequestNote.length > 0,
  );
  check("context preview never carries the secret", !withDecisions.text.includes(SECRET));

  const resume = await memory.resumePacket(project.id);
  check(
    "resume packet names a current task",
    resume.text.includes("Current task:") &&
      (resume.text.includes("Resume packet") || resume.text.includes("Board polish")),
    { head: resume.text.split("\n").slice(0, 5) },
  );
  check("resume packet states the limit", resume.text.includes("not inspectable"));
  check("resume packet carries no secret", !resume.text.includes(SECRET));
  check("resume packet is not a provider request", resume.exactProviderRequest === false);

  // ----------------------------------------------------- zero inference
  // Prove the tripwire is real before trusting its silence: the engine lookup
  // must resolve to the tripwire, so any execution anywhere in this run would
  // have left a mark.
  const discovered = discoverTools(["codewhale"])[0];
  check("the tripwire engine is what discovery finds", discovered?.path === tripwireEngine, {
    discovered: discovered ?? null,
  });
  check("no engine binary was invoked", !existsSync(tripwirePath), {
    tripwire: existsSync(tripwirePath) ? readFileSync(tripwirePath, "utf8") : null,
  });
  const p19Modules = ["memory.js", "shelf.js", "handoff.js"].map((name) =>
    join(ROOT, "dist/main/main/work", name),
  );
  const forbidden = ["node:http", "node:https", "node:net", "node:tls", "undici", "fetch("];
  const source = p19Modules.map((path) => readFileSync(path, "utf8")).join("\n");
  check(
    "the P19 modules reference no network API",
    !forbidden.some((needle) => source.includes(needle)),
    { scanned: p19Modules.length },
  );
  check(
    "the P19 modules do not import the engine adapter",
    !/require\(["'][^"']*engine\//.test(source) && !/from ["'][^"']*engine\//.test(source),
  );
  check("the P19 modules do not start a child process", !source.includes("child_process"));

  const stats = await store.stats();
  report.observations = {
    project: { id: project.id, name: project.name },
    tasks: [taskOne.id, taskTwo.id],
    search: {
      total: found.total,
      considered: found.considered,
      durationMs: found.durationMs,
      redactions: found.redactions,
      sources: found.hits.map((hit) => ({
        source: hit.source,
        title: hit.title,
        score: hit.score,
      })),
    },
    index: {
      digest: index.digest,
      counts: index.counts,
      stateRevision: index.stateRevision,
    },
    workspace: {
      filesScanned: workspaceHits.filesScanned,
      filesSkipped: workspaceHits.filesSkipped,
      bytesScanned: workspaceHits.bytesScanned,
      hits: workspaceHits.hits.length,
      scope: workspaceHits.scope,
    },
    shelf: {
      id: saved.id,
      versions: savedAgain.currentVersion,
      packDigest: pack.digest,
      renderedBytes: rendered.bytes,
    },
    handoff: {
      entries: entryNames,
      bytes: exported.bytes,
      digest: exported.digest,
      redactions: exported.redactions,
      counts: preview.counts,
      missingLocalFiles: inspected.missingLocalFiles,
      cannotTransfer: inspected.cannotTransfer,
      requalification: inspected.requalification,
    },
    restored_preferences: restoredPreferences,
    settings: {
      included: backup.scopes.filter((scope) => scope.included).map((scope) => scope.scope),
      excluded: backup.excluded,
      restore: restoreReceipt,
    },
    diagnostics: {
      digest: diagnostics.digest,
      bytes: diagnostics.bytes,
      redactions: diagnostics.redactions,
      excluded: diagnostics.excluded,
    },
    state: stats,
  };

  report.ok = Object.values(report.checks).every((entry) => entry.ok);
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  for (const handle of [store, second, third]) {
    if (!handle) continue;
    try {
      await handle.close();
    } catch (error) {
      report.close_error = String(error);
    }
  }
}

/**
 * Build a one-entry store-only zip with an arbitrary name. This is the only way
 * to model an archive Mona would never produce, so the reader's own defence is
 * what gets exercised.
 */
function hostileZip(name, data) {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const nameBuffer = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const block = Buffer.concat([local, nameBuffer, data]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuffer.length, 12);
  end.writeUInt32LE(block.length, 16);
  return Buffer.concat([block, central, nameBuffer, end]);
}

const outDir = join(ROOT, "docs", "evidence", "macos", "artifacts");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "p19-memory-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      checks: Object.keys(report.checks).length,
      failed: Object.entries(report.checks)
        .filter(([, value]) => value.ok !== true)
        .map(([name]) => name),
      first_failure: report.first_failure,
      error: report.error,
    },
    null,
    2,
  ),
);
process.exit(report.ok === true ? 0 : 1);
