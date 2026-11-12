import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openTestStore, makeClock } from "./helpers/state";

const DAY = 86_400_000;

describe("bounded artifacts", () => {
  it("stores bytes as private files with digest-checked metadata", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Artifacts", rootPath: dir });
    const artifact = await store.putArtifact({
      projectId: project.id,
      data: Buffer.from("hello artifact"),
      mediaType: "text/plain",
      source: "unit-test",
      retentionClass: "diagnostic",
    });
    expect(artifact.sizeBytes).toBe(14);
    expect(artifact.relPath.endsWith(".txt")).toBe(true);
    const file = store.artifactFiles.absolute(artifact.relPath);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("hello artifact");
    expect((await store.readArtifact(artifact.id)).data.toString()).toBe("hello artifact");
    expect(await store.listArtifacts(project.id)).toHaveLength(1);

    writeFileSync(file, "tampered bytes");
    await expect(store.readArtifact(artifact.id)).rejects.toMatchObject({
      code: "CORRUPT_DATABASE",
    });
    await store.close();
  });

  it("enforces a per-artifact maximum and a project quota without leaving files", async () => {
    const { store, dir } = await openTestStore({ maxArtifactBytes: 8, projectQuotaBytes: 10 });
    const project = await store.createProject({ name: "Quota", rootPath: dir });
    await expect(
      store.putArtifact({
        projectId: project.id,
        data: Buffer.alloc(9),
        mediaType: "text/plain",
        source: "test",
        retentionClass: "temporary",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });

    await store.putArtifact({
      projectId: project.id,
      data: Buffer.alloc(8),
      mediaType: "text/plain",
      source: "test",
      retentionClass: "temporary",
    });
    await expect(
      store.putArtifact({
        projectId: project.id,
        data: Buffer.alloc(8),
        mediaType: "text/plain",
        source: "test",
        retentionClass: "temporary",
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(await store.listArtifacts(project.id)).toHaveLength(1);
    expect(store.artifactFiles.list()).toHaveLength(1);
    await store.close();
  });

  it("refuses artifact writes under disk pressure without recording metadata", async () => {
    let free = 8 * 1024 * 1024 * 1024;
    const { store, dir } = await openTestStore({ diskProbe: { freeBytes: () => free } });
    const project = await store.createProject({ name: "Pressure", rootPath: dir });
    free = 0;
    await expect(
      store.putArtifact({
        projectId: project.id,
        data: Buffer.from("x"),
        mediaType: "text/plain",
        source: "test",
        retentionClass: "temporary",
      }),
    ).rejects.toMatchObject({ code: "DISK_FULL" });
    expect(await store.listArtifacts(project.id)).toHaveLength(0);
    expect(store.artifactFiles.list()).toHaveLength(0);
    await store.close();
  });

  it("plans retention around protected evidence and warns on explicit deletion", async () => {
    const clock = makeClock();
    const { store, dir } = await openTestStore({ now: clock.now });
    const project = await store.createProject({ name: "Retention", rootPath: dir });
    const task = await store.createTask({ projectId: project.id, title: "Blocked", prompt: "x" });
    const running = await store.updateTaskStatus(task.id, "running", task.revision);
    await store.updateTaskStatus(task.id, "blocked", running.revision);

    const temporary = await store.putArtifact({
      projectId: project.id,
      data: Buffer.from("temporary"),
      mediaType: "text/plain",
      source: "test",
      retentionClass: "temporary",
    });
    const blocked = await store.putArtifact({
      projectId: project.id,
      taskId: task.id,
      data: Buffer.from("blocked evidence"),
      mediaType: "text/plain",
      source: "test",
      retentionClass: "temporary",
    });
    const evidence = await store.putArtifact({
      projectId: project.id,
      data: Buffer.from("requirement evidence"),
      mediaType: "text/plain",
      source: "test",
      retentionClass: "evidence",
    });
    await store.addRequirementEvidence({
      projectId: project.id,
      requirementId: "MONA-025",
      path: "docs/evidence/macos/P05-state.md",
      digest: evidence.digest,
    });

    clock.advance(10 * DAY);
    const plan = await store.planRetention({ temporaryDays: 7, diagnosticDays: 30 });
    expect(plan.candidates.map((artifact) => artifact.id)).toEqual([temporary.id]);
    expect(plan.protected.map((entry) => entry.artifact.id)).toEqual([blocked.id, evidence.id]);
    expect(plan.warnings.join(" ")).toContain("task is blocked");
    expect(plan.warnings.join(" ")).toContain("retention class is evidence");

    const pruned = await store.pruneArtifacts({ temporaryDays: 7, diagnosticDays: 30 });
    expect(pruned.deleted.map((artifact) => artifact.id)).toEqual([temporary.id]);
    expect(pruned.warnings.length).toBeGreaterThan(0);
    expect(await store.listArtifacts(project.id)).toHaveLength(2);
    expect(existsSync(store.artifactFiles.absolute(temporary.relPath))).toBe(false);
    expect(existsSync(store.artifactFiles.absolute(blocked.relPath))).toBe(true);

    const forced = await store.pruneArtifacts({
      temporaryDays: 7,
      diagnosticDays: 30,
      includeProtected: true,
    });
    expect(forced.deleted.map((artifact) => artifact.id)).toEqual([blocked.id, evidence.id]);
    expect(forced.warnings.join(" ")).toContain("explicit policy");
    expect(await store.listArtifacts(project.id)).toHaveLength(0);
    await store.close();
  });

  it("sweeps orphan files but keeps referenced artifacts", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Sweep", rootPath: dir });
    const artifact = await store.putArtifact({
      projectId: project.id,
      data: Buffer.from("keep"),
      mediaType: "text/plain",
      source: "test",
      retentionClass: "diagnostic",
    });
    const orphan = join(dir, "artifacts", project.id, `${"c".repeat(64)}.txt`);
    writeFileSync(orphan, "orphan");
    utimesSync(orphan, new Date(0), new Date(0));
    const removed = await store.sweepOrphanArtifacts();
    expect(removed).toEqual([`${project.id}/${"c".repeat(64)}.txt`]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(store.artifactFiles.absolute(artifact.relPath))).toBe(true);
    await store.close();
  });
});
