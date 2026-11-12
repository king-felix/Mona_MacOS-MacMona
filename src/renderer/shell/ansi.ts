/**
 * A small, deliberately non-executing terminal transcript parser.
 *
 * It turns pty bytes into styled text spans. It is not a VT100 emulator: it
 * understands carriage return, newline, backspace, tab, SGR color/weight, and
 * it strips every other control sequence. That matters for security as much as
 * for scope — an OSC 8 hyperlink, an OSC 52 clipboard write, a device-control
 * query, or a cursor-addressing sequence has no path to the application. Links
 * appear as inert text; nothing here can call, open, or invoke anything.
 */

export type TranscriptTone = "plain" | "dim" | "bold" | "accent" | "error" | "success";

export interface TranscriptSpan {
  text: string;
  tone: TranscriptTone;
}

export interface TranscriptLine {
  spans: TranscriptSpan[];
}

export interface TranscriptStats {
  csi: number;
  osc: number;
  other: number;
  /** Lines dropped from the front to keep the view bounded. */
  droppedLines: number;
  /** A single line longer than the cap was cut, not silently kept. */
  truncatedLines: number;
}

const MAX_LINE_CHARS = 20_000;
const MAX_PENDING = 512;

interface Attributes {
  bold: boolean;
  dim: boolean;
  fg: TranscriptTone;
}

const PLAIN: Attributes = { bold: false, dim: false, fg: "plain" };

function toneOf(attrs: Attributes): TranscriptTone {
  if (attrs.fg !== "plain") return attrs.fg;
  if (attrs.bold) return "bold";
  if (attrs.dim) return "dim";
  return "plain";
}

function applySgr(attrs: Attributes, params: string): Attributes {
  const codes = params.length === 0 ? [0] : params.split(";").map((value) => Number(value || "0"));
  let next = { ...attrs };
  for (const code of codes) {
    if (code === 0) next = { ...PLAIN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 31 || code === 91) next.fg = "error";
    else if (code === 32 || code === 92) next.fg = "success";
    else if (code === 33 || code === 93) next.fg = "accent";
    else if (
      code === 34 ||
      code === 35 ||
      code === 36 ||
      code === 94 ||
      code === 95 ||
      code === 96
    ) {
      next.fg = "accent";
    } else if (code === 39) next.fg = "plain";
  }
  return next;
}

export class Transcript {
  private lines: TranscriptLine[] = [];
  private current: TranscriptSpan[] = [];
  private attrs: Attributes = { ...PLAIN };
  private carried = "";
  private readonly stats: TranscriptStats = {
    csi: 0,
    osc: 0,
    other: 0,
    droppedLines: 0,
    truncatedLines: 0,
  };

  constructor(private readonly options: { maxLines?: number } = {}) {}

  get maxLines(): number {
    return this.options.maxLines ?? 4_000;
  }

  write(chunk: string): void {
    const text = this.carried + chunk;
    this.carried = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\u001b") {
        const consumed = this.consumeEscape(text, index);
        if (consumed === -1) {
          // An escape sequence split across chunks: keep it for the next write.
          this.carried = text.slice(index);
          if (this.carried.length > MAX_PENDING) {
            this.carried = "";
            this.stats.other += 1;
          }
          break;
        }
        index += consumed;
        continue;
      }
      if (char === "\r") {
        if (text[index + 1] === "\n") {
          index += 1;
          continue;
        }
        // A bare CR rewrites the current line: progress bars and spinners.
        this.current = [];
        index += 1;
        continue;
      }
      if (char === "\n") {
        this.flushLine();
        index += 1;
        continue;
      }
      if (char === "\b") {
        this.backspace();
        index += 1;
        continue;
      }
      if (char === "\t") {
        this.append("  ");
        index += 1;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        this.stats.other += 1;
        index += 1;
        continue;
      }
      this.append(char);
      index += 1;
    }
    this.trim();
  }

  private append(text: string): void {
    const length = this.current.reduce((total, span) => total + span.text.length, 0);
    if (length >= MAX_LINE_CHARS) {
      this.stats.truncatedLines += 1;
      return;
    }
    const tone = toneOf(this.attrs);
    const last = this.current[this.current.length - 1];
    if (last && last.tone === tone) {
      last.text += text;
    } else {
      this.current.push({ text, tone });
    }
  }

  private backspace(): void {
    const last = this.current[this.current.length - 1];
    if (!last) return;
    last.text = last.text.slice(0, -1);
    if (last.text.length === 0) this.current.pop();
  }

  private flushLine(): void {
    this.lines.push({ spans: this.current });
    this.current = [];
  }

  private consumeEscape(text: string, start: number): number {
    const next = text[start + 1];
    if (next === undefined) return -1;
    if (next === "[") {
      let index = start + 2;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
          const params = text.slice(start + 2, index);
          if (text[index] === "m") this.attrs = applySgr(this.attrs, params);
          this.stats.csi += 1;
          return index - start + 1;
        }
        index += 1;
      }
      return -1;
    }
    if (next === "]") {
      let index = start + 2;
      while (index < text.length) {
        if (text[index] === "\u0007") {
          this.stats.osc += 1;
          return index - start + 1;
        }
        if (text[index] === "\u001b" && text[index + 1] === "\\") {
          this.stats.osc += 1;
          return index - start + 2;
        }
        index += 1;
      }
      return -1;
    }
    // Two-character escapes: charset selection, keypad mode, and the like.
    this.stats.other += 1;
    return 2;
  }

  private trim(): void {
    if (this.lines.length <= this.maxLines) return;
    const excess = this.lines.length - this.maxLines;
    this.lines.splice(0, excess);
    this.stats.droppedLines += excess;
  }

  /** True while a sequence is still incomplete between chunks. */
  pendingSequence(): boolean {
    return this.carried.length > 0;
  }

  render(): { lines: TranscriptLine[]; stats: TranscriptStats } {
    const lines = this.lines.map((line) => ({ spans: line.spans.map((span) => ({ ...span })) }));
    if (this.current.length > 0 || lines.length === 0) {
      lines.push({ spans: this.current.map((span) => ({ ...span })) });
    }
    return { lines, stats: { ...this.stats } };
  }

  /** Plain text of the retained transcript, for copy and local search. */
  text(): string {
    return this.render()
      .lines.map((line) => line.spans.map((span) => span.text).join(""))
      .join("\n");
  }

  clear(): void {
    this.lines = [];
    this.current = [];
    this.attrs = { ...PLAIN };
    this.carried = "";
    this.stats.droppedLines = 0;
    this.stats.truncatedLines = 0;
  }

  statsSnapshot(): TranscriptStats {
    return { ...this.stats };
  }

  /** Leftover partial sequence, exposed for tests and diagnostics. */
  pendingText(): string {
    return this.carried;
  }
}

/**
 * A local, inert display of an OSC 8 hyperlink or a bare URL.
 *
 * The renderer shows the target as text and never activates it. This helper
 * exists so tests can assert that a link's scheme is *classified*, not followed.
 */
export function classifyLinkTarget(target: string): "http" | "https" | "inert" {
  try {
    const url = new URL(target);
    if (url.protocol === "https:") return "https";
    if (url.protocol === "http:") return "http";
    return "inert";
  } catch {
    return "inert";
  }
}
