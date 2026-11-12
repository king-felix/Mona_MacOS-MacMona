#!/usr/bin/env node
// P13 changes/Git/restore sample run. It exercises the compiled StateStore,
// ChangeLedger, GitService, and the adapter's error contract against a real
// temporary Git repository. The engine is a local fixture; no runtime starts
// and no provider call is made anywhere in this script.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { ChangeLedger } = require(join(ROOT, "dist/main/main/work/changes.js"));
const { GitService } = require(join(ROOT, "dist/main/main/work/git.js"));
const { AdapterError } = require(join(ROOT, "dist/main/main/engine/errors.js"));

const base = mkdtempSync(join(tmpdir(), "mona-p13-"));
const stateDir = join(base, "state");
const workspace = join(base, "workspace");
mkdirSync(workspace, { recursive: true });

let clock = Date.parse("2026-11-11T00:00:00.000Z");
let counter = 0;
const now = () => {
  clock += 1000;
  return new Date(clock);
};
const newId = (prefix) => {
  counter += 1;
  return `${prefix}_${counter.toString(16).padStart(8, "0")}`;
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

function git(args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "mona@example.test"]);
git(["config", "user.name", "Mona Smoke"]);
writeFileSync(join(workspace, "README.md"), "base\n", "utf8");
git(["add", "README.md"]);
git(["commit", "-qm", "base"]);

const store = await StateStore.open({
  dbPath: join(stateDir, "mona.sqlite"),
  backupDir: join(stateDir, "backups"),
  artifactRoot: join(stateDir, "artifacts"),
  now,
  newId,
});
const project = await store.createProject({ name: "P13 sample", rootPath: workspace });
const projectId = project.id;
const threadId = "thr_p13sample000001";
await store.upsertThread({
  id: threadId,
  projectId,
  engineThreadId: "thr_engine_p13_0001",
  title: "Changes",
});

function ref(overrides) {
  return {
    id: `file_${hash(overrides.path).slice(0, 32)}`,
    kind: "file",
    path: overrides.path,
    change: "updated",
    previousPath: null,
    sizeBytes: 10,
    revision: hash("recorded"),
    contentType: null,
    sessionId: null,
    itemId: "item_1",
    toolCallId: "call_1",
    toolName: "edit_file",
    source: "tool_mutation",
    restoreSnapshotId: "tree_pre_turn",
    recordedAt: now().toISOString(),
    ...overrides,
  };
}

const before = "before turn\n";
const after = "after turn\n";
writeFileSync(join(workspace, "src-app.ts"), after, "utf8");
writeFileSync(join(workspace, "notes.txt"), "notes\n", "utf8");

const artifactRefs = [
  ref({
    id: "file_app",
    path: "src-app.ts",
    revision: hash(after),
    sizeBytes: Buffer.byteLength(after),
    restoreSnapshotId: "tree_pre_turn",
  }),
  ref({
    id: "file_notes",
    path: "notes.txt",
    change: "created",
    source: "workspace_changed_during_turn",
    toolName: null,
    toolCallId: null,
    itemId: null,
    restoreSnapshotId: "tree_pre_turn",
  }),
  ref({
    id: "file_deleted",
    path: "deleted.txt",
    change: "deleted",
    revision: null,
    sizeBytes: null,
    restoreSnapshotId: "tree_pre_turn",
  }),
  ref({
    id: "art_spill",
    kind: "tool_output",
    path: "artifacts/out.txt",
    change: "unknown",
    source: "tool_output_spill",
    revision: null,
    restoreSnapshotId: null,
  }),
  ref({
    id: "file_image",
    path: "image.png",
    change: "created",
    sizeBytes: 20 * 1024 * 1024,
  }),
];

const engine = {
  async readTurnArtifacts({ turnId }) {
    if (turnId === "turn_missing") {
      throw new AdapterError("MALFORMED_RESPONSE", "route unavailable");
    }
    return {
      turnId,
      workspace: {
        state: "settled",
        reason: null,
        preSnapshotId: "tree_pre_turn",
        postSnapshotId: "tree_post_turn",
        truncated: false,
        omitted: null,
      },
      artifacts: artifactRefs,
    };
  },
  async readTurnArtifact({ artifactId }) {
    if (artifactId === "file_app") {
      return {
        artifactId,
        availability: "available",
        content: after,
        encoding: "utf-8",
        offset: 0,
        totalBytes: Buffer.byteLength(after),
        revision: hash(after),
        source: "workspace",
        current: true,
        truncated: false,
        note: null,
      };
    }
    return {
      artifactId,
      availability: "binary",
      content: null,
      encoding: "base64",
      offset: 0,
      totalBytes: 12,
      revision: null,
      source: "session_artifact",
      current: null,
      truncated: false,
      note: "binary content",
    };
  },
  async readCallChanges() {
    return {
      state: "captured",
      reason: null,
      files: [
        {
          path: "src-app.ts",
          change: "updated",
          added: 1,
          removed: 1,
          sizeBytes: Buffer.byteLength(after),
          revision: hash(after),
          restoreSnapshotId: "tree_pre_turn",
          diff: "@@ -1 +1 @@\n-before turn\n+after turn\n",
          diffTruncated: false,
        },
      ],
      truncated: false,
      note: null,
    };
  },
  async probeRestore() {
    return { fileRevert: true, snapshots: true, reason: null };
  },
  async listSnapshots() {
    return [{ id: "snap_1", label: "pre-turn:1", timestamp: 1780730580 }];
  },
  async revertFile({ path, snapshotId }) {
    if (path === "src-app.ts") writeFileSync(join(workspace, path), before, "utf8");
    return { path, action: "modified", snapshotId, snapshotLabel: "pre-turn:1" };
  },
  async readWorkspaceFile() {
    return {
      availability: "available",
      content: after,
      encoding: "utf-8",
      offset: 0,
      sizeBytes: Buffer.byteLength(after),
      revision: hash(after),
      truncated: false,
      note: null,
    };
  },
  async writeWorkspaceFile() {
    throw new AdapterError("WRITE_CONFLICT", "the file changed since it was read", false, {
      currentRevision: "9".repeat(64),
    });
  },
};

const ledger = new ChangeLedger({
  store,
  git: new GitService(),
  engine: () => ({ adapter: engine, workspace }),
});

await ledger.captureTurn({
  projectId,
  threadId,
  engineThreadId: "thr_engine_p13_0001",
  turnId: "turn_1",
  adapter: engine,
  payload: {},
});
await ledger.captureTurn({
  projectId,
  threadId,
  engineThreadId: "thr_engine_p13_0001",
  turnId: "turn_missing",
  adapter: engine,
  payload: { workspace: { state: "unavailable", reason: "snapshots_disabled" }, artifacts: [] },
});

const checks = {};

let snapshot = await ledger.snapshot(projectId);
const settled = snapshot.sets.find((set) => set.turnId === "turn_1");
const missing = snapshot.sets.find((set) => set.turnId === "turn_missing");
checks.settled_receipt = settled?.state === "settled";
checks.missing_delta_is_not_empty =
  missing?.state === "unavailable" &&
  missing.files.length === 0 &&
  /not an empty diff/i.test(snapshot.notes.join(" "));
checks.tool_attribution =
  settled?.files.find((file) => file.path === "src-app.ts")?.attribution === "tool";
checks.delta_attribution =
  settled?.files.find((file) => file.path === "notes.txt")?.attribution === "workspace_delta";
checks.artifact_attribution =
  settled?.files.find((file) => file.path === "artifacts/out.txt")?.attribution === "artifact";
checks.binary_and_large_marked =
  settled?.files.find((file) => file.path === "image.png")?.binaryHint === true &&
  settled?.files.find((file) => file.path === "image.png")?.oversized === true;
checks.deleted_file_kept =
  settled?.files.find((file) => file.path === "deleted.txt")?.change === "deleted";
checks.restore_available = snapshot.restore.available === true;

// Lazy text and per-call diff windows.
const text = await ledger.fileWindow({
  projectId,
  changeSetId: settled.id,
  path: "src-app.ts",
  mode: "text",
});
const diff = await ledger.fileWindow({
  projectId,
  changeSetId: settled.id,
  path: "src-app.ts",
  mode: "diff",
});
checks.text_window = text.availability === "available" && text.content === after;
checks.diff_window = diff.availability === "available" && diff.diff.includes("+after turn");

// A later edit is a conflict; restoring needs an explicit acknowledgement.
writeFileSync(join(workspace, "src-app.ts"), "later user edit\n", "utf8");
const conflictPreview = await ledger.restorePreview({
  projectId,
  changeSetId: settled.id,
  paths: ["src-app.ts"],
});
checks.later_edit_is_conflict =
  conflictPreview.conflicts.some((entry) => entry.kind === "changed_after_turn") &&
  conflictPreview.requiresAcknowledgement.includes("src-app.ts");
let refusedWithoutAck = null;
try {
  await ledger.restore({
    projectId,
    changeSetId: settled.id,
    paths: ["src-app.ts"],
    expected: conflictPreview.scope.map((entry) => ({
      path: entry.path,
      expectedHash: entry.expectedHash,
    })),
    acknowledge: [],
  });
} catch (error) {
  refusedWithoutAck = error.code;
}
checks.conflict_refused = refusedWithoutAck === "RESTORE_CONFLICT";

const acknowledged = await ledger.restorePreview({
  projectId,
  changeSetId: settled.id,
  paths: ["src-app.ts"],
});
const restored = await ledger.restore({
  projectId,
  changeSetId: settled.id,
  paths: ["src-app.ts"],
  expected: acknowledged.scope.map((entry) => ({
    path: entry.path,
    expectedHash: entry.expectedHash,
  })),
  acknowledge: ["src-app.ts"],
});
checks.restore_through_engine = restored.ok && restored.restored.length === 1;
checks.restored_bytes = readFileSync(join(workspace, "src-app.ts"), "utf8") === before;
const restoreReceipts = await store.listRestoreReceipts(projectId);
checks.restore_receipt_written =
  restoreReceipts.length === 1 && restoreReceipts[0].outcome === "restored";

// A stale preview is refused rather than overwriting the newest bytes.
const stalePreview = await ledger.restorePreview({
  projectId,
  changeSetId: settled.id,
  paths: ["src-app.ts"],
});
writeFileSync(join(workspace, "src-app.ts"), "third edit\n", "utf8");
let staleCode = null;
try {
  await ledger.restore({
    projectId,
    changeSetId: settled.id,
    paths: ["src-app.ts"],
    expected: stalePreview.scope.map((entry) => ({
      path: entry.path,
      expectedHash: entry.expectedHash,
    })),
    acknowledge: ["src-app.ts"],
  });
} catch (error) {
  staleCode = error.code;
}
checks.stale_preview_refused = staleCode === "STALE_PREVIEW";
checks.stale_preview_did_not_overwrite =
  readFileSync(join(workspace, "src-app.ts"), "utf8") === "third edit\n";

// Unsupported scope is explained, not silently dropped.
const unsupported = await ledger.restorePreview({
  projectId,
  changeSetId: settled.id,
  paths: ["artifacts/out.txt", "deleted.txt"],
});
checks.artifact_not_restorable = unsupported.exclusions.some(
  (entry) => entry.path === "artifacts/out.txt" && entry.reason === "not_a_workspace_file",
);

// Selected staging and commit leave unrelated staged work alone.
writeFileSync(join(workspace, "unrelated-staged.txt"), "pre-existing staged\n", "utf8");
git(["add", "unrelated-staged.txt"]);
writeFileSync(join(workspace, "selected.txt"), "selected\n", "utf8");
writeFileSync(join(workspace, "untracked.txt"), "untracked\n", "utf8");
const commit = await ledger.commitPaths({
  projectId,
  message: "selected only",
  paths: ["selected.txt"],
});
const committedPaths = git(["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
const afterCommit = await ledger.snapshot(projectId);
checks.selected_commit_only = commit.ok && committedPaths.join(",") === "selected.txt";
checks.unrelated_staged_preserved = afterCommit.git.entries.some(
  (entry) => entry.path === "unrelated-staged.txt" && entry.staged,
);
checks.unreceipted_is_not_agent_authored = afterCommit.git.entries.some(
  (entry) => entry.path === "untracked.txt" && entry.attribution === "unreceipted",
);
checks.commit_receipt_written = afterCommit.lastCommit?.shortHash === commit.commit?.shortCommit;

// Mixed staged + unstaged content needs an explicit choice.
writeFileSync(join(workspace, "mixed.txt"), "v1\n", "utf8");
await ledger.stagePaths({ projectId, paths: ["mixed.txt"] });
writeFileSync(join(workspace, "mixed.txt"), "v2\n", "utf8");
let mixedCode = null;
try {
  await ledger.commitPaths({ projectId, message: "mixed", paths: ["mixed.txt"] });
} catch (error) {
  mixedCode = error.code;
}
checks.mixed_commit_refused = mixedCode === "COMMIT_REFUSED";
const forced = await ledger.commitPaths({
  projectId,
  message: "mixed",
  paths: ["mixed.txt"],
  includeUnstaged: true,
});
checks.explicit_mixed_commit = forced.ok === true;

// The checked write path reports a revision conflict without overwriting.
let writeCode = null;
try {
  await ledger.writeFile({
    projectId,
    path: "src-app.ts",
    content: "draft\n",
    expectedRevision: "a".repeat(64),
  });
} catch (error) {
  writeCode = error.code;
}
checks.editor_conflict = writeCode === "WRITE_CONFLICT";

// A folder without Git is reported honestly and never initialized.
const plainDir = join(base, "plain");
mkdirSync(plainDir, { recursive: true });
const plain = await store.createProject({ name: "Plain", rootPath: plainDir });
const plainSnapshot = await ledger.snapshot(plain.id);
let plainGitCode = null;
try {
  await ledger.stagePaths({ projectId: plain.id, paths: ["README.md"] });
} catch (error) {
  plainGitCode = error.code;
}
checks.non_git_reported =
  plainSnapshot.git.available === false && Boolean(plainSnapshot.git.reason);
checks.non_git_stage_refused = plainGitCode === "GIT_UNAVAILABLE";

const ok = Object.values(checks).every(Boolean);
const redact = (value) =>
  value
    .split(base)
    .join("<tmp>")
    .split(process.env.HOME ?? "")
    .join("~");

console.log(`P13 changes sample: ${ok ? "PASS" : "FAIL"}`);
for (const [name, value] of Object.entries(checks)) {
  console.log(`  ${value ? "ok  " : "FAIL"} ${name}`);
}

console.log(
  JSON.stringify(
    {
      schema_version: 1,
      prompt: "P13",
      ok,
      checks,
      detail: {
        receipts: snapshot.sets.map((set) => ({
          turn: set.turnId,
          state: set.state,
          files: set.files.length,
          notes: set.note,
        })),
        git: {
          branch: afterCommit.git.branch,
          worktree: afterCommit.git.worktree,
          counts: afterCommit.git.counts,
          head: afterCommit.git.head?.shortCommit ?? null,
        },
        restore_receipts: restoreReceipts.length,
        recovery: acknowledged.recovery,
      },
      database: redact(join(stateDir, "mona.sqlite")),
    },
    null,
    2,
  ),
);

await store.close();
rmSync(base, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
