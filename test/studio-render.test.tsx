import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredEventSummary } from "../src/shared/contracts/project-bridge";
import { Markdown } from "../src/renderer/shell/markdown";
import { projectTimeline } from "../src/renderer/shell/timeline";

function event(
  seq: number,
  kind: string,
  payload: unknown,
  extra: Partial<StoredEventSummary> = {},
): StoredEventSummary {
  return {
    threadId: "thr_0123456789abcdef",
    seq,
    kind,
    payload,
    timestamp: `2026-11-11T00:00:0${String(seq % 10)}.${String(seq).padStart(3, "0")}Z`,
    turnId: null,
    itemId: null,
    ...extra,
  };
}

describe("safe Markdown rendering", () => {
  it("renders raw HTML as text and never creates a script or image", () => {
    const html = renderToStaticMarkup(
      <Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">'} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("renders fenced code as pre/code without executing its contents", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"Before\n\n```ts\nconst x = '<b>hi</b>';\n```\n\nAfter"} />,
    );
    expect(html).toContain('<pre class="md-pre">');
    expect(html).toContain('data-language="ts"');
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
  });

  it("renders links inertly and refuses non-http schemes", () => {
    const safe = renderToStaticMarkup(
      <Markdown text={"See [the docs](https://example.com/docs)."} />,
    );
    expect(safe).not.toContain("<a ");
    expect(safe).toContain('title="https://example.com/docs"');
    expect(safe).toContain("the docs");

    const unsafe = renderToStaticMarkup(<Markdown text={"[click](javascript:alert(1))"} />);
    expect(unsafe).not.toContain("<a ");
    expect(unsafe).not.toContain("javascript:alert");
    expect(unsafe).toContain("click");
  });

  it("supports headings, lists, emphasis, and inline code", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"## Plan\n\n- **one** item\n- `two` item\n\n1. first\n2. second"} />,
    );
    expect(html).toContain("<h4>Plan</h4>");
    expect(html).toContain("<strong>one</strong>");
    expect(html).toContain('<code class="md-code">two</code>');
    expect(html).toContain("<ol>");
  });
});

describe("timeline projection", () => {
  it("keeps interleaved threads separate, even when sequence numbers match", () => {
    const result = projectTimeline([
      event(1, "item.delta", { kind: "agent_message", delta: "ALPHA" }, { threadId: "thread-a" }),
      event(1, "item.delta", { kind: "agent_message", delta: "BETA" }, { threadId: "thread-b" }),
    ]);
    expect(result.entries.map((e) => e.body)).toEqual(["ALPHA", "BETA"]);
    expect(new Set(result.entries.map((e) => e.key)).size).toBe(2);
  });

  it("does not split streamed text at heartbeat or other plumbing frames", () => {
    const result = projectTimeline([
      event(1, "item.delta", { kind: "agent_message", delta: "ALPHA" }),
      event(2, "operation.heartbeat", {}),
      event(3, "item.delta", { kind: "agent_message", delta: "BETA" }),
      event(4, "item.completed", { item: { kind: "agent_message", detail: "ALPHABETA" } }),
    ]);
    expect(result.entries.map((e) => e.body)).toEqual(["ALPHABETA"]);
    expect(result.internalActivity).toBe(1);
  });

  it("merges deltas into one message and ignores duplicate sequences", () => {
    const events = [
      event(2, "turn.started", { permission_posture: "full_access" }),
      event(3, "item.delta", { kind: "agent_message", delta: "hello " }, { seq: 3 }),
      event(4, "item.delta", { kind: "agent_message", delta: "world" }),
      event(
        5,
        "item.completed",
        {
          item: {
            id: "item_aaaaaaaaaaaaaaaa",
            kind: "agent_message",
            status: "completed",
            detail: "hello world",
          },
        },
        { seq: 5 },
      ),
      event(
        5,
        "item.completed",
        {
          item: {
            id: "item_aaaaaaaaaaaaaaaa",
            kind: "agent_message",
            status: "completed",
            detail: "hello world",
          },
        },
        { seq: 5 },
      ),
      event(6, "turn.completed", { status: "completed" }),
    ];
    const { entries: timeline } = projectTimeline(events);
    const assistant = timeline.filter((entry) => entry.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.body).toBe("hello world");
    expect(timeline.map((entry) => entry.title)).toEqual([
      "Turn started",
      "Engine",
      "Turn completed",
    ]);
  });

  it("keeps unknown engine events visible instead of hiding them", () => {
    const { entries: timeline, unprojected } = projectTimeline([
      event(9, "future.event", { kept: true }),
    ]);
    expect(unprojected).toEqual(["future.event"]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "unknown" });
    expect(timeline[0]?.title).toContain("future.event");
  });

  it("shows tool calls and failures separately from assistant prose", () => {
    const { entries: timeline } = projectTimeline([
      event(1, "item.completed", {
        item: {
          id: "tool_1",
          kind: "command_execution",
          status: "completed",
          summary: "node --test",
          detail: "# pass 1",
        },
      }),
      event(2, "turn.failed", { reason: "provider refused" }),
    ]);
    expect(timeline[0]).toMatchObject({ kind: "tool", title: "command execution" });
    expect(timeline[0]?.body).toContain("# pass 1");
    expect(timeline[1]).toMatchObject({ kind: "error", status: "failed" });
    expect(timeline[1]?.body).toContain("provider refused");
  });
});

describe("engine activity is counted, not hidden", () => {
  it("counts an operation heartbeat instead of printing an unrecognized-event card", () => {
    // Reported: "Unrecognized event · operation.heartbeat" kept appearing every
    // ten seconds. A heartbeat carries only `observed_at`; it is liveness, not
    // conversation, and the build knows the kind.
    const { entries, internalActivity, unprojected } = projectTimeline([
      event(1, "turn.started", { permission_posture: "full_access" }),
      event(2, "operation.heartbeat", { observed_at: "2026-11-11T00:00:02Z" }),
      event(3, "operation.heartbeat", { observed_at: "2026-11-11T00:00:12Z" }),
      event(4, "turn.completed", { status: "completed" }),
    ]);
    expect(internalActivity).toBe(2);
    expect(unprojected).toEqual([]);
    expect(entries.map((entry) => entry.title)).toEqual(["Turn started", "Turn completed"]);
    expect(entries.some((entry) => entry.kind === "unknown")).toBe(false);
  });

  it("projects interrupt and artifact frames it used to call unrecognized", () => {
    // These are the kinds the operator's own thread carried, rendered as
    // "Unrecognized event · turn.artifacts" although Mona captures that same
    // event into its change set.
    const { entries, unprojected } = projectTimeline([
      event(1, "turn.interrupt_requested", {
        thread_id: "thr_0123456789abcdef",
        turn_id: "turn_1",
      }),
      event(2, "item.interrupted", {
        item: {
          id: "item_1",
          turn_id: "turn_1",
          kind: "agent_reasoning",
          status: "interrupted",
          summary: "partial thought",
        },
      }),
      event(3, "turn.artifacts", {
        turn_id: "turn_1",
        workspace: {
          state: "settled",
          pre_turn_snapshot_id: "a",
          post_turn_snapshot_id: "a",
          truncated: false,
          omitted: 0,
        },
        artifacts: [],
      }),
      event(4, "turn.artifacts", {
        turn_id: "turn_2",
        workspace: {
          state: "settled",
          pre_turn_snapshot_id: "a",
          post_turn_snapshot_id: "b",
          truncated: true,
          omitted: 2,
        },
        artifacts: [{ id: "art_1" }],
      }),
    ]);
    expect(unprojected).toEqual([]);
    expect(entries.map((entry) => entry.title)).toEqual([
      "Interrupt requested",
      "Item interrupted",
      "Turn artifacts",
      "Turn artifacts",
    ]);
    expect(entries[1]).toMatchObject({ kind: "status", body: "partial thought" });
    expect(entries[2]?.body).toBe("workspace settled · 0 artifacts · snapshot unchanged");
    expect(entries[3]?.body).toBe("workspace settled · 1 artifact · snapshot changed · 2 omitted");
  });

  it("collapses plumbing events while keeping the count and unknown kinds visible", () => {
    const { entries, internalActivity, unprojected } = projectTimeline([
      event(1, "item.started", { item: { id: "x", kind: "tool_call" } }),
      event(2, "turn.lifecycle", { to: "running" }),
      event(3, "model.tools.snapshot", { tools: ["shell"] }),
      event(4, "turn.usage", { input_tokens: 5 }),
      event(5, "item.completed", {
        item: { id: "t1", kind: "command_execution", summary: "node --test", detail: "pass 3" },
      }),
      event(6, "future.event", { kept: true }),
      event(7, "turn.completed", { status: "completed" }),
    ]);
    expect(internalActivity).toBe(4);
    expect(unprojected).toEqual(["future.event"]);
    expect(entries.map((entry) => entry.kind)).toEqual(["tool", "unknown", "status"]);
  });
});

describe("R02 identity-aware conversation projection", () => {
  const TURN = "turn_aaaaaaaaaaaaaaaa";

  function delta(seq: number, itemId: string | null, kind: string, text: string) {
    return event(seq, "item.delta", { kind, delta: text }, { turnId: TURN, itemId });
  }

  function completed(seq: number, itemId: string | null, kind: string, detail: string) {
    return event(
      seq,
      "item.completed",
      { item: { id: itemId ?? undefined, kind, status: "completed", detail } },
      { turnId: TURN, itemId },
    );
  }

  it("never merges two interleaved items of the same kind in one thread", () => {
    const { entries } = projectTimeline(
      [
        event(1, "turn.started", { permission_posture: "full_access" }, { turnId: TURN }),
        delta(2, "item_a", "agent_message", "ALPHA "),
        delta(3, "item_b", "agent_message", "BETA "),
        delta(4, "item_a", "agent_message", "one"),
        delta(5, "item_b", "agent_message", "two"),
        completed(6, "item_a", "agent_message", "ALPHA one"),
        completed(7, "item_b", "agent_message", "BETA two"),
      ],
      { historyComplete: true },
    );
    const messages = entries.filter((entry) => entry.kind === "assistant");
    expect(messages).toHaveLength(2);
    expect(messages.map((entry) => entry.body)).toEqual(["ALPHA one", "BETA two"]);
    expect(messages.map((entry) => entry.itemId)).toEqual(["item_a", "item_b"]);
    expect(messages.every((entry) => entry.streaming === false)).toBe(true);
  });

  it("uses one stable key for the streamed and completed card of an item", () => {
    const during = projectTimeline([delta(1, "item_a", "agent_message", "half")], {
      historyComplete: true,
    });
    const after = projectTimeline(
      [
        delta(1, "item_a", "agent_message", "half"),
        completed(2, "item_a", "agent_message", "half"),
      ],
      { historyComplete: true },
    );
    expect(during.entries).toHaveLength(1);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]?.key).toBe(during.entries[0]?.key);
    expect(during.entries[0]?.streaming).toBe(true);
    expect(after.entries[0]?.streaming).toBe(false);
  });

  it("treats a hole in the global sequence as interleaving, not loss", () => {
    // `seq` is one counter shared by every thread, so 2 → 90 proves nothing.
    // The two deltas are one message and the projection must not invent a gap,
    // an error, or an unrecognized frame.
    const { entries, unprojected } = projectTimeline(
      [
        delta(1, "item_a", "agent_message", "first "),
        delta(90, "item_a", "agent_message", "second"),
        completed(91, "item_a", "agent_message", "first second"),
      ],
      { historyComplete: true },
    );
    expect(entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
    expect(entries[0]?.body).toBe("first second");
    expect(entries.some((entry) => entry.kind === "error" || entry.kind === "unknown")).toBe(false);
    expect(unprojected).toEqual([]);
  });

  it("marks an item that begins at a page boundary as partial, and only then", () => {
    const frames = [
      event(1, "turn.started", {}, { turnId: TURN }),
      delta(2, "item_a", "agent_message", "this beginning is in the page"),
    ];
    const complete = projectTimeline(frames, { historyComplete: true });
    expect(complete.entries.find((entry) => entry.kind === "assistant")?.partial).toBe(false);

    const paged = projectTimeline(frames, { historyComplete: false });
    // The turn started in this window, so the item's beginning really is here.
    expect(paged.entries.find((entry) => entry.kind === "assistant")?.partial).toBe(false);

    const truncated = projectTimeline([delta(2, "item_a", "agent_message", "tail only")], {
      historyComplete: false,
    });
    expect(truncated.entries[0]).toMatchObject({ partial: true, itemId: "item_a" });
  });

  it("reports legacy frames without item identity as unknown instead of guessing", () => {
    const { entries } = projectTimeline(
      [
        delta(1, null, "agent_message", "legacy "),
        delta(2, null, "agent_message", "stream"),
        completed(3, null, "agent_message", "legacy stream"),
      ],
      { historyComplete: true },
    );
    const messages = entries.filter((entry) => entry.kind === "assistant");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: "legacy stream", itemId: null });
  });

  it("does not bind one legacy stream when two same-kind streams are open", () => {
    // Two turns, two unidentified streams, one completion with no identity and
    // no turn: it must not pick either stream silently.
    const { entries } = projectTimeline(
      [
        event(
          1,
          "item.delta",
          { kind: "agent_message", delta: "one" },
          { turnId: "turn_one", itemId: null },
        ),
        event(
          2,
          "item.delta",
          { kind: "agent_message", delta: "two" },
          { turnId: "turn_two", itemId: null },
        ),
        completed(3, null, "agent_message", "unknown source"),
      ],
      { historyComplete: true },
    );
    const messages = entries.filter((entry) => entry.kind === "assistant");
    expect(messages.map((entry) => entry.body).sort()).toEqual(["one", "two", "unknown source"]);
  });

  it("keeps turn identity on every projected card", () => {
    const { entries } = projectTimeline(
      [
        event(1, "turn.started", {}, { turnId: TURN }),
        delta(2, "item_a", "agent_message", "hello"),
        completed(3, "item_a", "agent_message", "hello"),
        event(4, "turn.completed", {}, { turnId: TURN }),
      ],
      { historyComplete: true },
    );
    expect(entries.every((entry) => entry.turnId === TURN)).toBe(true);
    expect(entries.filter((entry) => entry.itemId !== null)).toHaveLength(1);
  });
});
