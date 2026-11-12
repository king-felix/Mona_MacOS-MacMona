/**
 * Incremental Server-Sent Events parser for the Runtime API. Pure and bounded:
 * a frame split across chunks waits for its blank line, and an unbounded frame
 * is rejected instead of growing memory forever.
 */
export interface SseFrame {
  event: string;
  id: string | null;
  data: string;
  json: unknown;
  malformedJson: boolean;
}

export class SseParser {
  private buffer = "";
  private readonly maxFrameBytes: number;
  lastEventId: string | null = null;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
  }

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      throw new Error("sse_frame_too_large");
    }
    const frames: SseFrame[] = [];
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

  tail(): string {
    return this.buffer;
  }
}

export function parseFrame(raw: string): SseFrame | null {
  const data: string[] = [];
  let event: string | null = null;
  let id: string | null = null;
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
  let json: unknown = null;
  let malformedJson = false;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      malformedJson = true;
    }
  }
  return {
    event:
      event ??
      (typeof (json as { event?: unknown })?.event === "string"
        ? (json as { event: string }).event
        : "message"),
    id,
    data: text,
    json,
    malformedJson,
  };
}
