import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function promptIds() {
  return Array.from({ length: 28 }, (_, index) => `P${String(index).padStart(2, "0")}`);
}

export function makeState(overrides = {}) {
  const tasks = {};
  for (const id of promptIds()) {
    tasks[id] = {
      status: "pending",
      requirements: ["MONA-001"],
      completed_steps: [],
      remaining_steps: [],
      evidence: [],
      blocker_ids: [],
    };
  }
  return {
    schema_version: 1,
    revision: 1,
    project: "Mona",
    spec_version: "macOS-1.0",
    platform: "darwin-arm64",
    spec_sha256: "a".repeat(64),
    prompt_file_sha256: "b".repeat(64),
    current_prompt: "P00",
    current_prompt_status: "running",
    last_verified_commit: null,
    tasks,
    next_eligible_prompts: ["P00"],
    last_checkpoint_utc: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

export function tempDir(prefix = "monabuild-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeState(dir, state = makeState()) {
  const path = join(dir, ".mona", "build-macos", "state.json");
  mkdirSync(join(dir, ".mona", "build-macos"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

export function stateFile(state = makeState()) {
  const dir = tempDir();
  return { dir, path: writeState(dir, state), state };
}
