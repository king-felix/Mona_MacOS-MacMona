import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executableDigest,
  newRecordId,
  OwnershipStore,
  type OwnershipRecord,
} from "../src/main/supervisor/records";

function record(overrides: Partial<OwnershipRecord> = {}): OwnershipRecord {
  const now = new Date().toISOString();
  return {
    id: newRecordId(),
    workspace: "/tmp/work",
    canonicalWorkspace: "/private/tmp/work",
    executable: "/opt/homebrew/bin/codewhale",
    executableSha256: "b".repeat(64),
    supervisorPid: 1000,
    supervisorStartedAt: "Wed Nov 11 18:00:00 2026",
    childPid: 1001,
    childStartedAt: "Wed Nov 11 18:00:01 2026",
    pgid: 1001,
    port: 7001,
    baseUrl: "http://127.0.0.1:7001",
    controlSocket: "/tmp/run/rt.sock",
    startedAt: now,
    updatedAt: now,
    state: "running",
    engine: { version: "0.10.2", commit: "ff466b2ed0bf" },
    startupReceipt: null,
    stopReceipt: null,
    ...overrides,
  };
}

describe("ownership records", () => {
  it("round-trips records with an incrementing revision and owner-only mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-records-"));
    const store = new OwnershipStore(join(dir, "runtime-ownership.json"));
    const first = store.put(record());
    expect(store.read().revision).toBe(1);
    store.put(record({ state: "stopped" }));
    expect(store.read().revision).toBe(2);
    expect(store.get(first.id)?.id).toBe(first.id);
    const mode = statSync(store.path()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never persists a bearer token", () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-records-"));
    const store = new OwnershipStore(join(dir, "runtime-ownership.json"));
    const token = "deadbeef".repeat(6);
    const saved = store.put(record());
    const text = readFileSync(store.path(), "utf8");
    expect(text).not.toContain(token);
    expect(Object.keys(saved)).not.toContain("token");
  });

  it("treats only starting/running records as live for a workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-records-"));
    const store = new OwnershipStore(join(dir, "runtime-ownership.json"));
    store.put(record({ canonicalWorkspace: "/private/tmp/a", state: "stopped" }));
    expect(store.forWorkspace("/private/tmp/a")).toBeNull();
    const live = store.put(record({ canonicalWorkspace: "/private/tmp/b", state: "running" }));
    expect(store.forWorkspace("/private/tmp/b")?.id).toBe(live.id);
    expect(store.live()).toHaveLength(1);
  });

  it("preserves an unreadable file instead of silently discarding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-records-"));
    const path = join(dir, "runtime-ownership.json");
    writeFileSync(path, "{not json", "utf8");
    const store = new OwnershipStore(path);
    const snapshot = store.read();
    expect(snapshot.records).toHaveLength(0);
    expect(snapshot.corruptionBackup).toContain(".corrupt-");
    expect(readFileSync(snapshot.corruptionBackup as string, "utf8")).toBe("{not json");
  });

  it("prunes old stopped records but keeps live and recent ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-records-"));
    const store = new OwnershipStore(join(dir, "runtime-ownership.json"));
    const now = Date.now();
    store.put(record({ state: "stopped", updatedAt: new Date(now - 48 * 3600_000).toISOString() }));
    store.put(record({ state: "stopped", updatedAt: new Date(now - 1_000).toISOString() }));
    store.put(record({ state: "running", updatedAt: new Date(now - 48 * 3600_000).toISOString() }));
    expect(store.pruneStopped(24 * 3600_000, now)).toBe(1);
    expect(store.list()).toHaveLength(2);
  });

  it("hashes the exact executable bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mona-records-"));
    const file = join(dir, "binary");
    writeFileSync(file, "mona");
    expect(executableDigest(file)).toBe(createHash("sha256").update("mona").digest("hex"));
    expect(executableDigest(file)).toMatch(/^[0-9a-f]{64}$/);
  });
});
