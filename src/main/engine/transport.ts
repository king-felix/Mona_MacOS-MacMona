export interface TransportResponse {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
}

export interface StreamResponse {
  status: number;
  chunks: AsyncIterable<string>;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra request headers; used for MCP `If-Match` preconditions. */
  headers?: Record<string, string>;
}

/**
 * The only network surface the adapter uses. A fixture implementation in tests
 * substitutes this without changing adapter logic.
 */
export interface RuntimeTransport {
  request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<TransportResponse>;
  stream(path: string, options?: { signal?: AbortSignal }): Promise<StreamResponse>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
}

export class HttpRuntimeTransport implements RuntimeTransport {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor({ baseUrl, token }: HttpTransportOptions) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
      throw new Error("runtime transport must target loopback 127.0.0.1");
    }
    if (!token) throw new Error("runtime token is required");
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<TransportResponse> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      text,
      json,
      headers: Object.fromEntries(response.headers),
    };
  }

  async stream(path: string, options: { signal?: AbortSignal } = {}): Promise<StreamResponse> {
    const response = await fetch(this.baseUrl + path, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
      signal: options.signal,
    });
    if (!response.body) return { status: response.status, chunks: emptyChunks() };
    return { status: response.status, chunks: decodeBody(response.body) };
  }
}

export async function* decodeBody(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of body) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const remainder = decoder.decode();
  if (remainder.length > 0) yield remainder;
}

async function* emptyChunks(): AsyncIterable<string> {
  return;
}
