import test from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../lib/sse.mjs";

test("parses a complete frame with id, event and JSON data", () => {
  const parser = new SseParser();
  const frames = parser.push('id: 12\nevent: item.delta\ndata: {"seq":12,"event":"item.delta"}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, "12");
  assert.equal(frames[0].event, "item.delta");
  assert.equal(frames[0].json.seq, 12);
});

test("holds a partial frame until the blank line arrives", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: {\"a\":1}"), []);
  assert.deepEqual(parser.push("\n"), []);
  const frames = parser.push("\n");
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].json, { a: 1 });
});

test("handles CRLF frame boundaries", () => {
  const parser = new SseParser();
  const frames = parser.push("event: turn.completed\r\ndata: {\"x\":true}\r\n\r\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "turn.completed");
});

test("joins multi-line data with newlines", () => {
  const parser = new SseParser();
  const frames = parser.push("data: line one\ndata: line two\n\n");
  assert.equal(frames[0].data, "line one\nline two");
});

test("ignores comments and unknown fields", () => {
  const parser = new SseParser();
  const frames = parser.push(": keep-alive\nretry: 5000\nevent: ping\ndata: ok\n\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "ping");
  assert.equal(frames[0].json, null);
});

test("two frames in one chunk are both delivered", () => {
  const parser = new SseParser();
  const frames = parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  assert.deepEqual(frames.map((f) => f.event), ["a", "b"]);
});

test("rejects an unbounded frame instead of buffering forever", () => {
  const parser = new SseParser({ maxBufferBytes: 64 });
  assert.throws(() => parser.push("x".repeat(65)), /sse_frame_too_large/);
});
