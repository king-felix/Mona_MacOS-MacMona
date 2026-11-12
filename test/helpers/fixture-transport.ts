import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RequestOptions,
  RuntimeTransport,
  StreamResponse,
  TransportResponse,
} from "../../src/main/engine/transport";

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export type RequestHandler = (
  method: string,
  path: string,
  body: unknown,
) => TransportResponse | Promise<TransportResponse>;

export class FixtureTransport implements RuntimeTransport {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly handler: RequestHandler,
    private readonly streamHandler?: (path: string) => AsyncIterable<string>,
  ) {}

  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    _options?: RequestOptions,
  ): Promise<TransportResponse> {
    this.calls.push({ method, path, body });
    return this.handler(method, path, body);
  }

  async stream(path: string): Promise<StreamResponse> {
    if (!this.streamHandler) throw new Error(`no stream fixture for ${path}`);
    return { status: 200, chunks: this.streamHandler(path) };
  }

  count(method: string, pathIncludes: string): number {
    return this.calls.filter((call) => call.method === method && call.path.includes(pathIncludes))
      .length;
  }
}

export function jsonResponse(status: number, value: unknown): TransportResponse {
  const text = value === undefined ? "" : JSON.stringify(value);
  return { status, text, json: value ?? null, headers: {} };
}

export function sseFrames(events: unknown[], { end = false } = {}): string {
  const blocks = events.map(
    (event, index) =>
      `id: ${(event as { seq?: number }).seq ?? index}\nevent: ${
        (event as { event?: string }).event ?? "message"
      }\ndata: ${JSON.stringify(event)}\n\n`,
  );
  if (end) {
    blocks.push(
      `event: stream.end\ndata: ${JSON.stringify({
        schema_version: 1,
        event: "stream.end",
        kind: "stream.end",
        reason: "replay_complete",
        last_seq: events.length,
      })}\n\n`,
    );
  }
  return blocks.join("");
}

export async function* chunkText(text: string, size = 7): AsyncIterable<string> {
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size);
  }
}

const FIXTURE_DIR = join(new URL(".", import.meta.url).pathname, "../fixtures/engine");

export async function fixture<T = unknown>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURE_DIR, name), "utf8")) as T;
}

/** Mutate a loaded fixture without touching the file. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
