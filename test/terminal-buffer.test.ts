import { describe, expect, it } from "vitest";
import { TerminalBuffer } from "../src/main/terminal/buffer";

function bufferOf(options: { maxBytes?: number; maxLines?: number }) {
  return new TerminalBuffer(options);
}

describe("TerminalBuffer", () => {
  it("keeps exact offsets and reports the evicted prefix", () => {
    const buffer = bufferOf({ maxBytes: 10, maxLines: 1_000 });
    buffer.append(Buffer.from("abcdef"));
    buffer.append(Buffer.from("ghijkl"));
    const read = buffer.read(0);
    expect(read.total).toBe(12);
    expect(read.dropped).toBe(2);
    expect(read.truncated).toBe(true);
    expect(read.offset).toBe(2);
    expect(read.data).toBe("cdefghijkl");
    expect(read.nextCursor).toBe(12);
  });

  it("reads from a cursor without consuming and clamps a cursor past the end", () => {
    const buffer = bufferOf({ maxBytes: 1_000, maxLines: 100 });
    buffer.append(Buffer.from("one\ntwo\nthree\n"));
    const first = buffer.read(0, 4);
    expect(first.data).toBe("one\n");
    expect(first.nextCursor).toBe(4);
    expect(buffer.read(4).data).toBe("two\nthree\n");
    expect(buffer.read(0).data).toBe(buffer.read(0).data);
    const past = buffer.read(9_999);
    expect(past.offset).toBe(buffer.total);
    expect(past.data).toBe("");
  });

  it("keeps the tail of a single write larger than the whole ring", () => {
    const buffer = bufferOf({ maxBytes: 8, maxLines: 1_000 });
    buffer.append(Buffer.from("0123456789ABCDEF"));
    const read = buffer.read(0);
    expect(read.data).toBe("89ABCDEF");
    expect(read.dropped).toBe(8);
    expect(read.truncated).toBe(true);
  });

  it("drops whole lines when the line budget is exceeded", () => {
    const buffer = bufferOf({ maxBytes: 10_000, maxLines: 3 });
    buffer.append(Buffer.from("a\nb\nc\nd\ne\n"));
    const read = buffer.read(0);
    expect(read.data).toBe("c\nd\ne\n");
    expect(read.dropped).toBe(4);
    expect(read.truncated).toBe(true);
  });

  it("searches the retained window case-insensitively with line numbers", () => {
    const buffer = bufferOf({ maxBytes: 10_000, maxLines: 100 });
    buffer.append(Buffer.from("first line\nERROR: disk\nthird error\n"));
    const result = buffer.search("error");
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]?.line).toBe(1);
    expect(result.matches[0]?.text).toBe("ERROR: disk");
    expect(result.matches[1]?.line).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("bounds search results and says the list was cut", () => {
    const buffer = bufferOf({ maxBytes: 10_000, maxLines: 100 });
    buffer.append(Buffer.from("hit\n".repeat(10)));
    const result = buffer.search("hit", 3);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("never returns a negative or fractional cursor offset", () => {
    const buffer = bufferOf({ maxBytes: 100, maxLines: 10 });
    buffer.append(Buffer.from("abc"));
    expect(buffer.read(-5).offset).toBe(0);
    expect(buffer.read(1.7).offset).toBe(1);
    expect(buffer.read(Number.NaN).offset).toBe(0);
  });
});
