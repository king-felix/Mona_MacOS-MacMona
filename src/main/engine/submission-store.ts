import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationKey, SubmissionState } from "../../shared/contracts";

/**
 * Submission intent is persisted before transmission. P03 uses a small atomic
 * JSON store; P05 replaces the storage mechanism with the product database, but
 * the ordering contract stays the same.
 */
export interface SubmissionStore {
  put(state: SubmissionState): Promise<void>;
  get(operationKey: OperationKey): Promise<SubmissionState | null>;
}

export class MemorySubmissionStore implements SubmissionStore {
  private readonly records = new Map<string, SubmissionState>();

  async put(state: SubmissionState): Promise<void> {
    this.records.set(state.operationKey, structuredClone(state));
  }

  async get(operationKey: OperationKey): Promise<SubmissionState | null> {
    const value = this.records.get(operationKey);
    return value ? structuredClone(value) : null;
  }
}

/** One file per operation key, written with temp+rename so a crash cannot leave half a record. */
export class FileSubmissionStore implements SubmissionStore {
  constructor(private readonly dir: string) {}

  private pathFor(operationKey: string): string {
    return join(this.dir, `${encodeURIComponent(operationKey)}.json`);
  }

  async put(state: SubmissionState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.pathFor(state.operationKey);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(temp, target);
  }

  async get(operationKey: OperationKey): Promise<SubmissionState | null> {
    try {
      const text = await readFile(this.pathFor(operationKey), "utf8");
      return JSON.parse(text) as SubmissionState;
    } catch {
      return null;
    }
  }
}
