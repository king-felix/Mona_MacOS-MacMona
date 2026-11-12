import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts/ids";
import { readArchive, writeArchiveFile } from "../src/main/state/safe-archive";
import { ProjectHandoff } from "../src/main/work/handoff";
import { redactDiagnostics } from "../src/main/work/settings";
import { makeClock, openTestStore } from "./helpers/state";

const EVIDENCE_RELATIVE = "docs/evidence/P05-state.md";
const EVIDENCE_TEXT = "state work evidence\n";
const PRODUCT_VERSION = "0.1.0-p02";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = (CRC_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Build a store-only zip with an arbitrary entry name, bypassing the writer's
 * validation. The reader must defend itself; it must not rely on having written
 * the file.
 */
function hostileZip(name: string, data: Buffer): Buffer {
  const checksum = crc(data);
  const nameBuffer = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const localBlock = Buffer.concat([local, nameBuffer, data]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuffer.length, 12);
  end.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, central, nameBuffer, end]);
}

function makeHandoff(
  store: Awaited<ReturnType<typeof openTestStore>>["store"],
  dir: string,
  options: Partial<ConstructorParameters<typeof ProjectHandoff>[0]> = {},
): ProjectHandoff {
  return new ProjectHandoff({
    store,
    now: makeClock("2026-11-12T00:00:00.000Z").now,
    homeDir: join(dir, "home"),
    productVersion: PRODUCT_VERSION,
    engineInfo: () => ({ version: "0.10.2", commit: "ff466b2ed0bf", binaryPresent: true }),
    ...options,
  });
}

async function seededProject() {
  const handle = await openTestStore();
  const folder = join(handle.dir, "fixture");
  mkdirSync(join(folder, "docs", "evidence"), { recursive: true });
  writeFileSync(join(folder, "docs", "evidence", "P05-state.md"), EVIDENCE_TEXT);
  const evidenceDigest = createHash("sha256").update(EVIDENCE_TEXT).digest("hex");

  const project = await handle.store.createProject({
    name: "Handoff fixture",
    rootPath: folder,
    accent: "#6346DF",
    monogram: "HO",
  });
  const firstTask = await handle.store.createTask({
    projectId: project.id,
    title: "First task",
    prompt: "Do the first thing",
    requirements: ["MONA-005"],
    acceptance: [{ text: "first check", kind: "check" }],
  });
  await handle.store.createTask({
    projectId: project.id,
    title: "Second task",
    prompt: "Do the second thing",
    acceptance: [{ text: "second check", kind: "human" }],
  });
  await handle.store.addDecision({
    projectId: project.id,
    title: "Portable decisions",
    body: "Carry records and pointers, not engine sessions.",
  });
  await handle.store.addRequirementEvidence({
    projectId: project.id,
    taskId: firstTask.id,
    requirementId: "MONA-005",
    path: EVIDENCE_RELATIVE,
    digest: evidenceDigest,
  });
  await handle.store.recordAttempt({
    projectId: project.id,
    taskId: firstTask.id,
    problemId: "P05-1",
    requirement: "MONA-005",
    hypothesis: "the store holds the record",
    action: "export it",
    observed: "it exported",
    materialProgress: false,
  });

  const handoff = makeHandoff(handle.store, handle.dir);
  const destination = join(handle.dir, "handoff.zip");
  return { handle, folder, project, handoff, destination, evidenceDigest };
}

describe("project handoff", () => {
  it("exports a seeded project and inspects a valid, digest-verified bundle", async () => {
    const seeded = await seededProject();
    const preview = await seeded.handoff.preview(seeded.project.id);
    expect(preview.canExport).toBe(true);
    expect(preview.counts).toEqual({
      tasks: 2,
      decisions: 1,
      evidence: 1,
      attempts: 1,
      prompts: 0,
      pointers: 1,
    });
    expect(preview.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["manifest.json", "project.json", "pointers.json", "decisions.md"]),
    );
    expect(preview.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.digest))).toBe(true);

    const exported = await seeded.handoff.exportToFile(seeded.project.id, seeded.destination);
    expect(exported.saved).toBe(true);
    expect(exported.path).toBe(seeded.destination);
    expect(exported.bytes).toBeGreaterThan(0);
    expect(exported.entries).toBe(5);
    expect(statSync(seeded.destination).mode & 0o777).toBe(0o600);

    const inspection = await seeded.handoff.inspect(seeded.destination);
    expect(inspection.problems).toEqual([]);
    expect(inspection.ok).toBe(true);
    expect(inspection.manifest?.format).toBe("mona-handoff");
    expect(inspection.project).toMatchObject({
      id: seeded.project.id,
      tasks: 2,
      decisions: 1,
      evidence: 1,
      attempts: 1,
    });
    expect(inspection.missingLocalFiles).toEqual([]);
    expect(inspection.staleDigests).toEqual([]);
    expect(inspection.cannotTransfer).toContain("engine conversation history and sessions");
    expect(inspection.cannotTransfer.some((item) => /credential/i.test(item))).toBe(true);
    expect(inspection.requalification.required).toBe(true);
    expect(inspection.requalification.machineBinding).toBe("requalified");

    // The archive vouches for its own contents. Preview and export are separate
    // calls with separate clocks, and `manifest.json` and `README.md` both embed
    // `created_at`, so the durable guarantee is self-consistency: every entry's
    // bytes hash to the digest the manifest declares, and the manifest digest
    // reproduces from those entries.
    const parsed = readArchive(readFileSync(seeded.destination));
    expect(preview.entries.map((entry) => entry.path).sort()).toEqual(
      parsed.entries.map((entry) => entry.path).sort(),
    );
    const manifestEntry = parsed.entries.find((entry) => entry.path === "manifest.json");
    expect(manifestEntry).toBeDefined();
    const manifest = JSON.parse(manifestEntry?.data.toString("utf8") ?? "{}") as {
      digest: string;
      entries: Array<{ path: string; digest: string; size_bytes: number }>;
    };
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(
      parsed.entries
        .map((entry) => entry.path)
        .filter((path) => path !== "manifest.json")
        .sort(),
    );
    for (const entry of manifest.entries) {
      const actual = parsed.entries.find((candidate) => candidate.path === entry.path);
      expect(actual?.digest).toBe(entry.digest);
      expect(actual?.data.length).toBe(entry.size_bytes);
    }
    const recomputed = createHash("sha256")
      .update(
        manifest.entries
          .map((entry) => `${entry.path}\0${entry.digest}\n`)
          .sort()
          .join(""),
      )
      .digest("hex");
    expect(manifest.digest).toBe(recomputed);

    // The store stamps its own bundle (`exported_at`) with the store clock, so
    // two previews are not byte-identical by design. What must hold is that the
    // preview names exactly the entries the archive writes and that record
    // counts come from the stored payload.
    const repeat = await seeded.handoff.preview(seeded.project.id);
    expect(repeat.entries.map((entry) => entry.path)).toEqual(
      preview.entries.map((entry) => entry.path),
    );
    expect(repeat.counts).toEqual(preview.counts);

    // Never overwrite an existing destination.
    await expect(
      seeded.handoff.exportToFile(seeded.project.id, seeded.destination),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await seeded.handle.store.close();
  });

  it("imports into a clean store without starting work", async () => {
    const seeded = await seededProject();
    await seeded.handoff.exportToFile(seeded.project.id, seeded.destination);
    const sourceRevision =
      (await seeded.handoff.inspect(seeded.destination)).project?.revision ?? 0;

    const target = await openTestStore();
    const targetHandoff = makeHandoff(target.store, target.dir);
    const result = await targetHandoff.importFrom({
      path: seeded.destination,
      rootPath: seeded.folder,
    });
    expect(result.startedWork).toBe(false);
    expect(result.problems).toEqual([]);
    expect(result.missingLocalFiles).toEqual([]);
    expect(result.imported).toMatchObject({
      tasks: 2,
      decisions: 1,
      evidence: 1,
      attempts: 1,
      acceptance: 2,
      steps: 0,
    });

    const projectId = result.projectId as ProjectId;
    const tasks = await target.store.listTasks(projectId);
    expect(tasks).toHaveLength(2);
    for (const task of tasks) expect(task.activeTurnId).toBeNull();
    expect(await target.store.listDecisions(projectId)).toHaveLength(1);
    expect(await target.store.listRequirementEvidence(projectId)).toHaveLength(1);

    const imported = await target.store.getProject(projectId);
    // The revision comes from the bundle (or one bump for a replace); it is never invented.
    expect(imported?.revision).toBeGreaterThanOrEqual(sourceRevision);
    expect(imported?.revision).toBeLessThanOrEqual(sourceRevision + 1);

    await target.store.close();
    await seeded.handle.store.close();
  });

  it("reports missing evidence when the destination root lacks the file", async () => {
    const seeded = await seededProject();
    await seeded.handoff.exportToFile(seeded.project.id, seeded.destination);

    const target = await openTestStore();
    const otherRoot = join(target.dir, "different-root");
    mkdirSync(otherRoot, { recursive: true });
    const targetHandoff = makeHandoff(target.store, target.dir);
    const result = await targetHandoff.importFrom({
      path: seeded.destination,
      rootPath: otherRoot,
    });
    expect(result.missingLocalFiles).toEqual([
      { path: EVIDENCE_RELATIVE, requirement: "MONA-005" },
    ]);

    await target.store.close();
    await seeded.handle.store.close();
  });

  it("refuses a bundle whose entry bytes were changed after the manifest was written", async () => {
    const seeded = await seededProject();
    await seeded.handoff.exportToFile(seeded.project.id, seeded.destination);

    const original = readArchive(readFileSync(seeded.destination));
    const tamperedPath = join(seeded.handle.dir, "tampered.zip");
    writeArchiveFile(
      tamperedPath,
      original.entries.map((entry) => ({
        path: entry.path,
        data:
          entry.path === "decisions.md"
            ? Buffer.from("# Tampered\n\nchanged after the manifest\n")
            : entry.data,
      })),
    );

    const inspection = await seeded.handoff.inspect(tamperedPath);
    expect(inspection.ok).toBe(false);
    expect(inspection.problems.some((problem) => problem.startsWith("DIGEST_MISMATCH"))).toBe(true);
    await expect(
      seeded.handoff.importFrom({ path: tamperedPath, rootPath: seeded.folder }),
    ).rejects.toMatchObject({ code: "IMPORT_DIGEST_MISMATCH" });

    await seeded.handle.store.close();
  });

  it("refuses a hostile zip that tries to escape the extraction root", async () => {
    const handle = await openTestStore();
    const handoff = makeHandoff(handle.store, handle.dir);
    const nested = join(handle.dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const hostilePath = join(nested, "hostile.zip");
    writeFileSync(hostilePath, hostileZip("../../escape.txt", Buffer.from("escape")));
    // `../../escape.txt` from the archive's own folder lands here; it must not appear.
    const escaped = resolve(nested, "../../escape.txt");
    expect(escaped).toBe(join(handle.dir, "escape.txt"));
    expect(existsSync(escaped)).toBe(false);

    const inspection = await handoff.inspect(hostilePath);
    expect(inspection.ok).toBe(false);
    expect(inspection.problems.some((problem) => problem.startsWith("PATH_ESCAPE"))).toBe(true);
    // Inspection never extracts, so nothing appears outside the temp root.
    expect(existsSync(escaped)).toBe(false);

    await handle.store.close();
  });
});

describe("settings backup and restore", () => {
  it("excludes secret-shaped scopes and restores included scopes", async () => {
    const secret = "sk-" + "a".repeat(24);
    const handle = await openTestStore();
    const handoff = makeHandoff(handle.store, handle.dir);
    await handle.store.putSettings("demo:route", { apiKey: secret, note: "primary" });
    await handle.store.putSettings("demo:profile", { posture: "ask", autoApprove: false });
    await handle.store.putSettings("provider:credential", { handle: "keychain" });

    const backup = await handoff.settingsBackup();
    const secretScope = backup.excluded.find((entry) => entry.scope === "demo:route");
    expect(secretScope?.why).toContain("provider_key");
    expect(backup.excluded.some((entry) => entry.scope === "provider:credential")).toBe(true);
    expect(backup.scopes.find((entry) => entry.scope === "demo:route")?.included).toBe(false);
    expect(backup.scopes.filter((entry) => entry.included).map((entry) => entry.scope)).toEqual([
      "demo:profile",
    ]);
    // The value never appears in the document that would be written.
    expect(backup.text.includes(secret)).toBe(false);

    const backupPath = join(handle.dir, "settings-backup.zip");
    const exported = await handoff.exportSettingsToFile(backupPath);
    expect(exported.saved).toBe(true);
    expect(exported.scopes).toBe(1);
    expect(exported.bytes).toBeGreaterThan(0);

    const inspection = await handoff.inspectSettingsBackup(backupPath);
    expect(inspection.ok).toBe(true);
    expect(inspection.scopes.map((scope) => scope.scope)).toEqual(["demo:profile"]);
    expect(inspection.scopes[0]?.action).toBe("noop");
    expect(inspection.scopes[0]?.localVersion).toBe(1);

    const third = await openTestStore();
    const thirdHandoff = makeHandoff(third.store, third.dir);
    const created = await thirdHandoff.inspectSettingsBackup(backupPath);
    expect(created.scopes[0]?.action).toBe("create");

    const restored = await thirdHandoff.restoreSettings({ path: backupPath, mode: "merge" });
    expect(restored.restored).toBe(true);
    expect(restored.applied.map((entry) => entry.scope)).toEqual(["demo:profile"]);
    expect(restored.barrier).toBe("exclusive");
    expect(restored.journal.length).toBeGreaterThan(0);
    expect(restored.snapshot.length).toBeGreaterThan(0);
    expect(restored.stateRevision).toBeGreaterThan(0);
    expect(await third.store.getSettings("demo:profile")).not.toBeNull();
    // The credential-bearing scope was never in the backup and was not restored.
    expect(await third.store.getSettings("provider:credential")).toBeNull();

    await expect(
      thirdHandoff.restoreSettings({ path: backupPath, mode: "replace" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      thirdHandoff.restoreSettings({ path: backupPath, mode: "merge", expectedRevision: 999_999 }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    await third.store.close();
    await handle.store.close();
  });

  it("restores under the exclusive barrier and leaves it released", async () => {
    const handle = await openTestStore();
    const handoff = makeHandoff(handle.store, handle.dir);
    await handle.store.putSettings("app:theme", { mode: "dark" });
    const backupPath = join(handle.dir, "barrier-backup.zip");
    await handoff.exportSettingsToFile(backupPath);

    // A concurrent write is queued behind the restore's maintenance barrier.
    const pending = handle.store.putSettings("app:concurrent", { during: true });
    const restored = await handoff.restoreSettings({ path: backupPath, mode: "merge" });
    await pending;

    expect(restored.applied.map((entry) => entry.scope)).toEqual(["app:theme"]);
    const theme = await handle.store.getSettings("app:theme");
    expect(theme?.value).toEqual({ mode: "dark" });
    expect(theme?.version).toBe(2);
    expect(await handle.store.getSettings("app:concurrent")).not.toBeNull();
    expect(handle.store.barrier.snapshot().maintenance).toBe(false);

    await handle.store.close();
  });
});

describe("diagnostics preview", () => {
  it("is redacted, local-only, and names what it excludes", async () => {
    const secret = "sk-" + "c".repeat(24);
    const handle = await openTestStore();
    const folder = join(handle.dir, "diagnostics-project");
    mkdirSync(folder, { recursive: true });
    const project = await handle.store.createProject({
      name: "Diagnostics project",
      rootPath: folder,
    });
    await handle.store.putSettings("engine:route", { apiKey: secret });
    const homeDir = join(handle.dir, "home");
    const handoff = makeHandoff(handle.store, handle.dir, { homeDir });

    const preview = await handoff.diagnosticsPreview(project.id);
    const document = JSON.parse(preview.text) as {
      product_version?: string;
      project?: { id?: string; tasks?: number } | null;
      excluded?: string[];
    };
    expect(document.product_version).toBe(PRODUCT_VERSION);
    expect(document.project?.id).toBe(project.id);
    expect(document.excluded).toEqual(
      expect.arrayContaining(["environment variables", "provider credentials", "settings values"]),
    );
    expect(preview.text.includes(homeDir)).toBe(false);
    expect(preview.text.includes(secret)).toBe(false);
    expect(preview.credentialsIncluded).toBe(false);
    expect(preview.environmentIncluded).toBe(false);
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]?.name).toBe("diagnostics.json");
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.bytes).toBe(Buffer.byteLength(preview.text, "utf8"));

    await handle.store.close();
  });
});

describe("handoff redaction", () => {
  it("never carries a literal secret seeded in a decision body", async () => {
    const handle = await openTestStore();
    const folder = join(handle.dir, "secret-project");
    mkdirSync(folder, { recursive: true });
    const project = await handle.store.createProject({
      name: "Secret project",
      rootPath: folder,
    });
    const secret = "sk-" + "b".repeat(24);
    await handle.store.addDecision({
      projectId: project.id,
      title: "Secret decision",
      body: `Keep ${secret} out of every bundle.`,
    });
    const handoff = makeHandoff(handle.store, handle.dir);
    const destination = join(handle.dir, "secret-handoff.zip");
    await handoff.exportToFile(project.id, destination);

    const parsed = readArchive(readFileSync(destination));
    const decisions = parsed.entries.find((entry) => entry.path === "decisions.md");
    const projectJson = parsed.entries.find((entry) => entry.path === "project.json");
    expect(decisions).toBeDefined();
    expect(projectJson).toBeDefined();
    expect(decisions?.data.toString("utf8")).not.toContain(secret);
    expect(projectJson?.data.toString("utf8")).not.toContain(secret);
    expect(decisions?.data.toString("utf8")).toContain("# Secret decision");

    // The redacted project.json still verifies as a bundle.
    const inspection = await handoff.inspect(destination);
    expect(inspection.ok).toBe(true);
    expect(inspection.problems).toEqual([]);

    // The redactor is the same one the diagnostics preview uses.
    expect(redactDiagnostics(`body ${secret}`, join(handle.dir, "home")).text).not.toContain(
      secret,
    );

    await handle.store.close();
  });
});
