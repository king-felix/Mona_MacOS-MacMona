#!/usr/bin/env node
// R05 evidence. Launch the real Electron shell against a temporary state store
// and a real project, then enter Focus Studio and native full screen the way a
// person does: the Focus control, the keyboard, and AppKit's own transition.
// The runner records what the window reported, what the renderer received, the
// measured layout, and four screenshots. No engine is started and no model
// request is made anywhere in this script or the app run it launches.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const outDir = await mkdtemp(join(tmpdir(), "mona-immersive-smoke-"));
const outFile = join(outDir, "report.json");
const userDataDir = await mkdtemp(join(tmpdir(), "mona-immersive-smoke-userdata-"));

// macOS refuses a full-screen transition while the console session is locked,
// and no app can take focus then. Recorded here so a failing full-screen check
// can be told apart from a broken product: the check still fails, the report
// says why.
function screenLocked() {
  try {
    const out = spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-a"], {
      encoding: "utf8",
    }).stdout;
    return out.includes("<key>CGSSessionScreenIsLocked</key>") && out.includes("<true/>");
  } catch {
    return null;
  }
}

const child = spawn(electron, [".", "--immersive-smoke", `--user-data-dir=${userDataDir}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONA_IMMERSIVE_SMOKE_OUT: outFile,
    MONA_IMMERSIVE_SMOKE_OUT_DIR: join(
      ROOT,
      "docs",
      "evidence",
      "macos",
      "review-studio",
      "artifacts",
    ),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

// A native full-screen transition waits on AppKit's Space animation, so this
// budget is larger than the other smokes'.
const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
clearTimeout(timeout);

let report = null;
try {
  report = JSON.parse(await readFile(outFile, "utf8"));
} catch {
  report = { ok: false, error: "immersive smoke report missing" };
}

const output = {
  ...report,
  gui_session: {
    screen_locked: screenLocked(),
    note: "A locked console session refuses full-screen transitions; the full-screen checks are then unverifiable, not passing.",
  },
  electron: {
    exit: code,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
  },
};
// The report is a run record: keep it beside the screenshots so the evidence
// document can cite exact bytes instead of a pasted console.
const artifactDir = join(ROOT, "docs", "evidence", "macos", "review-studio", "artifacts");
await mkdir(artifactDir, { recursive: true });
await writeFile(
  join(artifactDir, "r05-immersive-smoke.json"),
  JSON.stringify(output, null, 2) + "\n",
);
console.log(JSON.stringify(output, null, 2));
await rm(outDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
process.exit(report.ok === true && code === 0 ? 0 : 1);
