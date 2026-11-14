#!/usr/bin/env node
// R06 evidence. Launch the real Electron shell against a temporary state store
// and a real project seeded with a stored transcript and two stored pending
// requests, then capture both themes in both decoration intensities plus the
// immersive layout and 200 % zoom.
//
// No engine is started and no model request is made: the transcript is stored
// history and the pending cards are stored rows.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const outDir = await mkdtemp(join(tmpdir(), "mona-aurora-smoke-"));
const outFile = join(outDir, "report.json");
const userDataDir = await mkdtemp(join(tmpdir(), "mona-aurora-smoke-userdata-"));
const artifactDir = join(ROOT, "docs", "evidence", "macos", "review-studio", "artifacts");

const child = spawn(electron, [".", "--aurora-smoke", `--user-data-dir=${userDataDir}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONA_AURORA_SMOKE_OUT: outFile,
    MONA_AURORA_SMOKE_OUT_DIR: artifactDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

// Four reloads (one per theme/intensity pair) plus a zoom pass: generous, but
// bounded.
const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
clearTimeout(timeout);

let report = null;
try {
  report = JSON.parse(await readFile(outFile, "utf8"));
} catch {
  report = { ok: false, error: "aurora smoke report missing" };
}

const output = {
  ...report,
  electron: {
    exit: code,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
  },
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "r06-aurora-smoke.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
await rm(outDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
process.exit(report.ok === true && code === 0 ? 0 : 1);
