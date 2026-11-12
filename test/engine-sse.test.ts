import { describe, expect, it } from "vitest";
import { decodeBody } from "../src/main/engine/transport";
import { SseParser } from "../src/main/engine/sse";

describe("SSE parsing", () => {
  it("waits for a blank line before emitting a split frame", () => {
    const parser = new SseParser();
    expect(parser.push('id: 3\nevent: item.delta\ndata: {"seq":3')).toEqual([]);
    const frames = parser.push("}\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("item.delta");
    expect((frames[0]?.json as { seq: number }).seq).toBe(3);
  });

  it("handles CRLF and multi-line data", () => {
    const parser = new SseParser();
    const frames = parser.push("event: note\r\ndata: one\r\ndata: two\r\n\r\n");
    expect(frames[0]?.data).toBe("one\ntwo");
  });

  it("flags malformed JSON without throwing", () => {
    const parser = new SseParser();
    const frames = parser.push("event: item.delta\ndata: {nope\n\n");
    expect(frames[0]?.malformedJson).toBe(true);
    expect(frames[0]?.json).toBeNull();
  });

  it("rejects an unbounded frame", () => {
    const parser = new SseParser({ maxFrameBytes: 64 });
    expect(() => parser.push("x".repeat(65))).toThrow(/too_large/);
  });

  it("ignores comments and keeps the last event id", () => {
    const parser = new SseParser();
    parser.push(": keep-alive\nid: 42\ndata: ok\n\n");
    expect(parser.lastEventId).toBe("42");
  });
});

describe("UTF-8 stream decoding", () => {
  it("reassembles a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("café");
    const split = bytes.length - 1; // inside the two-byte é
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    let text = "";
    for await (const chunk of decodeBody(stream)) text += chunk;
    expect(text).toBe("café");
  });
});
