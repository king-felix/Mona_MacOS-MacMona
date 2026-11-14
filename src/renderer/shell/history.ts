import type { ProjectId } from "../../shared/contracts/ids";
import type {
  HistoryCursor,
  HistoryItemPage,
  HistoryPage,
  IpcResult,
  StoredEventSummary,
} from "../../shared/contracts/project-bridge";

/** The two read-only bridge calls history needs; injected so this is testable. */
export interface HistorySource {
  page(
    projectId: ProjectId,
    options: { before?: HistoryCursor | null; limit?: number; threadId?: string | null },
  ): Promise<IpcResult<HistoryPage>>;
  item(projectId: ProjectId, threadId: string, itemId: string): Promise<IpcResult<HistoryItemPage>>;
}

export interface HistoryView {
  projectId: string | null;
  /** null means every thread in the project. */
  threadId: string | null;
  /** Every stored frame loaded so far, oldest-first, deduplicated by identity. */
  events: StoredEventSummary[];
  olderCursor: HistoryCursor | null;
  hasMore: boolean;
  /** Events stored for this project (or the selected thread filter). */
  storedTotal: number;
  loading: boolean;
  error: string | null;
  /**
   * Items whose stored frames exceed one response. Their cards say how many
   * frames were returned instead of implying the message is complete.
   */
  truncatedItems: Record<string, { returned: number; stored: number }>;
  /**
   * Items whose stored frames were loaded in full. Their cards are no longer
   * partial even while the surrounding transcript is still paged.
   */
  completeItems: Record<string, true>;
  /**
   * Successful older-page loads in this conversation. The Studio uses it to
   * apply its scroll anchor exactly once, when an older page lands — never for
   * a live append, which must not move the reader.
   */
  olderLoads: number;
}

export const PAGE_LIMIT = 200;

const EMPTY: HistoryView = {
  projectId: null,
  threadId: null,
  events: [],
  olderCursor: null,
  hasMore: false,
  storedTotal: 0,
  loading: false,
  error: null,
  truncatedItems: {},
  completeItems: {},
  olderLoads: 0,
};

function eventKey(event: StoredEventSummary): string {
  return `${event.threadId}:${event.seq}`;
}

/**
 * Merge stored pages without duplicating a frame and without letting one page's
 * spelling of a row displace another's. Identity is (thread, seq): the engine
 * addresses frames that way within a thread, and a duplicate replay carries the
 * same pair.
 */
export function mergeEvents(...lists: StoredEventSummary[][]): StoredEventSummary[] {
  const merged = new Map<string, StoredEventSummary>();
  for (const list of lists) {
    for (const event of list) merged.set(eventKey(event), event);
  }
  return [...merged.values()].sort((left, right) => {
    const leftAt = Date.parse(left.timestamp);
    const rightAt = Date.parse(right.timestamp);
    if (leftAt !== rightAt) return leftAt - rightAt;
    if (left.threadId !== right.threadId) return left.threadId < right.threadId ? -1 : 1;
    return left.seq - right.seq;
  });
}

/**
 * Owns the paged read of stored conversation history.
 *
 * Every request carries a token so a response for an abandoned project or
 * thread is discarded instead of replacing what is on screen (the same rule the
 * selection epoch enforces for project detail). Reading a page never starts a
 * runtime and never asks a model: both bridge calls are state reads.
 */
export class HistoryPager {
  private state: HistoryView = EMPTY;
  private readonly listeners = new Set<(view: HistoryView) => void>();
  private token = 0;

  constructor(private readonly source: HistorySource) {}

  view(): HistoryView {
    return this.state;
  }

  subscribe(listener: (view: HistoryView) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<HistoryView>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Forget everything; the next project starts from its own first page. */
  reset(): void {
    this.token += 1;
    this.state = EMPTY;
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Adopt the first page that arrived with `ProjectDetail`. A page is a fact
   * about what the store returned, so `hasMore` is taken as reported.
   */
  open(
    projectId: string,
    page: {
      events: StoredEventSummary[];
      olderCursor: HistoryCursor | null;
      hasMore: boolean;
      storedTotal: number;
    },
  ): void {
    this.token += 1;
    this.state = {
      ...EMPTY,
      projectId,
      events: mergeEvents(page.events),
      olderCursor: page.olderCursor,
      hasMore: page.hasMore,
      storedTotal: page.storedTotal,
    };
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Merge the newest page from a project refresh. Older pages the reader loaded
   * stay in place; nothing already shown is dropped because a refresh arrived.
   */
  mergeLive(projectId: string, events: StoredEventSummary[], storedTotal?: number): void {
    if (this.state.projectId !== projectId) return;
    const filtered =
      this.state.threadId === null
        ? events
        : events.filter((event) => event.threadId === this.state.threadId);
    const patch: Partial<HistoryView> = {};
    if (filtered.length > 0) patch.events = mergeEvents(this.state.events, filtered);
    if (typeof storedTotal === "number") patch.storedTotal = storedTotal;
    if (Object.keys(patch).length > 0) this.set(patch);
  }

  /** Switch the thread filter and read that thread's newest page. */
  async selectThread(threadId: string | null): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    if (this.state.threadId === threadId && !this.state.error) return;
    // A failed read must not leave the selector claiming a filter whose events
    // are not on screen.
    const previousThreadId = this.state.threadId;
    const token = ++this.token;
    this.set({ threadId, loading: true, error: null });
    if (threadId === null) {
      // The unfiltered view is a new read too: the first project-wide page is
      // not derivable from a thread-filtered page.
      const result = await this.source.page(projectId as ProjectId, { limit: PAGE_LIMIT });
      if (token !== this.token) return;
      if (!result.ok) {
        this.set({
          threadId: previousThreadId,
          loading: false,
          error: `${result.error.code}: ${result.error.message}`,
        });
        return;
      }
      this.replaceWithPage(result.value);
      return;
    }
    const result = await this.source.page(projectId as ProjectId, {
      limit: PAGE_LIMIT,
      threadId,
    });
    if (token !== this.token) return;
    if (!result.ok) {
      this.set({
        threadId: previousThreadId,
        loading: false,
        error: `${result.error.code}: ${result.error.message}`,
      });
      return;
    }
    this.replaceWithPage(result.value);
  }

  private replaceWithPage(page: HistoryPage): void {
    this.set({
      events: mergeEvents(page.events),
      olderCursor: page.olderCursor,
      hasMore: page.hasMore,
      storedTotal: page.storedTotal,
      loading: false,
      error: null,
    });
  }

  /** Read the next older page and prepend it. */
  async older(): Promise<void> {
    const { projectId, threadId, olderCursor, hasMore, loading } = this.state;
    if (!projectId || !hasMore || loading) return;
    if (!olderCursor) {
      // No cursor but "more" was claimed: that claim cannot be acted on, and
      // pretending to load forever would be worse than saying so.
      this.set({ hasMore: false, error: "history could not continue: no cursor was returned" });
      return;
    }
    const token = ++this.token;
    this.set({ loading: true, error: null });
    const result = await this.source.page(projectId as ProjectId, {
      before: olderCursor,
      limit: PAGE_LIMIT,
      threadId,
    });
    if (token !== this.token) return;
    if (!result.ok) {
      this.set({ loading: false, error: `${result.error.code}: ${result.error.message}` });
      return;
    }
    const page = result.value;
    this.set({
      events: mergeEvents(page.events, this.state.events),
      olderCursor: page.olderCursor,
      hasMore: page.hasMore && page.events.length > 0,
      storedTotal: page.storedTotal,
      olderLoads: this.state.olderLoads + 1,
      loading: false,
    });
  }

  /**
   * Read every stored frame of one item, so a card cut off by the page boundary
   * shows its real beginning. The result is merged into the same transcript;
   * the projection rebuilds the card from identity, not from a patch.
   */
  async loadItem(threadId: string, itemId: string): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const token = ++this.token;
    const result = await this.source.item(projectId as ProjectId, threadId, itemId);
    if (token !== this.token) return;
    if (!result.ok) {
      this.set({ error: `${result.error.code}: ${result.error.message}` });
      return;
    }
    const page = result.value;
    const truncatedItems = { ...this.state.truncatedItems };
    const completeItems = { ...this.state.completeItems };
    const itemKey = `${threadId}:${itemId}`;
    if (page.truncated) {
      truncatedItems[itemKey] = { returned: page.events.length, stored: page.storedCount };
    } else {
      completeItems[itemKey] = true;
    }
    this.set({
      events: mergeEvents(page.events, this.state.events),
      truncatedItems,
      completeItems,
      error: null,
    });
  }
}
