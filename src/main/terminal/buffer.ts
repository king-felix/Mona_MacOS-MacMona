import { TERMINAL_LIMITS } from "../../shared/contracts/terminal";

/**
 * Bounded, byte-exact replay buffer for one terminal session.
 *
 * The buffer never rewrites history: it only evicts from the front, so
 * `dropped` is exactly the offset of the first retained byte. A reader asking
 * for an evicted cursor is told it was truncated instead of being handed a
 * silently different transcript.
 */
export interface BufferRead {
  offset: number;
  data: string;
  nextCursor: number;
  total: number;
  dropped: number;
  truncated: boolean;
}

interface Chunk {
  offset: number;
  bytes: Buffer;
}

const NEWLINE = 0x0a;

function countNewlines(bytes: Buffer, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) if (bytes[index] === NEWLINE) count += 1;
  return count;
}

export class TerminalBuffer {
  private chunks: Chunk[] = [];
  private retainedBytes = 0;
  /** Offset of the first retained byte; also the count of evicted bytes. */
  private startOffset = 0;
  private totalBytes = 0;
  private newlineCount = 0;

  constructor(private readonly options: { maxBytes?: number; maxLines?: number } = {}) {}

  get maxBytes(): number {
    return this.options.maxBytes ?? TERMINAL_LIMITS.replayBytes;
  }

  get maxLines(): number {
    return this.options.maxLines ?? TERMINAL_LIMITS.replayLines;
  }

  append(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.totalBytes += bytes.length;
    this.newlineCount += countNewlines(bytes, 0, bytes.length);
    if (bytes.length >= this.maxBytes) {
      // One write larger than the whole ring: keep its tail and account for
      // everything that can never be read.
      const tail = bytes.subarray(bytes.length - this.maxBytes);
      this.startOffset = this.totalBytes - tail.length;
      this.chunks = [{ offset: this.startOffset, bytes: Buffer.from(tail) }];
      this.retainedBytes = tail.length;
      return;
    }
    this.chunks.push({ offset: this.totalBytes - bytes.length, bytes: Buffer.from(bytes) });
    this.retainedBytes += bytes.length;
    this.evictBytes();
    this.evictLines();
  }

  private evictBytes(): void {
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.retainedBytes - this.maxBytes;
      if (first.bytes.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.bytes.length;
        this.newlineCount -= countNewlines(first.bytes, 0, first.bytes.length);
        this.startOffset = first.offset + first.bytes.length;
      } else {
        const keep = first.bytes.subarray(excess);
        const droppedLines = countNewlines(first.bytes, 0, excess);
        this.chunks[0] = { offset: first.offset + excess, bytes: Buffer.from(keep) };
        this.retainedBytes -= excess;
        this.newlineCount -= droppedLines;
        this.startOffset = first.offset + excess;
      }
    }
  }

  private evictLines(): void {
    if (this.newlineCount <= this.maxLines) return;
    let toDrop = this.newlineCount - this.maxLines;
    // Evict whole lines from the front until the retained window fits.
    while (toDrop > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const newlineAt = first.bytes.indexOf(NEWLINE);
      if (newlineAt === -1) {
        // The whole chunk is one partial line: drop it and keep counting.
        this.chunks.shift();
        this.retainedBytes -= first.bytes.length;
        this.startOffset = first.offset + first.bytes.length;
        continue;
      }
      const cut = newlineAt + 1;
      if (cut >= first.bytes.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = {
          offset: first.offset + cut,
          bytes: Buffer.from(first.bytes.subarray(cut)),
        };
      }
      this.retainedBytes -= cut;
      this.newlineCount -= 1;
      this.startOffset = first.offset + cut;
      toDrop -= 1;
    }
  }

  get total(): number {
    return this.totalBytes;
  }

  get dropped(): number {
    return this.startOffset;
  }

  get retained(): number {
    return this.retainedBytes;
  }

  read(cursor: number, maxBytes = this.maxBytes): BufferRead {
    const requested = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
    const truncated = requested < this.startOffset;
    let from = truncated ? this.startOffset : requested;
    if (from > this.totalBytes) from = this.totalBytes;
    const until = Math.min(from + maxBytes, this.totalBytes);
    const parts: Buffer[] = [];
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.offset + chunk.bytes.length;
      if (chunkEnd <= from) continue;
      if (chunk.offset >= until) break;
      const begin = Math.max(0, from - chunk.offset);
      const end = Math.min(chunk.bytes.length, until - chunk.offset);
      if (end > begin) parts.push(chunk.bytes.subarray(begin, end));
    }
    const data = Buffer.concat(parts).toString("utf8");
    return {
      offset: from,
      data,
      nextCursor: until,
      total: this.totalBytes,
      dropped: this.startOffset,
      truncated,
    };
  }

  text(): string {
    return this.read(this.startOffset, this.maxBytes).data;
  }

  /** Case-insensitive literal search over the retained window. */
  search(
    query: string,
    limit: number = TERMINAL_LIMITS.searchMatches,
  ): { matches: Array<{ index: number; line: number; text: string }>; truncated: boolean } {
    const needle = query.toLowerCase();
    const haystack = this.text();
    const matches: Array<{ index: number; line: number; text: string }> = [];
    if (needle.length === 0) return { matches, truncated: false };
    const lines = haystack.split("\n");
    let index = 0;
    let truncated = false;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber]!;
      const at = line.toLowerCase().indexOf(needle);
      if (at !== -1) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({
          index: index + at,
          line: lineNumber,
          // Bound the line shown: a match in a 4 MB single line cannot be
          // handed to the renderer whole.
          text: line.length > 400 ? `${line.slice(Math.max(0, at - 120), at + 280)}` : line,
        });
      }
      index += line.length + 1;
    }
    return { matches, truncated };
  }
}
