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
    timestamp: `2026-11-11T00:00:0${seq}.000Z`,
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
