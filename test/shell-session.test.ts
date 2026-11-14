import { describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts/ids";
import type { IpcResult } from "../src/shared/contracts/project-bridge";
import {
  DraftJournal,
  SelectionEpoch,
  SubmissionGate,
  draftKey,
  type DraftSaver,
  type SubmissionIdentity,
} from "../src/renderer/shell/session";

const A = "prj_aaaaaaaaaaaaaaaa" as ProjectId;
const B = "prj_bbbbbbbbbbbbbbbb" as ProjectId;

/** A promise gate, so a test decides exactly when an IPC round trip returns. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ok: IpcResult<{ saved: boolean }> = { ok: true, value: { saved: true } };

/** Let every queued microtask run; no timers are involved. */
async function tick(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

interface RecordedSave {
  projectId: string;
  threadId: string;
  text: string;
}

/** A saver whose acknowledgements the test releases by hand. */
function manualSaver() {
  const calls: RecordedSave[] = [];
  const gates: Array<{ resolve: (value: IpcResult<{ saved: boolean }>) => void }> = [];
  const saver: DraftSaver = (projectId, threadId, text) => {
    calls.push({ projectId, threadId, text });
    const gate = deferred<IpcResult<{ saved: boolean }>>();
    gates.push({ resolve: gate.resolve });
    return gate.promise;
  };
  return {
    calls,
    saver,
    acknowledge(index: number, result: IpcResult<{ saved: boolean }> = ok) {
      gates[index]!.resolve(result);
    },
    get pending() {
      return gates.length - acknowledged;
    },
    acknowledged: 0,
  };
}

function identity(overrides: Partial<SubmissionIdentity> = {}): SubmissionIdentity {
  return {
    projectId: A,
    threadId: "thr_aaaaaaaaaaaaaaaa",
    draftRevision: 2,
    text: "Do the thing",
    mode: "work",
    ...overrides,
  };
}

describe("selection epochs", () => {
  it("invalidates an older load when a newer selection begins", () => {
    const epoch = new SelectionEpoch();
    const first = epoch.begin();
    const second = epoch.begin();
    expect(epoch.isCurrent(first)).toBe(false);
    expect(epoch.isCurrent(second)).toBe(true);
  });

  it("rejects A's payload after A→B→A, which a project-id check would accept", () => {
    const epoch = new SelectionEpoch();
    const loadA = epoch.begin();
    const projectIdAtCapture = A;
    epoch.begin(); // user selects B
    const loadAAgain = epoch.begin(); // user selects A again
    // A's first response arrives late; the project id matches the current one.
    expect(projectIdAtCapture).toBe(A);
    expect(epoch.isCurrent(loadA)).toBe(false);
    expect(epoch.isCurrent(loadAAgain)).toBe(true);
  });
});

describe("submission gate", () => {
  it("refuses a second claim before any await can run", () => {
    const gate = new SubmissionGate();
    expect(gate.claim(identity())).toBe(true);
    expect(gate.claim(identity())).toBe(false);
    expect(gate.current()?.text).toBe("Do the thing");
  });

  it("refuses empty text and releases only its own claim", () => {
    const gate = new SubmissionGate();
    expect(gate.claim(identity({ text: "   " }))).toBe(false);
    const claimed = identity();
    expect(gate.claim(claimed)).toBe(true);
    gate.release(identity());
    expect(gate.current()).toBe(claimed);
    gate.release(claimed);
    expect(gate.current()).toBeNull();
  });
});

describe("draft journal", () => {
  it("clears only the submitted revision and preserves text typed during the send", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "old text");
    journal.edit("Do the thing");
    const sent = journal.current()!;
    // The user keeps typing while the submit IPC is in flight.
    journal.edit("Do the thing, and also");
    expect(journal.acceptSent(identity({ draftRevision: sent.revision, text: sent.text }))).toBe(
      "preserved",
    );
    expect(journal.view().text).toBe("Do the thing, and also");
    const flushed = journal.flush();
    await Promise.resolve();
    manual.acknowledge(0);
    await flushed;
    expect(manual.calls.at(-1)?.text).toBe("Do the thing, and also");
    expect(journal.view().phase).toBe("saved");
  });

  it("clears the composer and persists the deletion when nothing changed during the send", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "");
    journal.edit("Do the thing");
    const sent = journal.current()!;
    expect(journal.acceptSent(identity({ draftRevision: sent.revision, text: sent.text }))).toBe(
      "cleared",
    );
    expect(journal.view().text).toBe("");
    const flushed = journal.flush();
    await Promise.resolve();
    manual.acknowledge(0);
    await flushed;
    expect(manual.calls.at(-1)).toMatchObject({ text: "" });
  });

  it("never lets another project's draft be cleared by a late acceptance", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "A draft");
    journal.edit("A submitted");
    const sent = journal.current()!;
    // The user switched to project B while A's submit was in flight.
    journal.open(B, "thr_bbbbbbbbbbbbbbbb", "B draft");
    expect(journal.acceptSent(identity({ draftRevision: sent.revision, text: sent.text }))).toBe(
      "stale",
    );
    expect(journal.view().text).toBe("B draft");
  });

  it("does not mark newer text saved when an older write is acknowledged late", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "");
    journal.edit("first");
    const settling = journal.flush();
    await tick();
    journal.edit("first and second");
    expect(journal.view().phase).toBe("saving");
    manual.acknowledge(0);
    await tick();
    // The older acknowledgement must not claim the newer text is saved, and the
    // journal must go on to write the newer text.
    expect(journal.view().phase).toBe("saving");
    expect(manual.calls.map((call) => call.text)).toEqual(["first", "first and second"]);
    manual.acknowledge(1);
    await settling;
    expect(journal.view().phase).toBe("saved");
    expect(journal.hasUnsavedText()).toBe(false);
  });

  it("serializes per-key writes so an old save cannot land after a newer one", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "");
    journal.edit("one");
    const first = journal.flush();
    await tick();
    journal.edit("two");
    const second = journal.flush();
    await tick();
    // Only one write may be in flight; the second waits for the first.
    expect(manual.calls).toHaveLength(1);
    manual.acknowledge(0);
    await tick();
    expect(manual.calls).toHaveLength(2);
    manual.acknowledge(1);
    await Promise.all([first, second]);
    expect(manual.calls.map((call) => call.text)).toEqual(["one", "two"]);
  });

  it("keeps text in memory and reports an error when a save is rejected", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "");
    journal.edit("keep me");
    const flushed = journal.flush();
    await Promise.resolve();
    manual.acknowledge(0, {
      ok: false,
      error: { code: "CONFLICT", message: "draft thread does not belong to this project" },
    });
    await flushed;
    expect(journal.view()).toEqual({ text: "keep me", phase: "error" });
    expect(journal.hasUnsavedText()).toBe(true);
    expect(journal.lastFailure).toContain("CONFLICT");
  });

  it("writes each project's draft against its own key", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "");
    journal.edit("A text");
    const flushA = journal.flush();
    await Promise.resolve();
    journal.open(B, "thr_bbbbbbbbbbbbbbbb", "");
    journal.edit("B text");
    const flushB = journal.flush();
    await Promise.resolve();
    manual.acknowledge(0);
    await flushA;
    await Promise.resolve();
    manual.acknowledge(1);
    await flushB;
    expect(manual.calls).toEqual([
      { projectId: A, threadId: "thr_aaaaaaaaaaaaaaaa", text: "A text" },
      { projectId: B, threadId: "thr_bbbbbbbbbbbbbbbb", text: "B text" },
    ]);
  });

  it("does not save a draft that has no thread, and does not lose it", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, null, "");
    journal.edit("unsaved but present");
    await journal.flush();
    expect(manual.calls).toHaveLength(0);
    expect(journal.view()).toEqual({ text: "unsaved but present", phase: "idle" });
  });

  it("reloads a key with a fresh revision after another project was open", async () => {
    const manual = manualSaver();
    const journal = new DraftJournal(manual.saver);
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "loaded A");
    const firstRevision = journal.current()!.revision;
    journal.open(B, "thr_bbbbbbbbbbbbbbbb", "loaded B");
    journal.open(A, "thr_aaaaaaaaaaaaaaaa", "loaded A again");
    expect(journal.current()!.revision).toBeGreaterThan(firstRevision);
    expect(journal.view()).toEqual({ text: "loaded A again", phase: "saved" });
  });

  it("builds the same key for the same project and thread", () => {
    expect(draftKey(A, "thr_1")).toBe(draftKey(A, "thr_1"));
    expect(draftKey(A, "thr_1")).not.toBe(draftKey(A, "thr_2"));
    expect(draftKey(A, null)).toBeNull();
  });
});
