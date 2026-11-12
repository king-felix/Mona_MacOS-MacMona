// Bounded Server-Sent Events parser for the Codewhale Runtime API.
// Pure, so UTF-8 chunk boundaries and partial frames can be unit-tested.

/**
 * Incremental SSE parser. Feed it decoded text chunks; it returns complete
 * event frames. A frame is only emitted at a blank line, so an event split
 * across network chunks is never delivered early.
 */
export class SseParser {
  constructor({ maxBufferBytes = 8 * 1024 * 1024 } = {}) {
    this.buffer = "";
    this.maxBufferBytes = maxBufferBytes;
    this.lastEventId = null;
    this.bytes = 0;
  }

  /** @param {string} chunk decoded text (may end mid-frame or mid-character) */
  push(chunk) {
    if (typeof chunk !== "string") throw new TypeError("chunk must be text");
    this.bytes += Buffer.byteLength(chunk, "utf8");
    if (Buffer.byteLength(this.buffer + chunk, "utf8") > this.maxBufferBytes) {
      throw new Error("sse_frame_too_large");
    }
    this.buffer += chunk;
    const frames = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = parseFrame(raw);
      if (frame) {
        if (frame.id !== null) this.lastEventId = frame.id;
        frames.push(frame);
      }
    }
    return frames;
  }

  /** Remaining unterminated bytes (for diagnostics, never treated as an event). */
  tail() {
    return this.buffer;
  }
}

function parseFrame(raw) {
  const data = [];
  let event = null;
  let id = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length === 0 && event === null) return null;
  const text = data.join("\n");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { event: event ?? (json && json.event) ?? "message", id, data: text, json };
}
