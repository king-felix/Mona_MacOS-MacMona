import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_SLOTS } from "../src/shared/contracts/memory";
import { ProjectMemory, fitContextBlocks, type ContextBlock } from "../src/main/work/memory";
import type { StateStore } from "../src/main/state/store";
import { makeClock, openTestStore } from "./helpers/state";

const HOME = "/Users/mona-memory-tester";

/** Stores stay open across a test body and close afterwards, even on failure. */
const opened: StateStore[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const store = opened.pop();
    if (store) await store.close();
  }
});

async function openMemory(): Promise<{ store: StateStore; dir: string; memory: ProjectMemory }> {
  const handle = await openTestStore();
  opened.push(handle.store);
  const clock = makeClock("2026-11-12T00:00:00.000Z", 1_000);
  const memory = new ProjectMemory({
    store: handle.store,
    now: clock.now,
    homeDir: HOME,
    engineInfo: () => ({ version: "0.10.2", commit: "ff466b2ed0bf" }),
  });
  return { store: handle.store, dir: handle.dir, memory };
}

function workspaceRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const SECRET = `sk-${"a".repeat(24)}`;
// The redactor keeps a recognisable prefix and replaces the value, so a reader
// can see that something was removed rather than that nothing was here.
const REDACTED_LABEL = "s" + "k-" + "[redacted]";

describe("project memory search", () => {
  it("matches a term across tasks, decisions, and evidence in a stable order", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-match-");
    const project = await store.createProject({ name: "Recall", rootPath: root });
    await store.createTask({
      projectId: project.id,
      title: "Resume packet",
      prompt: "Write the packet builder.",
    });
    await store.createTask({
      projectId: project.id,
      title: "Board polish",
      prompt: "Unrelated work on the board.",
    });
    await store.addDecision({
      projectId: project.id,
      title: "Packet format",
      body: "The packet is plain text, never JSON.",
    });
    await store.addRequirementEvidence({
      projectId: project.id,
      requirementId: "MONA-001",
      path: "src/resume.ts",
      note: "packet builder and its test",
    });

    const first = await memory.search({ projectId: project.id, query: "packet" });
    const second = await memory.search({ projectId: project.id, query: "packet" });

    expect(first.hits.map((hit) => hit.id)).toEqual(second.hits.map((hit) => hit.id));
    expect(first.total).toBe(3);
    expect(first.hits).toHaveLength(3);
    expect(new Set(first.hits.map((hit) => hit.source))).toEqual(
      new Set(["task", "decision", "evidence"]),
    );
    const scores = first.hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const hit of first.hits) {
      expect(hit.snippet.length).toBeGreaterThan(0);
      expect(hit.snippet).not.toContain("\n");
      expect(hit.snippet.length).toBeLessThanOrEqual(240);
      expect(hit.matchedTerms).toContain("packet");
      expect(hit.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(first.persisted).toBe(false);
    expect(Number.isInteger(first.durationMs)).toBe(true);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.considered).toBe(4);
  });

  it("redacts secret-shaped bodies and never indexes credentials", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-secret-");
    const project = await store.createProject({ name: "Secrets", rootPath: root });
    await store.addDecision({
      projectId: project.id,
      title: "Key handling",
      body: `The key ${SECRET} was rejected by the provider.`,
    });

    const result = await memory.search({ projectId: project.id, query: "key" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.redactions).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.snippet).not.toContain(SECRET);
      expect(hit.title).not.toContain(SECRET);
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);

    const status = await memory.indexStatus(project.id);
    expect(status.credentialsIndexed).toBe(false);
    expect(status.embeddings).toBe(false);
    expect(status.repositoryContents).toBe("on_demand");
    expect(status.totalRedactions).toBeGreaterThan(0);
  });

  it("honours a source filter", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-filter-");
    const project = await store.createProject({ name: "Filter", rootPath: root });
    await store.createTask({
      projectId: project.id,
      title: "Filtered task",
      prompt: "filterprobe lives in the task prompt.",
    });
    await store.addDecision({
      projectId: project.id,
      title: "Filtered decision",
      body: "filterprobe lives in the decision body.",
    });

    const filtered = await memory.search({
      projectId: project.id,
      query: "filterprobe",
      sources: ["decision"],
    });
    expect(filtered.hits.length).toBe(1);
    expect(filtered.hits.every((hit) => hit.source === "decision")).toBe(true);
    expect(filtered.sources.map((count) => count.source)).toEqual(["decision"]);
    expect(filtered.sources[0]?.present).toBe(true);
  });

  it("caps hits with limit and reports truncation", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-limit-");
    const project = await store.createProject({ name: "Limit", rootPath: root });
    for (const title of ["Limit one", "Limit two", "Limit three"]) {
      await store.addDecision({
        projectId: project.id,
        title,
        body: "limitprobe is recorded here.",
      });
    }

    const result = await memory.search({ projectId: project.id, query: "limitprobe", limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
  });
});

describe("project memory workspace search", () => {
  it("reads matching lines on demand and skips ignored entries", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-workspace-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const memoryProbe = 1;\n");
    writeFileSync(join(root, "node_modules", "dep", "index.ts"), "export const memoryProbe = 2;\n");
    writeFileSync(join(root, "notes.md"), "first line\nuses memoryProbe here\n");
    writeFileSync(join(root, "blob.ts"), Buffer.from([0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x00]));
    const outside = join(workspaceRoot("mona-memory-outside-"), "linked.ts");
    writeFileSync(outside, "export const memoryProbe = 3;\n");
    symlinkSync(outside, join(root, "linked.ts"));

    const project = await store.createProject({ name: "Workspace", rootPath: root });
    const before = await store.stats();
    const result = await memory.searchWorkspace({
      projectId: project.id,
      query: "memoryProbe",
    });
    const after = await store.stats();

    expect(result.hits.map((hit) => hit.path)).toEqual(["notes.md", "src/app.ts"]);
    expect(result.hits.map((hit) => hit.line)).toEqual([2, 1]);
    expect(result.hits.every((hit) => hit.text.includes("memoryProbe"))).toBe(true);
    expect(result.hits.every((hit) => hit.truncated === false)).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.scope).toContain("node_modules");
    expect(result.scope).toContain("2000 files");
    expect(result.filesScanned).toBe(2);
    expect(result.bytesScanned).toBeGreaterThan(0);
    const reasons = result.skippedReasons.map((entry) => entry.reason);
    expect(reasons).toContain("directory: node_modules");
    expect(reasons).toContain("symlink");
    expect(reasons).toContain("binary");
    expect(after).toEqual(before);
  });
});

describe("project memory resume packet and context", () => {
  it("assembles a resume packet from stored records only", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-resume-");
    const project = await store.createProject({ name: "Resume", rootPath: root });
    const task = await store.createTask({
      projectId: project.id,
      title: "Ship the resume packet",
      prompt: "Assemble the packet from stored records.",
    });
    const withSteps = await store.updateTask(task.id, task.revision, {
      steps: ["Verify the resume packet"],
    });
    expect(withSteps.nextStep).toBe("Verify the resume packet");
    await store.addRequirementEvidence({
      projectId: project.id,
      taskId: task.id,
      requirementId: "MONA-001",
      path: "src/resume.ts",
      note: "packet builder",
    });
    await store.addDecision({
      projectId: project.id,
      title: "Packet stays plain text",
      body: `Never paste ${SECRET} into a packet.`,
    });
    await store.addDecision({
      projectId: project.id,
      // The title reaches the packet itself, so redaction is exercised there.
      title: `Rotate the leaked ${SECRET}`,
      body: "Rotate it before the next dispatch.",
    });

    const packet = await memory.resumePacket(project.id);
    expect(packet.text).toContain("Current task: Ship the resume packet [pending]");
    expect(packet.text).toContain("Next action: Verify the resume packet");
    expect(packet.text).toContain("Project: Resume");
    expect(packet.text).toContain("Evidence: src/resume.ts (MONA-001)");
    expect(packet.text).toContain("Decisions: Packet stays plain text");
    expect(packet.text).toContain("Engine: 0.10.2 ff466b2ed0bf");
    expect(
      packet.text
        .trimEnd()
        .endsWith(
          "This packet is Mona's own text; the assembled provider request is not inspectable.",
        ),
    ).toBe(true);
    expect(packet.text).not.toContain(SECRET);
    // The redactor keeps the recognisable prefix and replaces the value, so a
    // reader can see that something was removed rather than that nothing was
    // there.
    const leakedLine = packet.text.split("\n").find((line) => line.includes("Rotate the leaked"));
    expect(leakedLine).toBeDefined();
    expect(leakedLine).toContain(REDACTED_LABEL);
    expect(leakedLine).not.toContain("a".repeat(24));
    expect(packet.bytes).toBe(Buffer.byteLength(packet.text, "utf8"));
    expect(packet.exactProviderRequest).toBe(false);
    expect(packet.engineInspection).toBe("unavailable");
    expect(packet.pointers.some((pointer) => pointer.kind === "task" && pointer.available)).toBe(
      true,
    );
    const evidencePointer = packet.pointers.find((pointer) => pointer.kind === "evidence");
    expect(evidencePointer?.available).toBe(false);
    expect(packet.excluded).toContain("engine conversation history");
  });

  it("reports context slots and expands the selection with decisions", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-context-");
    const project = await store.createProject({ name: "Context", rootPath: root });
    const task = await store.createTask({
      projectId: project.id,
      title: "Context preview",
      prompt: "Assemble the preview from selected slots.",
      requirements: ["MONA-001"],
      acceptance: [{ text: "preview renders", kind: "check" }],
    });
    await store.recordAttempt({
      projectId: project.id,
      taskId: task.id,
      problemId: "prb_context",
      requirement: "MONA-001",
      symptom: "preview empty",
      hypothesis: "the slot was skipped",
      action: "include the slot",
      observed: "the preview gained text",
      materialProgress: true,
    });
    await store.addDecision({
      projectId: project.id,
      title: "Preview joins blocks",
      body: "Blocks are joined with a blank line.",
    });

    const slots = await memory.contextSlots(project.id, task.id);
    expect(slots.map((slot) => slot.slot)).toEqual([...CONTEXT_SLOTS]);
    expect(slots.every((slot) => slot.included === false)).toBe(true);
    const promptSlot = slots.find((slot) => slot.slot === "prompt");
    expect(promptSlot?.available).toBe(true);
    expect(promptSlot?.bytes).toBeGreaterThan(0);
    expect(slots.find((slot) => slot.slot === "acceptance")?.available).toBe(true);
    expect(slots.find((slot) => slot.slot === "requirements")?.available).toBe(true);
    expect(slots.find((slot) => slot.slot === "decisions")?.available).toBe(true);
    expect(slots.find((slot) => slot.slot === "prior_attempts")?.items).toBe(1);

    const base = await memory.contextSelection({
      projectId: project.id,
      taskId: task.id,
      include: ["prompt"],
    });
    const withDecisions = await memory.contextSelection({
      projectId: project.id,
      taskId: task.id,
      include: ["prompt", "decisions"],
    });
    expect(withDecisions.bytes).toBeGreaterThan(base.bytes);
    expect(withDecisions.text).toContain("Preview joins blocks");
    expect(withDecisions.exactProviderRequest).toBe(false);
    expect(withDecisions.truncated).toBe(false);
    expect(withDecisions.providerRequestNote).toContain("no provider-request inspection");
    const includedBytes = withDecisions.slots
      .filter((slot) => slot.included)
      .reduce((sum, slot) => sum + slot.bytes, 0);
    expect(includedBytes).toBe(withDecisions.bytes);
    expect(withDecisions.excluded).toContain("engine conversation history");
  });

  it("names what the index never holds", async () => {
    const { store, memory } = await openMemory();
    const root = workspaceRoot("mona-memory-index-");
    const project = await store.createProject({ name: "Index", rootPath: root });
    const first = await memory.indexStatus(project.id);
    const second = await memory.indexStatus(project.id);
    const named = first.excluded.map((entry) => entry.what).join(" | ");
    expect(named).toContain("settings");
    expect(named).toContain("repository");
    expect(named).toContain("transcript");
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(first.stateRevision).toBe(second.stateRevision);
    expect(first.retention.evidenceProtected).toBe(true);
    expect(first.totalRecords).toBe(0);
  });
});

describe("context preview truncation", () => {
  // The composed preview is bounded. With today's slot contents the bound is
  // never reached (decisions are clipped per decision, the prompt is capped at
  // 1,000 characters), so the guard is tested directly rather than through a
  // fixture that pretends a huge prompt exists.
  const block = (slot: "prompt" | "decisions", text: string): ContextBlock => ({
    slot,
    text,
    items: 1,
    available: true,
    note: "",
    redactions: 0,
  });

  it("keeps a preview that fits, unsliced", () => {
    const result = fitContextBlocks(
      [block("prompt", "short"), block("decisions", "also short")],
      1_000,
      null,
    );
    expect(result.truncated).toBe(false);
    expect(result.blocks).toHaveLength(2);
  });

  it("drops later blocks past the budget and says so", () => {
    const result = fitContextBlocks(
      [block("prompt", "a".repeat(500)), block("decisions", "b".repeat(5_000))],
      1_000,
      null,
    );
    expect(result.truncated).toBe(true);
    const total = result.blocks.reduce(
      (sum, entry) => sum + Buffer.byteLength(entry.text, "utf8"),
      0,
    );
    expect(total).toBeLessThanOrEqual(1_000);
    expect(result.blocks[0]?.text).toBe("a".repeat(500));
  });

  it("reserves room for the bare title when the prompt slot is out", () => {
    const result = fitContextBlocks([block("decisions", "c".repeat(900))], 1_000, {
      text: "t".repeat(400),
      redactions: 0,
    });
    const total =
      result.blocks.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, "utf8"), 0) +
      Buffer.byteLength("t".repeat(400), "utf8") +
      2;
    expect(total).toBeLessThanOrEqual(1_000);
  });

  it("never splits a multi-byte character when it clips", () => {
    const result = fitContextBlocks([block("prompt", "é".repeat(800))], 101, null);
    expect(result.truncated).toBe(true);
    // Re-encoding must not produce a replacement character.
    expect(result.blocks[0]?.text).not.toContain("\uFFFD");
  });
});
