import type { ProjectId } from "../../shared/contracts/ids";
import type { IpcResult } from "../../shared/contracts/project-bridge";
import type { StudioMode } from "../../shared/contracts/studio";

/**
 * Renderer-side session primitives for R01: selection epochs, a draft journal
 * with serialized per-key writes, and a synchronous submission gate.
 *
 * These exist because every defect R01 fixes is an ordering defect: a result
 * that arrives after the user has moved on, a save whose acknowledgement
 * describes text that is no longer the composer's, a second submit claimed
 * before React has re-rendered the busy state. Pure functions over injected
 * savers make the orderings reproducible in tests instead of guessed at.
 */

export type DraftPhase = "idle" | "saving" | "saved" | "error";

export interface DraftView {
  text: string;
  phase: DraftPhase;
}

export interface DraftSnapshot extends DraftView {
  projectId: ProjectId;
  threadId: string | null;
  revision: number;
}

export type DraftSaver = (
  projectId: ProjectId,
  threadId: string,
  text: string,
) => Promise<IpcResult<{ saved: boolean }>>;

/** Immutable identity of one submission, captured before the first await. */
export interface SubmissionIdentity {
  projectId: ProjectId;
  threadId: string | null;
  draftRevision: number;
  text: string;
  mode: StudioMode;
}

export type AcceptSentOutcome = "cleared" | "preserved" | "stale";

export function draftKey(projectId: ProjectId | null, threadId: string | null): string | null {
  if (!projectId || !threadId) return null;
  return `${projectId}\u0000${threadId}`;
}

/**
 * One monotonic counter for "which project load is the current one". A result
 * may only be applied when the token it captured is still current, which is
 * stricter than comparing project ids: A→B→A must not accept A's old payload.
 */
export class SelectionEpoch {
  private value = 0;

  begin(): number {
    this.value += 1;
    return this.value;
  }

  current(): number {
    return this.value;
  }

  isCurrent(token: number): boolean {
    return token === this.value;
  }
}

/**
 * A submission is claimed synchronously, before the first await, so a second
 * click or ⌘Enter that lands before React re-renders cannot dispatch twice.
 */
export class SubmissionGate {
  private held: SubmissionIdentity | null = null;

  claim(identity: SubmissionIdentity): boolean {
    if (this.held !== null) return false;
    if (identity.text.trim().length === 0) return false;
    this.held = identity;
    return true;
  }

  release(identity?: SubmissionIdentity): void {
    if (identity === undefined || this.held === identity) this.held = null;
  }

  current(): SubmissionIdentity | null {
    return this.held;
  }
}

interface DraftEntry {
  projectId: ProjectId;
  threadId: string | null;
  text: string;
  /** Bumped by every accepted edit; the identity a submission is judged by. */
  revision: number;
  /** Highest revision the saver has acknowledged. */
  writtenRevision: number;
  phase: DraftPhase;
}

/**
 * The composer's text is owned here, not in a ref that awaits may observe.
 *
 * Writes are serialized per draft key, so an older save can never land after a
 * newer one and overwrite it. Every acknowledgement is compared against the
 * revision it wrote: an old reply can never label newer text "saved".
 */
export class DraftJournal {
  private readonly entries = new Map<string, DraftEntry>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly settles = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(view: DraftView) => void>();
  private activeKey: string | null = null;
  private lastError: string | null = null;
  private pendingSettle: Promise<void> | null = null;

  constructor(private readonly saver: DraftSaver) {}

  subscribe(listener: (view: DraftView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Adopt a loaded project/thread draft. Revisions restart at 1 per load. */
  open(projectId: ProjectId, threadId: string | null, text: string): void {
    const key = draftKey(projectId, threadId);
    if (!key) {
      // A draft with no thread cannot be persisted; keep it in memory so typing
      // is never discarded, and say so honestly through the phase.
      const memoryKey = `${projectId}\u0000\u0000unbound`;
      const entry: DraftEntry = {
        projectId,
        threadId: null,
        text,
        revision: 1,
        writtenRevision: 1,
        phase: "idle",
      };
      this.entries.set(memoryKey, entry);
      this.activeKey = memoryKey;
      this.notify();
      return;
    }
    const previous = this.entries.get(key);
    const entry: DraftEntry = {
      projectId,
      threadId,
      text,
      revision: (previous?.revision ?? 0) + 1,
      writtenRevision: (previous?.revision ?? 0) + 1,
      phase: text.length > 0 ? "saved" : "idle",
    };
    this.entries.set(key, entry);
    this.activeKey = key;
    this.notify();
  }

  close(): void {
    this.activeKey = null;
    this.notify();
  }

  current(): DraftSnapshot | null {
    const entry = this.active();
    if (!entry) return null;
    return {
      projectId: entry.projectId,
      threadId: entry.threadId,
      text: entry.text,
      revision: entry.revision,
      phase: entry.phase,
    };
  }

  view(): DraftView {
    const entry = this.active();
    return { text: entry?.text ?? "", phase: entry?.phase ?? "idle" };
  }

  /** Replace the text; returns the new revision, or null with no active draft. */
  edit(text: string): number | null {
    const entry = this.active();
    if (!entry) return null;
    if (entry.text === text) return entry.revision;
    entry.text = text;
    entry.revision += 1;
    entry.phase = entry.threadId ? "saving" : "idle";
    this.notify();
    return entry.revision;
  }

  /** True while text exists that the saver has not acknowledged. */
  hasUnsavedText(): boolean {
    const entry = this.active();
    return entry ? entry.revision > entry.writtenRevision : false;
  }

  get lastFailure(): string | null {
    return this.lastError;
  }

  /**
   * Clear only exactly what was sent. Text typed since the claim, or another
   * project's draft, is preserved; the caller is told which happened.
   */
  acceptSent(identity: SubmissionIdentity): AcceptSentOutcome {
    const key = draftKey(identity.projectId, identity.threadId);
    if (!key || key !== this.activeKey) return "stale";
    const entry = this.entries.get(key);
    if (!entry) return "stale";
    if (entry.revision !== identity.draftRevision || entry.text !== identity.text) {
      return "preserved";
    }
    entry.text = "";
    entry.revision += 1;
    entry.phase = entry.threadId ? "saving" : "idle";
    this.notify();
    if (entry.threadId) this.pendingSettle = this.settle(key).catch(() => undefined);
    return "cleared";
  }

  /** Persist the newest text of the active draft and wait until settled. */
  async flush(): Promise<void> {
    const key = this.activeKey;
    if (!key) return;
    if (this.pendingSettle) await this.pendingSettle;
    await this.settle(key);
  }
  private active(): DraftEntry | null {
    if (!this.activeKey) return null;
    return this.entries.get(this.activeKey) ?? null;
  }

  private notify(): void {
    const view = this.view();
    for (const listener of this.listeners) listener(view);
  }

  /**
   * One convergence loop per key. Concurrent callers share it, so two flushes
   * cannot interleave writes or queue the same revision twice.
   */
  private settle(key: string): Promise<void> {
    const running = this.settles.get(key);
    if (running) return running;
    const task = this.runSettle(key).finally(() => {
      this.settles.delete(key);
    });
    this.settles.set(key, task);
    return task;
  }

  private async runSettle(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry?.threadId) return;
    let rounds = 0;
    while (entry.revision > entry.writtenRevision && rounds < 8) {
      rounds += 1;
      const next = (this.chains.get(key) ?? Promise.resolve()).then(() => this.persist(key));
      this.chains.set(
        key,
        next.catch(() => undefined),
      );
      await next.catch(() => undefined);
      if (entry.phase === "error") return;
    }
  }

  private async persist(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry?.threadId) return;
    const revision = entry.revision;
    if (revision <= entry.writtenRevision) return;
    const text = entry.text;
    entry.phase = "saving";
    this.notify();
    const result = await this.saver(entry.projectId, entry.threadId, text);
    if (!result.ok) {
      this.lastError = `${result.error.code}: ${result.error.message}`;
      entry.phase = "error";
      this.notify();
      return;
    }
    this.lastError = null;
    entry.writtenRevision = Math.max(entry.writtenRevision, revision);
    // A newer edit may have arrived while this write was in flight. Only a
    // matching revision may be reported saved, and only if nothing newer is
    // waiting.
    if (entry.revision === revision) {
      entry.phase = text.trim().length === 0 ? "idle" : "saved";
      this.notify();
    }
  }
}
