import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

/**
 * Process identity helpers for the macOS supervisor. Identity is
 * `(pid, start time)`: a pid alone is not an identity because the OS reuses it.
 */

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
}

export interface RecordedIdentity {
  pid: number;
  startedAt: string;
}

const TABLE_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;

export function parseProcessTable(raw: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of raw.split("\n")) {
    const match = TABLE_ROW.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const startedAt = (match[4] ?? "").trim();
    if (!Number.isInteger(pid) || pid <= 0 || !startedAt) continue;
    table.set(pid, { pid, ppid, pgid, startedAt });
  }
  return table;
}

export function readProcessTable(): Map<number, ProcessEntry> {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8" });
  return parseProcessTable(result.stdout ?? "");
}

export function readProcessEntry(pid: number): ProcessEntry | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "pid=,ppid=,pgid=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return parseProcessTable(result.stdout ?? "").get(pid) ?? null;
}

/** Executable path of a live process, or null if it is gone. */
export function readExecutablePath(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
  const text = (result.stdout ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * True only when a live process still has both the recorded pid and the
 * recorded start time. A mismatch means the pid was reused and is a stranger.
 */
export function isSameProcess(identity: RecordedIdentity, entry = readProcessEntry(identity.pid)) {
  return entry !== null && entry.pid === identity.pid && entry.startedAt === identity.startedAt;
}

export function descendantsOf(root: number, table = readProcessTable()): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/** Pids listening on a loopback TCP port, via lsof (no HTTP probe). */
export function listeningPids(port: number): number[] {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    encoding: "utf8",
  });
  return [
    ...new Set(
      (result.stdout ?? "")
        .split("\n")
        .filter((line) => line.startsWith("p"))
        .map((line) => Number(line.slice(1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

export interface PortAvailability {
  free: boolean;
  listeners: number[];
  reason: "free" | "in_use" | "permission_denied" | "unavailable";
}

/**
 * Bind the exact port before the engine does. This turns a likely race and an
 * occupied port into an actionable state instead of a mystery startup timeout.
 */
export function probePort(port: number, host = "127.0.0.1"): Promise<PortAvailability> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      const listeners = error.code === "EADDRINUSE" ? listeningPids(port) : [];
      resolve({
        free: false,
        listeners,
        reason:
          error.code === "EADDRINUSE"
            ? "in_use"
            : error.code === "EACCES"
              ? "permission_denied"
              : "unavailable",
      });
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve({ free: true, listeners: [], reason: "free" }));
    });
  });
}
