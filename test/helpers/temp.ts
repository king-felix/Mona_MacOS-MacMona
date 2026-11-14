import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * A temporary directory owned by one test file.
 *
 * The suites create real SQLite stores, workspaces and supervisor records, and
 * for a long time nothing removed them: ninety-four thousand `mona-*` trees
 * (33 GB) accumulated in the host's temp directory until the boot volume ran
 * out of space mid-run. A leaked tree is not a passing test's problem, so the
 * directory registers itself here and is removed when the file's tests finish.
 *
 * Removal happens once per file, not per test: several suites take both a store
 * directory and a workspace inside it, and a per-test sweep would delete a
 * fixture that a later test in the same file still needs.
 */
const created = new Set<string>();

function sweep(): void {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file still held open by a closing handle is the OS's to reclaim at
      // process exit; failing a green test over cleanup would be worse.
    }
  }
  created.clear();
}

afterAll(sweep);

export function tempDir(prefix = "mona-state-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}
