import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StateStore, type StateStoreOptions } from "../../src/main/state/store";

export interface TestStoreHandle {
  dir: string;
  dbPath: string;
  store: StateStore;
}

export function tempDir(prefix = "mona-state-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeClock(
  start = "2026-11-11T00:00:00.000Z",
  stepMs = 1_000,
): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse(start);
  return {
    now: () => {
      current += stepMs;
      return new Date(current);
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export function makeIds(): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}_${counter.toString(16).padStart(8, "0")}`;
  };
}

export async function openTestStore(
  overrides: Partial<StateStoreOptions> & { dir?: string } = {},
): Promise<TestStoreHandle> {
  const dir = overrides.dir ?? tempDir();
  const dbPath = overrides.dbPath ?? join(dir, "state", "mona.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const clock = makeClock();
  const store = await StateStore.open({
    dbPath,
    artifactRoot: join(dir, "artifacts"),
    backupDir: join(dir, "backups"),
    now: clock.now,
    newId: makeIds(),
    ...overrides,
  });
  return { dir, dbPath, store };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
